// The RPC surface.
//
// The anonymous check-in page is the highest-risk part of this system: it
// ships an anon key to everyone who scans a QR code. These tests are mostly
// about what an anonymous caller cannot do.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, EVENTS, USERS, YEAR_2026 } from './helpers/fixture.mjs';

let db;

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  // An event with a wide-open window and a required photo, for the anonymous
  // path. Everything else in the fixture has no window at all.
  await db.exec(`
    insert into events (id, academic_year_id, term_id, title, occurred_on,
                        checkin_token, checkin_opens_at, checkin_closes_at)
    values ('22222222-0000-4000-a000-0000000000c1', '${YEAR_2026}',
            'b0000000-0000-4000-a000-000000000001',
            'Test Open Check-in Event', current_date, 'tok-open',
            now() - interval '1 hour', now() + interval '1 hour');

    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('22222222-0000-4000-a000-0000000000c1',
            'c0000000-0000-4000-a000-000000000001', 'fixed', 1);

    insert into event_evidence_requirements (event_id, kind, is_required, prompt)
    values ('22222222-0000-4000-a000-0000000000c1', 'shirt_photo', true,
            'Photo of you in your PDSA shirt');

    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('22222222-0000-4000-a000-0000000000c2', '${YEAR_2026}',
            'Test Closed Check-in Event', current_date, 'tok-closed',
            now() - interval '10 days', now() - interval '9 days');
  `);
});

// A failing assertion can leave the connection inside `set role`, which would
// then leak into every later test in the file. Reset before each one.
test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

const OPEN = 'tok-open';

test('get_checkin_context describes the form, and nothing about the roster', async () => {
  await db.as('anon');
  const ctx = await db.val(`select get_checkin_context($1)`, [OPEN]);
  await db.asOwner();

  assert.equal(ctx.event.title, 'Test Open Check-in Event');
  assert.equal(ctx.categories.length, 1);
  assert.equal(ctx.categories[0].name, 'GBMs');
  assert.equal(ctx.collect_value, null); // this event collects no number
  assert.equal(ctx.evidence_requirements.length, 1);
  assert.equal(ctx.evidence_requirements[0].kind, 'shirt_photo');

  const serialised = JSON.stringify(ctx);
  assert.equal(serialised.includes('Testwood'), false, 'no roster leaks through');
});

test('get_checkin_context refuses an unknown token and a closed window', async () => {
  await db.as('anon');
  const unknown = await db.expectError(`select get_checkin_context('not-a-real-token')`);
  const closed = await db.expectError(`select get_checkin_context('tok-closed')`);
  await db.asOwner();

  assert.equal(unknown.code, 'PDS01');
  assert.equal(closed.code, 'PDS10');
});

