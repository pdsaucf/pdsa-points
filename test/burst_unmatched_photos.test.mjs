// A photo-required event, an empty roster, and everybody mid-photo at once.
//
// The outstanding-grant cap exists to stop one caller hoarding licences to
// write into the bucket. Keyed on member_id it works for people on the roster,
// because each of them counts separately. It does NOT work for unmatched
// attendees, who all share a null member_id and therefore share one allowance
// of three between the entire room.
//
// That matters because an empty roster is the shipping state. At a GBM that
// requires a shirt photo, the evidence requirement would quietly stop working
// at exactly the event it exists for: everyone past the third person gets
// PDS04 and falls through to the client's skip path, filing missing_evidence
// instead of a photo.
//
// The phasing below is the part that makes this visible. Real attendees do not
// obtain a grant and redeem it instantly: they get the grant, take the photo,
// wait for it to upload, then submit. For a minute or two the whole room is
// holding a live unconsumed grant, which is precisely when a shared cap of
// three bites.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { attempt, inPinnedMinute } from './helpers/clock.mjs';
import { YEAR_2026 } from './helpers/fixture.mjs';

const ATTENDEES = 167;
const EVENT = '22222222-0000-4000-a000-0000000000d9';

let db;

test.before(async () => {
  db = await freshDb();

  // No members, no enrollments, and a required shirt photo.
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('${EVENT}', '${YEAR_2026}', 'Test Photo GBM Empty Roster', current_date,
            'tok-photo', now() - interval '30 minutes', now() + interval '30 minutes');

    insert into event_categories (event_id, category_id)
    values ('${EVENT}', 'c0000000-0000-4000-a000-000000000001');

    insert into event_evidence_requirements (event_id, kind, is_required, prompt)
    values ('${EVENT}', 'shirt_photo', true, 'Photo of you in your PDSA shirt');
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('167 unmatched attendees can all hold a photo grant at once', async () => {
  assert.equal(Number(await db.val(`select count(*) from members`)), 0, 'roster is empty');

  // Both phases in one transaction, so the whole room shares one limiter
  // window and one now(). That also keeps the grants uniformly live across
  // phase 2, which is the condition this test is about.
  await inPinnedMinute(db, async (windowStart) => {
    await db.as('anon');

    const people = [];
    const grantFailures = [];

    // Phase 1: everybody arrives, opens the page and starts their photo.
    // Nobody has submitted yet, so every grant is outstanding at the same time.
    for (let i = 1; i <= ATTENDEES; i += 1) {
      const name = `Photoless Newcomer${String(i).padStart(3, '0')}`;
      const turn = await attempt(db, 'arrival', async () => {
        const ctx = await db.val(`select get_checkin_context('tok-photo')`);
        const grant = await db.val(
          `select create_evidence_upload('tok-photo', null, 'shirt_photo', $1)`,
          [ctx.client_nonce],
        );
        people.push({ name, nonce: ctx.client_nonce, grant, index: i });
      });
      if (!turn.ok) {
        grantFailures.push({ who: name, code: turn.error.code, message: turn.error.message });
      }
    }

    if (grantFailures.length) {
      const first = grantFailures[0];
      await db.asOwner();
      assert.fail(
        `${grantFailures.length} of ${ATTENDEES} unmatched attendees could not get a photo ` +
          `upload while the room was mid-photo. Only ${people.length} succeeded. ` +
          `First refusal: ${first.who}, ${first.code} ${first.message}`,
      );
    }

    // Phase 2: the photos finish uploading and everybody submits.
    const submitFailures = [];
    for (const person of people) {
      const turn = await attempt(db, 'submission', async () => {
        await db.q(`insert into storage.objects (bucket_id, name) values ('evidence', $1)`, [
          person.grant.object_path,
        ]);
        await db.val(
          `select submit_checkin('tok-photo', null, $1, $2, null, $3::jsonb, $4)`,
          [
            person.name,
            `newcomer${person.index}@example.test`,
            JSON.stringify([
              {
                upload_token: person.grant.upload_token,
                sha256: person.index.toString(16).padStart(64, '0'),
                content_type: 'image/jpeg',
                byte_size: 190000,
              },
            ]),
            person.nonce,
          ],
        );
      });
      if (!turn.ok) {
        submitFailures.push({ who: person.name, code: turn.error.code, message: turn.error.message });
      }
    }

    await db.asOwner();

    const windowEnd = await db.val(`select date_trunc('minute', now())`);
    assert.deepEqual(
      windowEnd,
      windowStart,
      'the burst was not pinned to one minute, so its allowances are not trustworthy',
    );

    assert.deepEqual(submitFailures, [], 'every attendee submitted their photo');

    // The whole point: they checked in WITH a photo, so nobody was pushed onto
    // the skip path and nothing is flagged missing_evidence.
    const rows = await db.one(
      `select count(*) as n,
              count(*) filter (where 'missing_evidence' = any(flags)) as missing
         from attendance_records where event_id = $1`,
      [EVENT],
    );
    assert.equal(Number(rows.n), ATTENDEES);
    assert.equal(Number(rows.missing), 0, 'the evidence requirement still worked');

    const evidence = Number(
      await db.val(
        `select count(*) from attendance_evidence ae
           join attendance_records ar on ar.id = ae.attendance_record_id
          where ar.event_id = $1`,
        [EVENT],
      ),
    );
    assert.equal(evidence, ATTENDEES);
  });
});

test('an unmatched attendee still cannot hoard grants', async () => {
  // Per client, not per room. The cap has to keep working for the case it was
  // written for, which is one browser asking over and over.
  await db.exec(`
    delete from attendance_evidence;
    delete from attendance_records where event_id = '${EVENT}';
    delete from evidence_upload_grants;
    delete from storage.objects;
    delete from rpc_call_counters;
  `);

  await db.as('anon');
  const ctx = await db.val(`select get_checkin_context('tok-photo')`);

  let issued = 0;
  let err = null;
  for (let i = 0; i < 10; i += 1) {
    try {
      await db.val(`select create_evidence_upload('tok-photo', null, 'shirt_photo', $1)`, [
        ctx.client_nonce,
      ]);
      issued += 1;
    } catch (e) {
      err = e;
      break;
    }
  }
  await db.asOwner();

  assert.equal(issued, 3, 'one unmatched client gets the same allowance as one member');
  assert.equal(err.code, 'PDS04');
  assert.match(err.message, /already several photo uploads pending/i);
});

test('a caller with no valid nonce falls back to a shared unmatched bucket', async () => {
  // An invented nonce must not buy a private allowance, or the cap is bypassed
  // by sending a fresh random string per request. Same rule as the limiter.
  await db.exec(`
    delete from evidence_upload_grants;
    delete from rpc_call_counters;
  `);

  await db.as('anon');

  let issued = 0;
  let err = null;
  for (let i = 0; i < 10; i += 1) {
    try {
      await db.val(`select create_evidence_upload('tok-photo', null, 'shirt_photo', $1)`, [
        `invented-nonce-${i}`, // a different lie every time
      ]);
      issued += 1;
    } catch (e) {
      err = e;
      break;
    }
  }
  await db.asOwner();

  assert.equal(issued, 3, 'inventing a nonce does not buy a fresh allowance');
  assert.equal(err.code, 'PDS04');

  // and the grants it did get are not attributed to any nonce
  const attributed = Number(
    await db.val(`select count(*) from evidence_upload_grants where client_nonce is not null`),
  );
  assert.equal(attributed, 0);
});
