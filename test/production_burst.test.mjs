// Safe release-load coverage. This uses synthetic members and the migrated
// in-memory database. Promise.all starts each burst together, but PGlite owns
// one embedded database connection and serializes execution internally. It
// therefore measures hot-path SQL throughput and retry/idempotency behavior,
// not Supabase network latency or multi-connection lock scheduling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { freshDb } from './helpers/db.mjs';
import { YEAR_2026, USERS } from './helpers/fixture.mjs';

const USERS_EXPECTED = 180;
const EVENT = '22222222-0000-4000-a000-000000000180';

const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
};

test('180-member burst, retries and same-member collisions preserve exactly-once credit', async (t) => {
  const db = await freshDb();
  try {
    await db.exec(`
      insert into auth.users (id, email)
      values ('${USERS.officer}', 'officers@pdsaucf.com')
      on conflict (id) do nothing;

      insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                          checkin_opens_at, checkin_closes_at)
      values ('${EVENT}', '${YEAR_2026}', 'Synthetic Production Burst', current_date,
              'tok-production-burst', now() - interval '5 minutes', now() + interval '30 minutes');

      insert into event_categories (event_id, category_id, credit_mode, fixed_credit) values
        ('${EVENT}', 'c0000000-0000-4000-a000-000000000001', 'fixed', 1),
        ('${EVENT}', 'c0000000-0000-4000-a000-000000000005', 'fixed', 2);

      insert into members (first_name, last_name)
      select 'Loadmember', 'Synthetic' || lpad(g::text, 3, '0')
      from generate_series(1, ${USERS_EXPECTED}) g;

      insert into member_enrollments (member_id, academic_year_id)
      select id, '${YEAR_2026}' from members where first_name = 'Loadmember';
    `);

    const members = await db.q(
      `select id from members where first_name = 'Loadmember' order by display_name`,
    );
    assert.equal(members.length, USERS_EXPECTED);

    await db.as('anon');
    const contexts = await Promise.all(
      members.map(() => db.val(`select get_checkin_context('tok-production-burst')`)),
    );

    const latencies = [];
    const started = performance.now();
    const results = await Promise.allSettled(
      members.map(async (member, index) => {
        const began = performance.now();
        const result = await db.val(
          `select submit_checkin('tok-production-burst', $1, null, null, null, '[]'::jsonb, $2)`,
          [member.id, contexts[index].client_nonce],
        );
        latencies.push(performance.now() - began);
        return result;
      }),
    );
    const burstMs = performance.now() - started;

    const failures = results.filter((result) => result.status === 'rejected');
    assert.deepEqual(failures, [], 'every legitimate member should be admitted');

    // Simulate clients retrying after a committed response was lost, including
    // several calls aimed at exactly the same member from distinct clients.
    const retryTargets = members.slice(0, 45);
    const retries = await Promise.all(
      retryTargets.map(async (member, index) => {
        try {
          await db.val(
            `select submit_checkin('tok-production-burst', $1, null, null, null, '[]'::jsonb, $2)`,
            [member.id, contexts[index].client_nonce],
          );
          return null;
        } catch (error) {
          return error.code;
        }
      }),
    );
    assert.deepEqual(new Set(retries), new Set(['PDS05']));

    const collisionMember = members[0];
    const collisionCodes = await Promise.all(
      contexts.slice(45, 65).map(async (context) => {
        try {
          await db.val(
            `select submit_checkin('tok-production-burst', $1, null, null, null, '[]'::jsonb, $2)`,
            [collisionMember.id, context.client_nonce],
          );
          return null;
        } catch (error) {
          return error.code;
        }
      }),
    );
    assert.deepEqual(new Set(collisionCodes), new Set(['PDS05']));
    await db.asOwner();

    assert.equal(
      Number(await db.val(`select count(*) from attendance_records where event_id = $1`, [EVENT])),
      USERS_EXPECTED,
      'retries and collisions must not add rows',
    );

    await db.as('authenticated', USERS.officer);
    const ids = await db.q(
      `select id from attendance_records where event_id = $1 order by id`,
      [EVENT],
    );
    assert.equal(
      await db.val(`select review_records($1::uuid[], 'approve', null)`, [ids.map((row) => row.id)]),
      USERS_EXPECTED,
    );
    await db.asOwner();

    const integrity = await db.one(
      `select count(distinct a.id)::int as attendance_count,
              count(v.attendance_id)::int as credit_rows,
              coalesce(sum(v.credit), 0)::numeric as awarded_points
         from attendance_records a
         left join v_attendance_credit v on v.attendance_id = a.id
        where a.event_id = $1`,
      [EVENT],
    );
    assert.equal(integrity.attendance_count, USERS_EXPECTED);
    assert.equal(integrity.credit_rows, USERS_EXPECTED * 2);
    assert.equal(Number(integrity.awarded_points), USERS_EXPECTED * 3);

    t.diagnostic(
      JSON.stringify({
        users: USERS_EXPECTED,
        initial_successes: USERS_EXPECTED,
        initial_failures: 0,
        duplicate_attempts: retryTargets.length + collisionCodes.length,
        duplicate_rows: 0,
        missing_rows: 0,
        incorrect_points: 0,
        burst_ms: Math.round(burstMs),
        per_request_ms: {
          p50: Math.round(percentile(latencies, 0.5)),
          p95: Math.round(percentile(latencies, 0.95)),
          max: Math.round(Math.max(...latencies)),
        },
        concurrency_note: 'requests launched together; PGlite serialized database execution',
      }),
    );
  } finally {
    await db.asOwner();
    await db.close();
  }
});

test('the rate-limit ceiling is enforced by the atomic conflicting-row update', async () => {
  const db = await freshDb();
  try {
    const source = await db.val(
      `select pg_get_functiondef('fn_rate_limit_check(text,integer)'::regprocedure)`,
    );
    assert.match(
      source,
      /ON CONFLICT[\s\S]+DO UPDATE[\s\S]+WHERE rpc_call_counters\.call_count < p_max_per_minute/i,
      'the ceiling must be checked while PostgreSQL holds the conflicting row lock',
    );

    for (let i = 0; i < 7; i += 1) {
      await db.val(`select fn_rate_limit_check('atomic-release-test', 7)`);
    }
    const refused = await db.expectError(
      `select fn_rate_limit_check('atomic-release-test', 7)`,
    );
    assert.equal(refused.code, 'PDS09');
    assert.equal(
      Number(
        await db.val(
          `select call_count from rpc_call_counters where bucket_key = 'atomic-release-test'`,
        ),
      ),
      7,
    );
  } finally {
    await db.close();
  }
});