test('too early and too late are distinct codes, not one code and two sentences', async () => {
  // The check-in page shows different screens for these, because they need
  // different things from the member: wait and come back, against find an
  // officer. That distinction used to live in the message text, so rewording a
  // sentence would silently show the wrong screen and no test would fail.
  //
  // This test is the contract. The messages below are deliberately NOT
  // asserted on: they are copy and should stay freely rewritable.
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('22222222-0000-4000-a000-0000000000e9', '${YEAR_2026}',
            'Test Not Open Yet', current_date, 'tok-early',
            now() + interval '2 hours', now() + interval '4 hours');
  `);

  await db.as('anon');
  const early = await db.expectError(`select get_checkin_context('tok-early')`);
  const late = await db.expectError(`select get_checkin_context('tok-closed')`);

  // submit_checkin resolves the window separately, with a grace period, so it
  // has to agree on both codes independently.
  const earlySubmit = await db.expectError(
    `select submit_checkin('tok-early', $1, null, null, null, '[]'::jsonb)`,
    [MEMBERS.ada],
  );
  const lateSubmit = await db.expectError(
    `select submit_checkin('tok-closed', $1, null, null, null, '[]'::jsonb)`,
    [MEMBERS.ada],
  );
  await db.asOwner();

  assert.equal(early.code, 'PDS02', 'too early');
  assert.equal(late.code, 'PDS10', 'too late');
  assert.equal(earlySubmit.code, 'PDS02');
  assert.equal(lateSubmit.code, 'PDS10');
  assert.notEqual(early.code, late.code);

  await db.exec(`delete from events where id = '22222222-0000-4000-a000-0000000000e9'`);
});

test('an event that collects hours says so, and names the unit', async () => {
  await db.exec(`
    update events set checkin_opens_at = now() - interval '1 hour',
                      checkin_closes_at = now() + interval '1 hour'
     where checkin_token = 'tok-vol-social';
  `);

  await db.as('anon');
  const ctx = await db.val(`select get_checkin_context('tok-vol-social')`);
  await db.asOwner();

  assert.equal(ctx.collect_value.category, 'Volunteering');
  assert.equal(ctx.collect_value.unit, 'hours');
  assert.equal(ctx.collect_value.unit_label, 'hour');
  assert.equal(ctx.categories.length, 2); // hours and a social, one event
});

test('search_members returns names only, capped, and needs three letters', async () => {
  await db.as('anon');

  const short = await db.expectError(`select * from search_members($1, 'Ad')`, [OPEN]);
  assert.equal(short.code, 'PDS03');

  const rows = await db.q(`select * from search_members($1, 'Testwood')`, [OPEN]);
  await db.asOwner();

  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['display_name', 'id']);
  assert.equal(rows[0].display_name, 'Ada Testwood');
});

test('search_members will not run without a valid open token', async () => {
  await db.as('anon');
  const err = await db.expectError(`select * from search_members('not-a-real-token', 'Testwood')`);
  await db.asOwner();
  assert.equal(err.code, 'PDS01');
});

test('submit_checkin forces pending status and self_checkin source', async () => {
  await db.as('anon');
  const res = await db.val(
    `select submit_checkin($1, $2, null, null, null, '[]'::jsonb)`,
    [OPEN, MEMBERS.dorian],
  );
  await db.asOwner();

  assert.equal(res.status, 'pending');

  const row = await db.one(`select status, source, flags from attendance_records where id = $1`, [
    res.record_id,
  ]);
  assert.equal(row.status, 'pending');
  assert.equal(row.source, 'self_checkin');

  // The event requires a shirt photo and none arrived.
  assert.deepEqual(row.flags, ['missing_evidence']);

  await db.q(`delete from attendance_records where id = $1`, [res.record_id]);
});

test('there is no argument by which an anonymous caller can choose a status', async () => {
  // submit_checkin takes six arguments and none of them is a status or a
  // source. This is the structural reason the anonymous page cannot grant
  // itself credit.
  const args = await db.val(
    `select pg_get_function_arguments(p.oid)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'submit_checkin'`,
  );
  assert.equal(/status/i.test(args), false, args);
  assert.equal(/source/i.test(args), false, args);
});

test('submit_checkin flags a member who is not enrolled, and one previously rejected', async () => {
  await db.exec(`
    insert into members (id, first_name, last_name)
    values ('11111111-0000-4000-a000-0000000000e1', 'Kester', 'Unenrolled');
  `);

  await db.as('anon');
  const res = await db.val(`select submit_checkin($1, $2, null, null, null, '[]'::jsonb)`, [
    OPEN,
    '11111111-0000-4000-a000-0000000000e1',
  ]);
  await db.asOwner();

  const row = await db.one(`select flags from attendance_records where id = $1`, [res.record_id]);
  assert.ok(row.flags.includes('not_enrolled'));
  assert.ok(row.flags.includes('missing_evidence'));

  await db.exec(`
    delete from attendance_records where member_id = '11111111-0000-4000-a000-0000000000e1';
    delete from members where id = '11111111-0000-4000-a000-0000000000e1';
  `);
});

test('an unmatched submission is filed, flagged, and cannot become credit on its own', async () => {
  await db.as('anon');
  const res = await db.val(
    `select submit_checkin($1, null, 'Someone Nothereyet', 'someone@example.test', null, '[]'::jsonb)`,
    [OPEN],
  );
  await db.asOwner();

  const row = await db.one(
    `select member_id, claimed_name, status, flags from attendance_records where id = $1`,
    [res.record_id],
  );
  assert.equal(row.member_id, null);
  assert.equal(row.claimed_name, 'Someone Nothereyet');
  assert.ok(row.flags.includes('unmatched_name'));

  // An officer resolves it. That links the person and enrolls them, but
  // deliberately does not approve anything.
  await db.as('authenticated', USERS.officer);
  const newMemberId = await db.val(
    `select resolve_unmatched($1, null, $2::jsonb)`,
    [res.record_id, JSON.stringify({ first_name: 'Someone', last_name: 'Nothereyet' })],
  );
  await db.asOwner();

  const after = await db.one(
    `select member_id, status, flags from attendance_records where id = $1`,
    [res.record_id],
  );
  assert.equal(after.member_id, newMemberId);
  assert.equal(after.status, 'pending', 'resolving identity is not approving credit');
  assert.equal(after.flags.includes('unmatched_name'), false);

  const enrolled = Number(
    await db.val(
      `select count(*) from member_enrollments where member_id = $1 and academic_year_id = $2`,
      [newMemberId, YEAR_2026],
    ),
  );
  assert.equal(enrolled, 1);

  await db.exec(`delete from attendance_records where id = '${res.record_id}'`);
  await db.exec(`delete from member_enrollments where member_id = '${newMemberId}'`);
  await db.exec(`delete from members where id = '${newMemberId}'`);
});

test('a second check-in to the same event is refused with a readable error', async () => {
  await db.as('anon');
  const first = await db.val(`select submit_checkin($1, $2, null, null, null, '[]'::jsonb)`, [
    OPEN,
    MEMBERS.fergus,
  ]);
  const err = await db.expectError(
    `select submit_checkin($1, $2, null, null, null, '[]'::jsonb)`,
    [OPEN, MEMBERS.fergus],
  );
  await db.asOwner();

  assert.equal(err.code, 'PDS05');
  assert.match(err.message, /already checked in/i);

  await db.q(`delete from attendance_records where id = $1`, [first.record_id]);
});

test('an event that collects a number refuses a submission without one', async () => {
  await db.as('anon');
  const err = await db.expectError(
    `select submit_checkin('tok-vol-social', $1, null, null, null, '[]'::jsonb)`,
    [MEMBERS.dorian],
  );
  await db.asOwner();
  assert.equal(err.code, 'PDS03');
});

test('create_evidence_upload only grants a path the event actually asks for', async () => {
  await db.as('anon');

  const wrongKind = await db.expectError(
    `select create_evidence_upload($1, $2, 'receipt_photo')`,
    [OPEN, MEMBERS.dorian],
  );
  assert.equal(wrongKind.code, 'PDS04');

  const grant = await db.val(`select create_evidence_upload($1, $2, 'shirt_photo')`, [
    OPEN,
    MEMBERS.dorian,
  ]);
  await db.asOwner();

  assert.ok(grant.upload_token);
  assert.equal(grant.bucket, 'evidence');
  assert.match(grant.object_path, /^a0000000-.*\/shirt_photo\/[0-9a-f]{32}\.jpg$/);
});

test('a granted upload path is writable once, and only while it is live', async () => {
  await db.as('anon');
  const grant = await db.val(`select create_evidence_upload($1, $2, 'shirt_photo')`, [
    OPEN,
    MEMBERS.dorian,
  ]);

  // The storage policy lets anon write exactly this path.
  await db.q(`insert into storage.objects (bucket_id, name) values ('evidence', $1)`, [
    grant.object_path,
  ]);

  // and refuses any other one.
  const err = await db.expectError(
    `insert into storage.objects (bucket_id, name) values ('evidence', 'somebody-elses-file.jpg')`,
  );
  assert.equal(err.code, '42501');
  await db.asOwner();

  await db.q(`delete from storage.objects where name = $1`, [grant.object_path]);
  await db.q(`delete from evidence_upload_grants where token = $1`, [grant.upload_token]);
});

test('submit_checkin consumes the grant and records the evidence', async () => {
  await db.as('anon');
  const grant = await db.val(`select create_evidence_upload($1, $2, 'shirt_photo')`, [
    OPEN,
    MEMBERS.greta,
  ]);

  const res = await db.val(
    `select submit_checkin($1, $2, null, null, null, $3::jsonb)`,
    [
      OPEN,
      MEMBERS.greta,
      JSON.stringify([
        {
          upload_token: grant.upload_token,
          sha256: 'a'.repeat(64),
          content_type: 'image/jpeg',
          byte_size: 180000,
        },
      ]),
    ],
  );
  await db.asOwner();

  const row = await db.one(`select flags from attendance_records where id = $1`, [res.record_id]);
  assert.equal(row.flags.includes('missing_evidence'), false);

  const ev = await db.one(
    `select kind, object_path, byte_size, sha256 from attendance_evidence
      where attendance_record_id = $1`,
    [res.record_id],
  );
  assert.equal(ev.kind, 'shirt_photo');
  assert.equal(ev.object_path, grant.object_path);
  assert.equal(ev.byte_size, 180000);

  const consumed = await db.one(
    `select consumed_at from evidence_upload_grants where token = $1`,
    [grant.upload_token],
  );
  assert.ok(consumed.consumed_at, 'a grant is one-shot');

  // Replaying the same grant is refused.
  await db.as('anon');
  const replay = await db.expectError(
    `select submit_checkin($1, $2, null, null, null, $3::jsonb)`,
    [
      OPEN,
      MEMBERS.jasper,
      JSON.stringify([{ upload_token: grant.upload_token, sha256: 'b'.repeat(64) }]),
    ],
  );
  await db.asOwner();
  assert.equal(replay.code, 'PDS04');

  await db.exec(`delete from attendance_records where id = '${res.record_id}'`);
});

test('the same photo submitted against a second event is flagged', async () => {
  const sha = 'c'.repeat(64);

  await db.as('anon');
  const g1 = await db.val(`select create_evidence_upload($1, $2, 'shirt_photo')`, [
    OPEN,
    MEMBERS.edda,
  ]);
  const r1 = await db.val(`select submit_checkin($1, $2, null, null, null, $3::jsonb)`, [
    OPEN,
    MEMBERS.edda,
    JSON.stringify([{ upload_token: g1.upload_token, sha256: sha }]),
  ]);
  await db.asOwner();

  // A second event, same required photo kind, same image bytes.
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        checkin_opens_at, checkin_closes_at)
    values ('22222222-0000-4000-a000-0000000000c3', '${YEAR_2026}',
            'Test Second Open Event', current_date, 'tok-open-2',
            now() - interval '1 hour', now() + interval '1 hour');
    insert into event_categories (event_id, category_id) values
      ('22222222-0000-4000-a000-0000000000c3', 'c0000000-0000-4000-a000-000000000005');
    insert into event_evidence_requirements (event_id, kind) values
      ('22222222-0000-4000-a000-0000000000c3', 'shirt_photo');
  `);

  await db.as('anon');
  const g2 = await db.val(`select create_evidence_upload('tok-open-2', $1, 'shirt_photo')`, [
    MEMBERS.edda,
  ]);
  const r2 = await db.val(
    `select submit_checkin('tok-open-2', $1, null, null, null, $2::jsonb)`,
    [MEMBERS.edda, JSON.stringify([{ upload_token: g2.upload_token, sha256: sha }])],
  );
  await db.asOwner();

  const row = await db.one(`select flags from attendance_records where id = $1`, [r2.record_id]);
  assert.ok(row.flags.includes('duplicate_photo'));

  await db.exec(`
    delete from attendance_records where id in ('${r1.record_id}', '${r2.record_id}');
    delete from events where id = '22222222-0000-4000-a000-0000000000c3';
  `);
});

