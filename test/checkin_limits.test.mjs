// The abuse surface of the anonymous check-in path.
//
// The burst test in burst.test.mjs proves a real crowd gets through. These
// prove the ceilings that stay in place while it does.

import test from 'node:test';
import assert from 'node:assert/strict';

import { attempt, inPinnedMinute } from './helpers/clock.mjs';
import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, USERS, YEAR_2026 } from './helpers/fixture.mjs';
import { restoreTables, snapshotTables } from './helpers/settings.mjs';

const EVENT = '22222222-0000-4000-a000-0000000000a1';

// Config these tests lower to prove a ceiling holds. Snapshotted once the
// fixture is built and put back around every test, so a test that throws
// halfway cannot hand its lowered ceiling to the next one. See
// helpers/settings.mjs for what that leak actually did.
const SHARED_CONFIG = ['app_settings', 'event_evidence_requirements'];

let db;
let config;

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('${EVENT}', '${YEAR_2026}', 'Test Limits Event', current_date, 'tok-limits',
            now() - interval '1 hour', now() + interval '1 hour');

    insert into event_categories (event_id, category_id)
    values ('${EVENT}', 'c0000000-0000-4000-a000-000000000001');

    insert into event_evidence_requirements (event_id, kind)
    values ('${EVENT}', 'shirt_photo');
  `);

  config = await snapshotTables(db, SHARED_CONFIG);
});

test.beforeEach(async () => {
  await db?.asOwner();
  await restoreTables(db, config);
  // Each test gets a clean minute, so one is never billed for another's calls.
  await db.exec(`delete from rpc_call_counters`);
});

test.afterEach(async () => {
  // asOwner first: a test that threw while still `set role anon` has no rights
  // to put the settings back, and a restore that fails is a leak again.
  await db?.asOwner();
  await restoreTables(db, config);
});

test.after(async () => {
  await db?.close();
});

async function nonce(token = 'tok-limits') {
  const ctx = await db.val(`select get_checkin_context($1)`, [token]);
  return ctx.client_nonce;
}

test('one caller cannot hold more than the outstanding-grant cap', async () => {
  await db.q(`update app_settings set value = '3'::jsonb
               where key = 'evidence_grants_outstanding_per_member'`);

  await db.as('anon');
  const n = await nonce();

  // Three is the cap, so three succeed.
  for (let i = 0; i < 3; i += 1) {
    const g = await db.val(`select create_evidence_upload('tok-limits', $1, 'shirt_photo', $2)`, [
      MEMBERS.ada,
      n,
    ]);
    assert.ok(g.object_path);
  }

  // The fourth is refused, and the message tells a real person what to do.
  const err = await db.expectError(
    `select create_evidence_upload('tok-limits', $1, 'shirt_photo', $2)`,
    [MEMBERS.ada, n],
  );
  await db.asOwner();

  assert.equal(err.code, 'PDS04');
  assert.match(err.message, /already several photo uploads pending/i);

  // A rate limit alone would not have stopped this: the cap is on grants
  // outstanding, so waiting does not help while they are still live.
  const outstanding = Number(
    await db.val(
      `select count(*) from evidence_upload_grants
        where event_id = $1 and member_id = $2
          and consumed_at is null and reclaimed_at is null and expires_at > now()`,
      [EVENT, MEMBERS.ada],
    ),
  );
  assert.equal(outstanding, 3);
});

test('consuming a grant frees the slot again', async () => {
  const before = Number(
    await db.val(
      `select count(*) from evidence_upload_grants
        where member_id = $1 and consumed_at is null and reclaimed_at is null`,
      [MEMBERS.ada],
    ),
  );
  assert.equal(before, 3, 'left outstanding by the previous test');

  // Submitting with one of them consumes it.
  const grant = await db.one(
    `select token from evidence_upload_grants
      where member_id = $1 and consumed_at is null limit 1`,
    [MEMBERS.ada],
  );

  await db.as('anon');
  const n = await nonce();
  await db.val(`select submit_checkin('tok-limits', $1, null, null, null, $2::jsonb, $3)`, [
    MEMBERS.ada,
    JSON.stringify([{ upload_token: grant.token, sha256: 'd'.repeat(64) }]),
    n,
  ]);

  // which leaves room for another.
  const g = await db.val(`select create_evidence_upload('tok-limits', $1, 'shirt_photo', $2)`, [
    MEMBERS.ada,
    n,
  ]);
  await db.asOwner();
  assert.ok(g.object_path);

  await db.exec(`delete from attendance_records where event_id = '${EVENT}'`);
});

test('the per-event outstanding cap is separate from the per-member one', async () => {
  await db.exec(`
    delete from evidence_upload_grants;
    update app_settings set value = '2'::jsonb where key = 'evidence_grants_outstanding_per_event';
  `);

  await db.as('anon');
  const n = await nonce();
  await db.val(`select create_evidence_upload('tok-limits', $1, 'shirt_photo', $2)`, [
    MEMBERS.ada,
    n,
  ]);
  await db.val(`select create_evidence_upload('tok-limits', $1, 'shirt_photo', $2)`, [
    MEMBERS.barnaby,
    n,
  ]);

  // A third member, well under their own per-member cap, still hits the
  // event-wide ceiling.
  const err = await db.expectError(
    `select create_evidence_upload('tok-limits', $1, 'shirt_photo', $2)`,
    [MEMBERS.cressida, n],
  );
  await db.asOwner();
  assert.equal(err.code, 'PDS04');
  assert.match(err.message, /too many photo uploads are pending for this event/i);

  // The lowered ceiling is put back by afterEach, not here. The grants are
  // this test's own rows, so it still clears those.
  await db.exec(`delete from evidence_upload_grants`);
});

test('an abandoned upload is found by the reconciliation path and reclaimed', async () => {
  // The exact sequence purge_evidence cannot see: a grant is issued, the
  // browser writes the object, and the check-in is never submitted.
  await db.as('anon');
  const n = await nonce();
  const grant = await db.val(
    `select create_evidence_upload('tok-limits', $1, 'shirt_photo', $2)`,
    [MEMBERS.greta, n],
  );
  await db.q(`insert into storage.objects (bucket_id, name) values ('evidence', $1)`, [
    grant.object_path,
  ]);
  await db.asOwner();

  // Nothing points at that object.
  const evidenceRows = Number(
    await db.val(`select count(*) from attendance_evidence where object_path = $1`, [
      grant.object_path,
    ]),
  );
  assert.equal(evidenceRows, 0);

  // purge_evidence is blind to it, which is the bug this path exists to fix.
  await db.as('authenticated', USERS.officer);
  const evidencePurge = await db.val(`select purge_evidence(1)`);
  assert.equal(evidencePurge.evidence_count, 0);
  await db.asOwner();

  // While the grant is still live it is not yet abandoned, only pending.
  assert.equal(Number(await db.val(`select count(*) from v_orphaned_uploads`)), 0);

  // Once it expires, it surfaces.
  await db.q(`update evidence_upload_grants set expires_at = now() - interval '1 minute'
               where token = $1`, [grant.upload_token]);

  const orphans = await db.q(`select object_path, object_exists from v_orphaned_uploads`);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].object_path, grant.object_path);
  assert.equal(orphans[0].object_exists, true);

  // and the dashboard says so, the same way it surfaces configuration drift.
  const warnings = await db.q(
    `select code, detail from v_config_warnings where code = 'orphaned_uploads'`,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].detail, /never submitted/);

  // An operator presses the button. Nothing here ran on a timer.
  await db.as('authenticated', USERS.officer);
  const res = await db.val(`select purge_orphaned_uploads()`);
  await db.asOwner();

  assert.equal(res.grants_reclaimed, 1);
  assert.equal(res.objects_to_delete, 1);
  assert.deepEqual(res.object_paths, [grant.object_path]);

  // The run is on the record, and the grant row survives as the evidence that
  // an object was written there.
  const run = await db.one(
    `select kind, retention_months, evidence_count from purge_runs where id = $1`,
    [res.purge_run_id],
  );
  assert.equal(run.kind, 'orphaned_uploads');
  assert.equal(run.retention_months, null);
  assert.equal(run.evidence_count, 1);

  const row = await db.one(
    `select reclaimed_at, purge_run_id from evidence_upload_grants where token = $1`,
    [grant.upload_token],
  );
  assert.ok(row.reclaimed_at);
  assert.equal(row.purge_run_id, res.purge_run_id);

  // A second run does not report it again, and the warning clears.
  await db.as('authenticated', USERS.officer);
  const again = await db.val(`select purge_orphaned_uploads()`);
  await db.asOwner();
  assert.equal(again.grants_reclaimed, 0);

  await db.q(`delete from storage.objects where name = $1`, [grant.object_path]);
  assert.equal(
    Number(await db.val(`select count(*) from v_config_warnings where code = 'orphaned_uploads'`)),
    0,
  );
});

test('a member cannot read upload grants, an officer can', async () => {
  await db.as('authenticated', USERS.adaAccount);
  const rows = await db.q(`select * from evidence_upload_grants`);
  assert.equal(rows.length, 0, 'RLS hides grants from members');
  await db.asOwner();

  await db.as('anon');
  const err = await db.expectError(`select * from evidence_upload_grants`);
  assert.equal(err.code, '42501', 'anon has no grant on the table at all');
  await db.asOwner();
});

test('unmatched submissions are capped while matched check-ins keep working', async () => {
  await db.exec(`
    delete from attendance_records where event_id = '${EVENT}';
    delete from rpc_call_counters;
    update app_settings set value = '5'::jsonb
      where key = 'submit_unmatched_max_per_event_per_min';
    -- Take the shared evidence requirement out of the way so submissions are
    -- about the name path and nothing else.
    delete from event_evidence_requirements where event_id = '${EVENT}';
  `);

  // Pinned to a single limiter window. An exact ceiling of 5 only means
  // anything if the whole flood is billed to one minute: a run that crossed a
  // boundary would collect a second allowance and could accept 10.
  await inPinnedMinute(db, async () => {
    await db.as('anon');

    // A flood of "I don't see my name" submissions. Each one is a brand new
    // row with a typed-in name, so nothing in the schema bounds them.
    let accepted = 0;
    let refusal = null;
    for (let i = 0; i < 40; i += 1) {
      const n = await nonce(); // a flooder can always get a fresh nonce
      const turn = await attempt(db, 'flooder', () =>
        db.val(
          `select submit_checkin('tok-limits', null, $1, 'flood@example.test', null, '[]'::jsonb, $2)`,
          [`Flooder Number${i}`, n],
        ),
      );
      if (!turn.ok) {
        refusal = turn.error;
        break;
      }
      accepted += 1;
    }

    assert.equal(accepted, 5, 'the unmatched ceiling held');
    assert.equal(refusal.code, 'PDS09');

    // The point of a separate ceiling: real members checking in are
    // unaffected, because they are counted against a different, far more
    // generous bucket.
    for (const who of ['ada', 'barnaby', 'cressida', 'dorian', 'edda']) {
      const n = await nonce();
      const res = await db.val(
        `select submit_checkin('tok-limits', $1, null, null, null, '[]'::jsonb, $2)`,
        [MEMBERS[who], n],
      );
      assert.equal(res.status, 'pending', `${who} still got through`);
    }
    await db.asOwner();

    const matched = Number(
      await db.val(
        `select count(*) from attendance_records where event_id = $1 and member_id is not null`,
        [EVENT],
      ),
    );
    assert.equal(matched, 5);
  });

  await db.exec(`delete from attendance_records where event_id = '${EVENT}'`);
});

test('nonce minting is itself bounded, so buckets cannot be minted without limit', async () => {
  await db.exec(`
    delete from rpc_call_counters;
    update app_settings set value = '5'::jsonb where key = 'checkin_nonce_max_per_min';
  `);

  await inPinnedMinute(db, async () => {
    await db.as('anon');
    let minted = 0;
    let err = null;
    for (let i = 0; i < 20; i += 1) {
      const turn = await attempt(db, 'mint', () =>
        db.val(`select get_checkin_context('tok-limits')`),
      );
      if (!turn.ok) {
        err = turn.error;
        break;
      }
      minted += 1;
    }
    await db.asOwner();

    assert.equal(minted, 5);
    assert.equal(err.code, 'PDS09');
  });
});

test('the counter records admitted calls only, and stops climbing at the ceiling', async () => {
  // The bug this guards: incrementing before checking means the increment
  // rolls back with the raised exception, so the counter sticks one above the
  // limit and can never distinguish a busy event from an attack.
  await db.exec(`
    delete from rpc_call_counters;
    update app_settings set value = '3'::jsonb
      where key = 'search_members_max_per_event_per_min';
  `);

  // Pinned, so the ten calls and the counter read below are all one window.
  // Unpinned, a boundary between the calls bought a second allowance, and a
  // boundary before the read looked up a row that did not exist yet.
  await inPinnedMinute(db, async (windowStart) => {
    await db.as('anon');
    let ok = 0;
    for (let i = 0; i < 10; i += 1) {
      const turn = await attempt(db, 'search', () =>
        db.q(`select * from search_members('tok-limits', 'Testwood')`),
      );
      if (turn.ok) ok += 1; // the rest are the expected refusals
    }
    await db.asOwner();

    assert.equal(ok, 3);

    const count = Number(
      await db.val(
        `select call_count from rpc_call_counters
          where bucket_key = 'search_members:tok-limits' and window_start = $1`,
        [windowStart],
      ),
    );
    // Exactly the ceiling. Not 4, which is what increment-then-raise leaves
    // behind, and not 10.
    assert.equal(count, 3);
  });
});

test('every check-in ceiling is a setting, so an officer can raise it without a migration', async () => {
  const keys = await db.q(
    `select key from app_settings
      where key like '%max_per%' or key like '%outstanding%' or key like '%ttl_minutes'
      order by key`,
  );
  // The query is broader than this file: it matches every ceiling in the
  // schema, so the two the member portal added (migration 18) show up here
  // too. They are listed rather than filtered out, because what makes this
  // assertion worth having is that it fails BOTH ways. A ceiling introduced
  // anywhere as a constant instead of a row has to fail somewhere, and this is
  // the only place that would notice.
  assert.deepEqual(
    keys.map((k) => k.key),
    [
      'checkin_nonce_max_per_min',
      'checkin_nonce_ttl_minutes',
      'claim_search_max_per_min',
      'evidence_grant_ttl_minutes',
      'evidence_grants_outstanding_per_event',
      'evidence_grants_outstanding_per_member',
      'evidence_upload_max_per_event_per_min',
      'evidence_upload_max_per_nonce_per_min',
      'missing_credit_max_per_min',
      'search_members_max_per_event_per_min',
      'search_members_max_per_nonce_per_min',
      'submit_checkin_max_per_event_per_min',
      'submit_checkin_max_per_nonce_per_min',
      'submit_unmatched_max_per_event_per_min',
      'submit_unmatched_max_per_nonce_per_min',
    ],
  );

  // and only an admin may change one
  await db.as('authenticated', USERS.officer);
  const rows = await db.q(
    `update app_settings set value = '1'::jsonb
      where key = 'submit_checkin_max_per_event_per_min' returning key`,
  );
  await db.asOwner();
  assert.equal(rows.length, 0, 'officers cannot quietly change a ceiling');
});
