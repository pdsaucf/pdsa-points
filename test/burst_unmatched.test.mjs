// The launch condition: a full event against an empty roster.
//
// This deployment starts with zero members. Two ways that produces a room full
// of unmatched submissions, neither of them an edge case:
//
//   1. Nobody ran scripts/import_roster.py before the first event, so EVERY
//      attendee taps "I don't see my name".
//   2. A roster exists, but the first GBM of the year is a recruiting event, so
//      a large share of the room is genuinely new and legitimately unmatched.
//
// The matched path is bounded by one_live_record_per_member_event, and
// burst.test.mjs proves it scales. The unmatched path has no such bound, which
// is why it carries its own ceiling. That ceiling still has to admit a real
// room: 167 people at the historical peak.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { attempt, inPinnedMinute } from './helpers/clock.mjs';
import { YEAR_2026 } from './helpers/fixture.mjs';

const ATTENDEES = 167;

let db;

test.before(async () => {
  db = await freshDb();

  // Deliberately no members and no enrollments. This is the state the system
  // ships in, straight after the migrations.
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('22222222-0000-4000-a000-0000000000c9', '${YEAR_2026}',
            'Test First GBM Of The Year', current_date, 'tok-cold',
            now() - interval '30 minutes', now() + interval '30 minutes');

    insert into event_categories (event_id, category_id)
    values ('22222222-0000-4000-a000-0000000000c9',
            'c0000000-0000-4000-a000-000000000001');
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('167 unmatched attendees all get through an empty-roster event', async () => {
  assert.equal(Number(await db.val(`select count(*) from members`)), 0, 'roster is empty');

  // One transaction, so the whole room is billed to one limiter window.
  await inPinnedMinute(db, async (windowStart) => {
    await db.as('anon');

    const failures = [];
    let submitted = 0;

    for (let i = 1; i <= ATTENDEES; i += 1) {
      const name = `Newcomer Number${String(i).padStart(3, '0')}`;

      // One savepoint per newcomer, so a refusal contains itself and the rest
      // of the queue is still served.
      const turn = await attempt(db, 'newcomer', async () => {
        let nonce = null;
        try {
          const ctx = await db.val(`select get_checkin_context('tok-cold')`);
          nonce = ctx.client_nonce;
        } catch (err) {
          err.stage = 'context';
          throw err;
        }

        // They look for themselves first and find nothing, because the roster
        // is empty. This is what sends them to "I don't see my name".
        try {
          const hits = await db.q(`select * from search_members('tok-cold', $1, $2)`, [
            name.slice(0, 8),
            nonce,
          ]);
          assert.equal(hits.length, 0);
        } catch (err) {
          err.stage = 'search';
          throw err;
        }

        // So they type their name and email and submit.
        try {
          await db.val(
            `select submit_checkin('tok-cold', null, $1, $2, null, '[]'::jsonb, $3)`,
            [name, `newcomer${i}@example.test`, nonce],
          );
          submitted += 1;
        } catch (err) {
          err.stage = 'submit';
          throw err;
        }
      });

      if (!turn.ok) {
        const err = turn.error;
        failures.push({ who: name, stage: err.stage, code: err.code, message: err.message });
      }
    }

    await db.asOwner();

    const windowEnd = await db.val(`select date_trunc('minute', now())`);
    assert.deepEqual(
      windowEnd,
      windowStart,
      'the burst was not pinned to one minute, so its allowances are not trustworthy',
    );

    if (failures.length) {
      const first = failures[0];
      const byStage = failures.reduce(
        (acc, f) => ({ ...acc, [f.stage]: (acc[f.stage] ?? 0) + 1 }),
        {},
      );
      assert.fail(
        `${failures.length} of ${ATTENDEES} newcomers were turned away ` +
          `(${JSON.stringify(byStage)}). ${submitted} submissions completed. ` +
          `First failure: ${first.who} at ${first.stage}, ${first.code} ${first.message}`,
      );
    }

    assert.equal(submitted, ATTENDEES);

    const rows = await db.q(
      `select count(*) as n,
              count(*) filter (where member_id is null) as unmatched,
              count(*) filter (where 'unmatched_name' = any(flags)) as flagged
         from attendance_records
        where event_id = '22222222-0000-4000-a000-0000000000c9'`,
    );
    assert.equal(Number(rows[0].n), ATTENDEES);
    assert.equal(Number(rows[0].unmatched), ATTENDEES);
    assert.equal(Number(rows[0].flagged), ATTENDEES, 'every one lands in the review queue flagged');

    // Each attendee should have been billed to their own bucket, so the tight
    // per-client ceiling is what constrains a flooder rather than the crowd.
    const perClient = Number(
      await db.val(
        `select count(*) from rpc_call_counters
          where bucket_key like 'submit_unmatched:tok-cold:%' and window_start = $1`,
        [windowStart],
      ),
    );
    assert.equal(perClient, ATTENDEES, 'each newcomer got their own unmatched bucket');
  });
});

test('one client still cannot flood unmatched submissions', async () => {
  await db.exec(`delete from rpc_call_counters`);

  // Pinned: a ceiling of exactly 3 is only a ceiling if all 20 attempts fall
  // in one window. Crossing a boundary mid-loop would admit 6 and the test
  // would be reporting the wrong number rather than failing.
  await inPinnedMinute(db, async () => {
    await db.as('anon');
    const ctx = await db.val(`select get_checkin_context('tok-cold')`);
    const nonce = ctx.client_nonce;

    let accepted = 0;
    let err = null;
    for (let i = 0; i < 20; i += 1) {
      const turn = await attempt(db, 'flooder', () =>
        db.val(`select submit_checkin('tok-cold', null, $1, null, null, '[]'::jsonb, $2)`, [
          `Flooder Attempt${i}`,
          nonce,
        ]),
      );
      if (!turn.ok) {
        err = turn.error;
        break;
      }
      accepted += 1;
    }
    await db.asOwner();

    // One person submits once, maybe twice with a retry. Three is the ceiling.
    assert.equal(accepted, 3);
    assert.equal(err.code, 'PDS09');
  });

  await db.exec(`
    delete from attendance_records where claimed_name like 'Flooder Attempt%';
    delete from rpc_call_counters;
  `);
});

test('an event with nobody enrolled warns before the event, not after', async () => {
  const warnings = await db.q(
    `select code, severity, subject_label, detail from v_config_warnings
      where code = 'event_without_enrolled_members'`,
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].subject_label, 'Test First GBM Of The Year');
  assert.match(warnings[0].detail, /import_roster/);

  // Enrolling anybody clears it.
  await db.exec(`
    insert into members (id, first_name, last_name)
    values ('11111111-0000-4000-a000-0000000000c1', 'Somebody', 'Onroster');
    insert into member_enrollments (member_id, academic_year_id)
    values ('11111111-0000-4000-a000-0000000000c1', '${YEAR_2026}');
  `);

  assert.equal(
    Number(
      await db.val(
        `select count(*) from v_config_warnings where code = 'event_without_enrolled_members'`,
      ),
    ),
    0,
  );

  await db.exec(`
    delete from member_enrollments where member_id = '11111111-0000-4000-a000-0000000000c1';
    delete from members where id = '11111111-0000-4000-a000-0000000000c1';
  `);
});