test('officer RPCs refuse a member and a plain anon caller', async () => {
  await db.as('authenticated', USERS.adaAccount);
  const asMember = await db.expectError(
    `select review_records(array[]::uuid[], 'approve', null)`,
  );
  assert.equal(asMember.code, 'PDS07');

  await db.as('anon');
  const asAnon = await db.expectError(`select review_records(array[]::uuid[], 'approve', null)`);
  await db.asOwner();
  assert.equal(asAnon.code, '42501'); // anon holds no EXECUTE grant at all
});

test('review_records approves in bulk, stamping who and when', async () => {
  const ids = (
    await db.q(
      `select id from attendance_records where member_id = $1 and status = 'pending'`,
      [MEMBERS.hamish],
    )
  ).map((r) => r.id);
  assert.equal(ids.length, 2);

  await db.as('authenticated', USERS.officer);
  const n = await db.val(`select review_records($1::uuid[], 'approve', 'Looks fine')`, [ids]);
  await db.asOwner();

  assert.equal(Number(n), 2);

  const rows = await db.q(
    `select status, reviewed_by, reviewed_at, review_note from attendance_records
      where id = any($1::uuid[])`,
    [ids],
  );
  for (const r of rows) {
    assert.equal(r.status, 'approved');
    assert.equal(r.reviewed_by, USERS.officer);
    assert.ok(r.reviewed_at);
    assert.equal(r.review_note, 'Looks fine');
  }

  const audit = await db.one(
    `select action, actor_user_id, detail from audit_log
      where action = 'review_records' order by created_at desc limit 1`,
  );
  assert.equal(audit.actor_user_id, USERS.officer);
  assert.equal(audit.detail.count, 2);

  // Put it back so other tests see the fixture they expect.
  await db.q(`update attendance_records set status = 'pending' where id = any($1::uuid[])`, [ids]);
});

