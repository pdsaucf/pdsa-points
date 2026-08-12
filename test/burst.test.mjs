// The regression test for the check-in rate limiter.
//
// The largest single event in the 2025-2026 data was Fall GBM 2 with 167
// attendees; the second largest was 155. Those people arrive in a clump, scan
// the same QR code, and autocomplete their own name before submitting. If the
// limiter cannot admit that burst, the system fails at exactly the moment it
// exists to serve, and it fails for the people at the back of the queue.
//
// This test reproduces that minute. Every one of 167 attendees must complete
// a realistic autocomplete (three searches as they type) and a submission,
// and every one must succeed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { attempt, inPinnedMinute } from './helpers/clock.mjs';
import { YEAR_2026 } from './helpers/fixture.mjs';

const ATTENDEES = 167;
const SEARCHES_EACH = 3; // 'Bur', 'Burston', then most of the full name

let db;

test.before(async () => {
  db = await freshDb();

  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('22222222-0000-4000-a000-0000000000b1', '${YEAR_2026}',
            'Test Peak Attendance GBM', current_date, 'tok-burst',
            now() - interval '30 minutes', now() + interval '30 minutes');

    insert into event_categories (event_id, category_id)
    values ('22222222-0000-4000-a000-0000000000b1',
            'c0000000-0000-4000-a000-000000000001');

    -- NOTE: every attendee here is on the roster, so this file exercises the
    -- MATCHED path only. The unmatched path has a different, much tighter
    -- ceiling and its own failure mode, and an empty roster is how this system
    -- ships. That case lives in burst_unmatched.test.mjs. Do not assume this
    -- file covers it.
    insert into members (first_name, last_name)
    select 'Burstone', 'Attendee' || lpad(g::text, 3, '0')
    from generate_series(1, ${ATTENDEES}) g;

    insert into member_enrollments (member_id, academic_year_id)
    select id, '${YEAR_2026}' from members where first_name = 'Burstone';
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('167 attendees all get through one minute of check-in', async () => {
  const members = await db.q(
    `select id, display_name from members where first_name = 'Burstone' order by display_name`,
  );
  assert.equal(members.length, ATTENDEES);

  // The whole burst runs in one transaction, so every call in it is billed to
  // one limiter window. This used to sleep up to a minute to make straddling
  // unlikely; pinning makes it impossible.
  await inPinnedMinute(db, async (windowStart) => {
    await db.as('anon');

    const failures = [];
    let searches = 0;
    let submits = 0;

    for (const member of members) {
      // One savepoint per attendee. A refusal then rolls back that attendee's
      // own work and leaves the queue behind them able to carry on, which is
      // what happens in production and is what keeps the failure report below
      // readable instead of 166 cascaded aborts.
      const turn = await attempt(db, 'attendee', async () => {
        // Everybody's page load. This is also where a client nonce would come
        // from once the limiter has a per-client key.
        let nonce = null;
        try {
          const ctx = await db.val(`select get_checkin_context('tok-burst')`);
          nonce = ctx.client_nonce ?? null;
        } catch (err) {
          err.stage = 'context';
          throw err;
        }

        // Typing their name, three queries as the box narrows.
        const typed = ['Bur', 'Burston', member.display_name.slice(0, 18)];
        for (const q of typed) {
          try {
            if (nonce === null) {
              await db.q(`select * from search_members('tok-burst', $1)`, [q]);
            } else {
              await db.q(`select * from search_members('tok-burst', $1, $2)`, [q, nonce]);
            }
            searches += 1;
          } catch (err) {
            err.stage = 'search';
            throw err;
          }
        }

        // Tapping their name and submitting.
        try {
          if (nonce === null) {
            await db.val(`select submit_checkin('tok-burst', $1, null, null, null, '[]'::jsonb)`, [
              member.id,
            ]);
          } else {
            await db.val(
              `select submit_checkin('tok-burst', $1, null, null, null, '[]'::jsonb, $2)`,
              [member.id, nonce],
            );
          }
          submits += 1;
        } catch (err) {
          err.stage = 'submit';
          throw err;
        }
      });

      if (!turn.ok) {
        const err = turn.error;
        failures.push({
          who: member.display_name,
          stage: err.stage,
          code: err.code,
          message: err.message,
        });
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
      const bySt = failures.reduce((acc, f) => ({ ...acc, [f.stage]: (acc[f.stage] ?? 0) + 1 }), {});
      assert.fail(
        `${failures.length} of ${ATTENDEES} attendees were turned away ` +
          `(${JSON.stringify(bySt)}). ` +
          `${searches} of ${ATTENDEES * SEARCHES_EACH} searches and ${submits} of ${ATTENDEES} ` +
          `submissions completed. First failure: ${first.who} at ${first.stage}, ` +
          `${first.code} ${first.message}`,
      );
    }

    assert.equal(submits, ATTENDEES);
    assert.equal(searches, ATTENDEES * SEARCHES_EACH);

    const recorded = Number(
      await db.val(
        `select count(*) from attendance_records
          where event_id = '22222222-0000-4000-a000-0000000000b1'`,
      ),
    );
    assert.equal(recorded, ATTENDEES, 'every attendee has a pending record');

    // It has to pass for the right reason. If this crowd got through only
    // because the shared ceiling was raised, the per-client keying is untested
    // and the next 500-person event breaks again. Each attendee should have had
    // their own search bucket.
    const searchBuckets = Number(
      await db.val(
        `select count(*) from rpc_call_counters
          where bucket_key like 'search_members:tok-burst:%' and window_start = $1`,
        [windowStart],
      ),
    );
    assert.equal(searchBuckets, ATTENDEES, 'each attendee got their own limiter bucket');

    // And the shared per-event bucket should show every admitted call, proving
    // the backstop is still counting rather than having been switched off.
    const eventBucket = Number(
      await db.val(
        `select call_count from rpc_call_counters
          where bucket_key = 'search_members:tok-burst' and window_start = $1`,
        [windowStart],
      ),
    );
    assert.equal(eventBucket, ATTENDEES * SEARCHES_EACH);
  });
});

test('an invented or expired nonce does not buy a private bucket', async () => {
  // The whole scheme rests on this. If any string the caller makes up were
  // honoured as a bucket key, an attacker would send a fresh one per request
  // and have no limit at all, which is strictly worse than the shared bucket
  // this replaced.
  const eventId = '22222222-0000-4000-a000-0000000000b1';

  const forged = await db.val(`select fn_checkin_nonce_bucket($1, $2)`, [
    eventId,
    'i-made-this-up',
  ]);
  assert.equal(forged, '', 'an invented nonce falls back to the shared bucket');

  const absent = await db.val(`select fn_checkin_nonce_bucket($1, null)`, [eventId]);
  assert.equal(absent, '', 'no nonce falls back to the shared bucket');

  // A real nonce, but issued for a different event, is also not honoured.
  await db.as('anon');
  const ctx = await db.val(`select get_checkin_context('tok-burst')`);
  await db.asOwner();
  assert.ok(ctx.client_nonce, 'get_checkin_context issues a nonce');

  const wrongEvent = await db.val(`select fn_checkin_nonce_bucket($1, $2)`, [
    '22222222-0000-4000-a000-000000000001',
    ctx.client_nonce,
  ]);
  assert.equal(wrongEvent, '', 'a nonce is bound to the event it was issued for');

  const right = await db.val(`select fn_checkin_nonce_bucket($1, $2)`, [
    eventId,
    ctx.client_nonce,
  ]);
  assert.equal(right, ':' + ctx.client_nonce);

  // Expiry is honoured too.
  await db.q(`update checkin_client_nonces set expires_at = now() - interval '1 minute'
              where nonce = $1`, [ctx.client_nonce]);
  const expired = await db.val(`select fn_checkin_nonce_bucket($1, $2)`, [
    eventId,
    ctx.client_nonce,
  ]);
  assert.equal(expired, '', 'an expired nonce falls back to the shared bucket');
});

test('a nonce confers no authority of its own', async () => {
  // It selects a counter bucket. It must not stand in for the check-in token,
  // and it must not unlock an event whose window is closed.
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('22222222-0000-4000-a000-0000000000b2', '${YEAR_2026}',
            'Test Shut Event', current_date, 'tok-shut',
            now() - interval '10 days', now() - interval '9 days');
  `);

  await db.as('anon');
  const ctx = await db.val(`select get_checkin_context('tok-burst')`);

  // The nonce is not a token: passing it where a token belongs fails.
  const asToken = await db.expectError(`select get_checkin_context($1)`, [ctx.client_nonce]);
  assert.equal(asToken.code, 'PDS01');

  // And holding one does not reopen a closed event.
  const closed = await db.expectError(
    `select * from search_members('tok-shut', 'Burstone', $1)`,
    [ctx.client_nonce],
  );
  assert.equal(closed.code, 'PDS10');
  await db.asOwner();
});