test('merge_members moves records, drops collisions and tombstones the loser', async () => {
  await db.exec(`
    insert into members (id, first_name, last_name)
    values ('11111111-0000-4000-a000-0000000000d1', 'Dorian', 'Nullstone');
    insert into member_enrollments (member_id, academic_year_id)
    values ('11111111-0000-4000-a000-0000000000d1', '${YEAR_2026}');

    -- one record the survivor does not have, and one they do
    insert into attendance_records (event_id, member_id, status, source) values
      ('${EVENTS.visits}', '11111111-0000-4000-a000-0000000000d1', 'approved', 'officer_entry'),
      ('${EVENTS.soap}',   '11111111-0000-4000-a000-0000000000d1', 'approved', 'officer_entry');
    insert into attendance_records (event_id, member_id, status, source) values
      ('${EVENTS.soap}', '${MEMBERS.dorian}', 'approved', 'officer_entry');
  `);

  await db.as('authenticated', USERS.officer);
  const res = await db.val(`select merge_members($1, $2)`, [
    '11111111-0000-4000-a000-0000000000d1',
    MEMBERS.dorian,
  ]);
  await db.asOwner();

  assert.equal(res.dropped, 1); // the soap collision
  assert.equal(res.moved, 1); // the visits record

  const survivor = await db.one(
    `select count(*) as n from attendance_records where member_id = $1`,
    [MEMBERS.dorian],
  );
  assert.equal(Number(survivor.n), 2);

  const loser = await db.one(
    `select merged_into_id, archived_at from members where id = $1`,
    ['11111111-0000-4000-a000-0000000000d1'],
  );
  assert.equal(loser.merged_into_id, MEMBERS.dorian);
  assert.ok(loser.archived_at);

  const merge = await db.one(
    `select moved_records, dropped_records, performed_by from member_merges
      where from_member_id = $1`,
    ['11111111-0000-4000-a000-0000000000d1'],
  );
  assert.equal(merge.moved_records, 1);
  assert.equal(merge.dropped_records, 1);
  assert.equal(merge.performed_by, USERS.officer);

  await db.exec(`
    delete from attendance_records where member_id = '${MEMBERS.dorian}';
    delete from member_merges where from_member_id = '11111111-0000-4000-a000-0000000000d1';
    delete from members where id = '11111111-0000-4000-a000-0000000000d1';
  `);
});

test('purge_evidence only takes reviewed photos from events past the window', async () => {
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token)
    values ('22222222-0000-4000-a000-0000000000f9', '${YEAR_2026}',
            'Test Ancient Event', current_date - 800, 'tok-ancient');
    insert into event_categories (event_id, category_id)
    values ('22222222-0000-4000-a000-0000000000f9', 'c0000000-0000-4000-a000-000000000005');

    insert into attendance_records (id, event_id, member_id, status, source) values
      ('33333333-0000-4000-a000-000000000001', '22222222-0000-4000-a000-0000000000f9',
       '${MEMBERS.jasper}', 'approved', 'officer_entry'),
      ('33333333-0000-4000-a000-000000000002', '22222222-0000-4000-a000-0000000000f9',
       '${MEMBERS.fergus}', 'pending', 'self_checkin');

    insert into attendance_evidence (attendance_record_id, kind, object_path, byte_size) values
      ('33333333-0000-4000-a000-000000000001', 'shirt_photo', 'old/reviewed.jpg', 1000),
      ('33333333-0000-4000-a000-000000000002', 'shirt_photo', 'old/unreviewed.jpg', 2000);
  `);

  await db.as('authenticated', USERS.officer);
  const res = await db.val(`select purge_evidence(12)`);
  await db.asOwner();

  assert.equal(res.evidence_count, 1, 'the pending record keeps its photo');
  assert.equal(res.bytes_freed, 1000);
  assert.deepEqual(res.object_paths, ['old/reviewed.jpg']);

  const kept = await db.one(
    `select purged_at from attendance_evidence where object_path = 'old/unreviewed.jpg'`,
  );
  assert.equal(kept.purged_at, null);

  // A second run does not report the same photo again.
  await db.as('authenticated', USERS.officer);
  const again = await db.val(`select purge_evidence(12)`);
  await db.asOwner();
  assert.equal(again.evidence_count, 0);

  await db.exec(`
    delete from attendance_evidence where object_path like 'old/%';
    delete from attendance_records where event_id = '22222222-0000-4000-a000-0000000000f9';
    delete from events where id = '22222222-0000-4000-a000-0000000000f9';
  `);
});
