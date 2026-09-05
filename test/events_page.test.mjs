// The public /events page: what has to be added to the database for
// docs/05-events-page.md, and nothing this file does not check.
//
// Properties this suite exists to catch:
//
//   THE ARITHMETIC IS RIGHT, INCLUDING ACROSS A DST TRANSITION.
//   fn_event_release_at() is the one place "8:00 AM every Monday" gets
//   turned into an actual instant. A naive implementation built from a fixed
//   UTC offset, or from `interval '7 days'` arithmetic, reads as correct all
//   summer and drifts an hour the first Monday after the clocks change. The
//   DST test below is the one that would catch that. It is a pure function:
//   given the same occurred_on and created_at, it always answers the same
//   instant, and nothing below mutates it.
//
//   THE STORED RELEASE IS MONOTONIC. events.release_at is written once at
//   insert (anchored on the server clock, not on the caller-supplied
//   created_at) and only ever recomputed while it is still in the future.
//   Once an event has actually dropped, no later edit, including
//   postponing its date by months, may pull the release back and
//   un-announce it. That is the whole bug this design exists to fix, and
//   the postpone tests below are what would have caught the live-recompute
//   version of it.
//
//   THE TOGGLE IS THE ONLY THING THAT TURNS THE DROP OFF. With
//   events_auto_publish set to false, fn_event_is_visible() answers exactly
//   is_published and nothing else, no matter how far in the past the
//   stored release_at is.
//
//   fn_setting_bool NEVER RAISES. app_settings.value is arbitrary jsonb; a
//   malformed events_auto_publish row would otherwise take down every
//   anonymous portal_events() and portal_attendance() call with an
//   uncaught cast error. A check constraint stops that key from being
//   written wrong in the first place, and the function falls back to its
//   default for anything else that could still be sitting in the row.
//
//   PORTAL_EVENTS() IS AS NARROW AS THE DOC SAYS. No unpublished event, no
//   member, no notes, no checkin_token, nothing for anybody, and filtered
//   on visibility alone: an unannounced event has no business on the
//   public upcoming list nobody has personally engaged with yet.
//
//   is_published NO LONGER GATES CHECK-IN. It used to be a no-op guard
//   (every event has always carried it true, because the admin form never
//   wrote it), and flipping its default to false would otherwise turn it
//   into a real one: a freshly created, queued event's QR code would refuse
//   every scan until an officer published it or the Monday drop reached it.
//   The check-in token is the access control; is_published is a publish
//   flag for the public page. fn_checkin_event() was fixed to stop reading
//   it, and the regression test below is what would have caught the bug if
//   it had shipped.
//
//   YOUR OWN PAST HISTORY IS NEVER HIDDEN, AND YOUR FUTURE ONE ALWAYS IS.
//   portal_attendance() shows an event a member has an attendance record
//   against once it has actually happened, whether or not it is visible,
//   because the credit views never filtered on is_published and an
//   invisible event's points were already counting toward the members
//   total. A FUTURE event a member checked into stays hidden until its own
//   date passes, even from that same member: check-in has no gate on
//   occurred_on, portal_attendance() is anon-callable by member id, and
//   portal_leaderboard() hands out every member id there is, so an
//   unbounded exception would let anyone read next week's unannounced
//   event off of whoever already checked into it, defeating the Monday
//   drop.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, YEAR_2026 } from './helpers/fixture.mjs';

let db;

const CAT_GBMS = 'c0000000-0000-4000-a000-000000000001';
const CAT_SOCIALS = 'c0000000-0000-4000-a000-000000000005';

const anon = (sql, params = []) => db.withRole('anon', null, () => db.val(sql, params));

const portalEvents = () => anon(`select portal_events()`);
const portalAttendance = (memberId) => anon(`select portal_attendance($1)`, [memberId]);

// fn_event_release_at() is unchanged by the durable-release-column work: it
// is still the pure function the insert and update triggers call, and this
// is still the direct way to exercise its arithmetic without a table row.
const releaseAt = (occurredOn, createdAt) =>
  db.val(`select fn_event_release_at($1::date, $2::timestamptz)`, [occurredOn, createdAt]);

// fn_event_is_visible() now takes the STORED release_at directly rather than
// deriving it from occurred_on and created_at, matching the real function.
const isVisible = (isPublished, releaseAtValue) =>
  db.val(`select fn_event_is_visible($1, $2::timestamptz)`, [isPublished, releaseAtValue]);

const setAutoPublish = (on) =>
  db.exec(
    `update app_settings set value = '${on}'::jsonb where key = 'events_auto_publish'`,
  );

// Simulates real time passing an event's stored release_at, the way waiting
// actually would: directly overwrites the column while the update trigger
// (which would otherwise recompute it from occurred_on and THIS instant) is
// switched off, then switches it back on so every later write on this
// shared db is latched normally again.
const forceReleaseAt = async (eventId, releaseAtValue) => {
  await db.exec(`alter table events disable trigger events_release_at_before_update`);
  await db.q(`update events set release_at = $1 where id = $2`, [releaseAtValue, eventId]);
  await db.exec(`alter table events enable trigger events_release_at_before_update`);
};

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
});

test.beforeEach(async () => {
  await db?.asOwner();
  await setAutoPublish(true);
});

test.afterEach(async () => {
  await db?.asOwner();
  await setAutoPublish(true);
});

test.after(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// fn_event_release_at(): the Monday drop arithmetic
// ---------------------------------------------------------------------------

test('an event dated Sep 20, created Thu Sep 3, releases Mon Sep 7 08:00 ET', async () => {
  const at = await releaseAt('2026-09-20', '2026-09-03T14:00:00-04:00');
  assert.equal(new Date(at).toISOString(), '2026-09-07T12:00:00.000Z');
});

test('an event dated Oct 30, created Sep 3, releases Mon Oct 19 08:00 ET', async () => {
  const at = await releaseAt('2026-10-30', '2026-09-03T14:00:00-04:00');
  assert.equal(new Date(at).toISOString(), '2026-10-19T12:00:00.000Z');
});

test('an event created Wed Sep 9 for Sat Sep 12 releases after its own date', async () => {
  // occurred_on - 14 puts term A in late August, so term B (the first Monday
  // after creation) is the one that wins, and it lands two days after the
  // event itself. This is the "Not visible / Publishes after the event" case
  // from docs/05-events-page.md.
  const occurredOn = '2026-09-12';
  const at = await releaseAt(occurredOn, '2026-09-09T10:00:00-04:00');
  assert.equal(new Date(at).toISOString(), '2026-09-14T12:00:00.000Z');
  assert.ok(new Date(at) > new Date(`${occurredOn}T23:59:59-04:00`),
    'the release instant is not actually after the event it belongs to');
});

test('created_at moves the release forward, occurred_on cannot pull it back', async () => {
  // Same event date, only created_at moves. The later creation cannot be
  // released any earlier than its own first Monday, even though term A (from
  // the event date alone) would allow it.
  const early = await releaseAt('2026-12-01', '2026-08-01T09:00:00-04:00');
  const late = await releaseAt('2026-12-01', '2026-11-25T09:00:00-05:00');
  assert.ok(new Date(late) > new Date(early));
});

test('a Monday morning created exactly at 08:00 does not release itself', async () => {
  // created_at ON the Monday 8:00 boundary is not "strictly after" itself, so
  // term B has to bump a further week out rather than reporting an instant
  // equal to created_at.
  const at = await releaseAt('2026-12-01', '2026-11-09T08:00:00-05:00'); // a Monday, 08:00 ET
  assert.ok(new Date(at) > new Date('2026-11-09T13:00:00.000Z'));
});

test('the drop crosses DST and stays 08:00 local, not 08:00 UTC-4 year round', async () => {
  // Both created long before either date, so term A (from the event date)
  // decides both, and the only variable is which side of the November clock
  // change the release Monday falls on.
  const july = await releaseAt('2026-07-20', '2026-01-01T00:00:00-05:00');
  const november = await releaseAt('2026-11-30', '2026-01-01T00:00:00-05:00');

  const julyIso = new Date(july).toISOString();
  const novemberIso = new Date(november).toISOString();

  // 08:00 EDT is 12:00 UTC; 08:00 EST (after the clocks fall back) is 13:00
  // UTC. A naive fixed-offset implementation would print 12:00 for both.
  assert.equal(julyIso.slice(11, 16), '12:00', `July release was not 08:00 EDT: ${julyIso}`);
  assert.equal(novemberIso.slice(11, 16), '13:00', `November release was not 08:00 EST: ${novemberIso}`);

  // And both really do read as 08:00 in America/New_York, which is the fact
  // that has to hold regardless of the UTC offset.
  const localTimes = await db.q(
    `select to_char($1::timestamptz at time zone 'America/New_York', 'HH24:MI') as t
     union all
     select to_char($2::timestamptz at time zone 'America/New_York', 'HH24:MI')`,
    [july, november],
  );
  assert.deepEqual(localTimes.map((r) => r.t), ['08:00', '08:00']);
});

// ---------------------------------------------------------------------------
// The auto-publish toggle
// ---------------------------------------------------------------------------

test('with the toggle off, nothing auto-releases: only is_published counts', async () => {
  // A release instant safely in the past, so the drop would have already
  // fired if the toggle were on.
  const longAgoReleaseAt = '2025-12-08T13:00:00.000Z';

  await setAutoPublish(false);
  assert.equal(
    await isVisible(false, longAgoReleaseAt),
    false,
    'a queued event became visible with the drop turned off',
  );
  assert.equal(
    await isVisible(true, longAgoReleaseAt),
    true,
    'is_published stopped working while the toggle was off',
  );

  await setAutoPublish(true);
  assert.equal(
    await isVisible(false, longAgoReleaseAt),
    true,
    'turning the toggle back on did not let an overdue event drop',
  );
});

test('the is_visible computed column agrees with fn_event_is_visible using the stored release_at', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea10';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Computed Columns Event', date '2026-01-15',
            'tok-ea10', false);
  `);

  // Force the stored column into the past, the way real time passing it
  // would: release_at is no longer derived from occurred_on and created_at
  // on every read, so this is how the test puts the row in the "already
  // dropped" state rather than a fixed, backdated created_at.
  await forceReleaseAt(eventId, '2025-12-08T13:00:00.000Z');

  await setAutoPublish(false);
  const hidden = await db.one(
    `select release_at, is_visible(e) from events e where e.id = $1`,
    [eventId],
  );
  assert.equal(hidden.is_visible, false, 'the toggle being off did not suppress an overdue release');
  assert.equal(
    hidden.is_visible,
    await isVisible(false, hidden.release_at),
    'the computed column disagrees with the plain function given the same stored release_at',
  );

  await setAutoPublish(true);
  const dropped = await db.one(`select is_visible(e) from events e where e.id = $1`, [eventId]);
  assert.equal(dropped.is_visible, true);

  await db.exec(`delete from events where id = '${eventId}'`);
});

// ---------------------------------------------------------------------------
// events.release_at: stored once, latched, never recomputed backwards
// ---------------------------------------------------------------------------

test('an events release is set at insert from the server clock, not a caller-supplied created_at', async () => {
  // The backdated-import case: created_at claims this row has existed since
  // 2020, which under the old live-recompute design would have made the
  // event instantly visible the moment it landed, because term B is a
  // Monday after created_at. The trigger anchors on now() instead, so a
  // spoofed created_at buys nothing.
  const eventId = '22222222-0000-4000-a000-00000000ea18';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        is_published, created_at)
    values ('${eventId}', '${YEAR_2026}', 'Test Import Cannot Backdate Release',
            current_date + 3, 'tok-ea18', false, timestamptz '2020-01-01T00:00:00-05:00');
  `);

  const releaseAtValue = await db.val(`select release_at from events where id = $1`, [eventId]);
  assert.ok(
    new Date(releaseAtValue).getTime() > Date.now(),
    'an event imported with a backdated created_at released immediately',
  );

  await db.exec(`delete from events where id = '${eventId}'`);
});

test('postponing a still-queued event moves its release forward', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea19';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Postpone While Queued', current_date + 10,
            'tok-ea19', false);
  `);
  const before = await db.val(`select release_at from events where id = $1`, [eventId]);
  assert.ok(new Date(before).getTime() > Date.now(), 'the fixture event is not actually queued');

  await db.exec(`update events set occurred_on = current_date + 90 where id = '${eventId}'`);
  const after = await db.val(`select release_at from events where id = $1`, [eventId]);

  assert.ok(
    new Date(after).getTime() > new Date(before).getTime(),
    'postponing a queued event by three months did not move its release out',
  );

  await db.exec(`delete from events where id = '${eventId}'`);
});

test('postponing an already-released event never un-announces it: the monotonic latch', async () => {
  // This is the bug report, reproduced directly: an officer moves an
  // already-visible event three months out. Without the latch, recomputing
  // term A from the new date would push release_at back into the future
  // and the event would vanish from the members page.
  const eventId = '22222222-0000-4000-a000-00000000ea20';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Latch After Release', current_date + 5,
            'tok-ea20', false);
  `);

  await forceReleaseAt(eventId, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  const releasedBefore = await db.val(`select release_at from events where id = $1`, [eventId]);
  const visibleBefore = await db.val(`select is_visible(e) from events e where e.id = $1`, [eventId]);
  assert.equal(visibleBefore, true, 'the fixture event is not actually released yet');

  await db.exec(`update events set occurred_on = current_date + 90 where id = '${eventId}'`);

  const releasedAfter = await db.val(`select release_at from events where id = $1`, [eventId]);
  const visibleAfter = await db.val(`select is_visible(e) from events e where e.id = $1`, [eventId]);

  assert.equal(
    new Date(releasedAfter).getTime(),
    new Date(releasedBefore).getTime(),
    'the latch let a released events instant move after a later edit',
  );
  assert.equal(visibleAfter, true, 'postponing an already-released event un-announced it');

  await db.exec(`delete from events where id = '${eventId}'`);
});

// ---------------------------------------------------------------------------
// Check-in does not care whether an event has been announced
// ---------------------------------------------------------------------------

test('a queued event with no manual publish and a future release can still be checked into', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea09';
  const token = 'tok-ea09-queued-checkin';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Queued Event Still Checks In',
            current_date, '${token}', false);
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${CAT_GBMS}', 'fixed', 1);
  `);

  // Confirm the fixture really is the case in question: not published, and
  // its Monday release (stamped at insert from the server clock) has not
  // arrived yet.
  const event = await db.one(
    `select is_published, release_at, is_visible(e) from events e where e.id = $1`,
    [eventId],
  );
  assert.equal(event.is_published, false);
  assert.equal(event.is_visible, false, 'the fixture event is not actually queued');
  assert.ok(
    new Date(event.release_at).getTime() > Date.now(),
    'the fixture events release instant is not actually in the future',
  );

  const ctx = await anon(`select get_checkin_context($1)`, [token]);
  assert.equal(ctx.event.id, eventId, 'get_checkin_context refused a queued events own token');

  const filed = await anon(
    `select submit_checkin($1, $2, null, null, null, '[]'::jsonb)`,
    [token, MEMBERS.dorian],
  );
  assert.ok(filed, 'submit_checkin refused a queued, unpublished events check-in');

  const status = await db.val(
    `select status from attendance_records where event_id = $1 and member_id = $2`,
    [eventId, MEMBERS.dorian],
  );
  assert.equal(status, 'pending', 'the check-in did not actually file an attendance record');

  await db.exec(`delete from attendance_records where event_id = '${eventId}';
                 delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

// ---------------------------------------------------------------------------
// portal_events(): the public page
// ---------------------------------------------------------------------------

test('portal_events returns the eight facts and categories for a visible upcoming event', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea01';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, starts_at, ends_at,
                        checkin_token, is_published, location, attire, signup, description,
                        notes)
    values ('${eventId}', '${YEAR_2026}', 'Test Visible Fall Social',
            current_date + 10, current_date + 10 + time '18:00', current_date + 10 + time '20:00',
            'tok-ea01', true, 'Chemistry Building Room 101', 'Business casual',
            'https://forms.example.com/rsvp', 'A public description of the event.',
            'Officer-only setup notes that must never reach the public page');
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${CAT_SOCIALS}', 'fixed', 2);
  `);

  const answer = await portalEvents();
  assert.equal(answer.year.id, YEAR_2026);
  const event = answer.events.find((row) => row.id === eventId);
  assert.ok(event, 'the visible event is missing from portal_events');

  assert.deepEqual(Object.keys(event).sort(), [
    'attire', 'categories', 'description', 'ends_at', 'id', 'location',
    'occurred_on', 'signup', 'starts_at', 'title',
  ]);
  assert.equal(event.location, 'Chemistry Building Room 101');
  assert.equal(event.attire, 'Business casual');
  assert.equal(event.signup, 'https://forms.example.com/rsvp');
  assert.equal(event.description, 'A public description of the event.');
  assert.equal(event.categories.length, 1);
  assert.equal(event.categories[0].id, CAT_SOCIALS);
  assert.equal(event.categories[0].name, 'Socials');
  assert.equal(event.categories[0].credit_mode, 'fixed');
  assert.equal(Number(event.categories[0].fixed_credit), 2);

  await db.exec(`delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

test('portal_events never returns an unpublished, un-dropped event', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea02';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Queued Future Release',
            current_date + 20, 'tok-ea02', false);
  `);

  const answer = await portalEvents();
  assert.equal(answer.events.find((row) => row.id === eventId), undefined);

  await db.exec(`delete from events where id = '${eventId}'`);
});

test('portal_events carries no member, no attendance, no note and no token', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea03';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token,
                        is_published, notes)
    values ('${eventId}', '${YEAR_2026}', 'Test Narrow Surface Event', current_date + 5,
            'tok-narrow-surface-secret', true, 'A private officer setup note');
    insert into attendance_records (event_id, member_id, status, source)
    values ('${eventId}', '${MEMBERS.dorian}', 'approved', 'officer_entry');
  `);

  const answer = await portalEvents();
  const text = JSON.stringify(answer);
  assert.ok(!text.includes('member'), 'portal_events carries a member field');
  assert.ok(!text.includes('tok-narrow-surface-secret'), 'portal_events leaked the checkin_token');
  assert.ok(!text.includes('private officer setup note'), 'portal_events leaked notes');
  assert.ok(!text.includes('status'), 'portal_events carries an attendance status');

  await db.exec(`delete from attendance_records where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

test('portal_events includes a queued event once the Monday drop has passed it', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea04';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Dropped By Monday Rule', current_date + 3,
            'tok-ea04', false);
  `);
  await forceReleaseAt(eventId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const answer = await portalEvents();
  assert.ok(
    answer.events.some((row) => row.id === eventId),
    'a queued event whose release instant has passed did not appear',
  );

  await db.exec(`delete from events where id = '${eventId}'`);
});

test('portal_events omits an event that has already happened', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea05';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Already Passed Public Event', current_date - 1,
            'tok-ea05', true);
  `);

  const answer = await portalEvents();
  assert.equal(answer.events.find((row) => row.id === eventId), undefined);

  await db.exec(`delete from events where id = '${eventId}'`);
});

// ---------------------------------------------------------------------------
// portal_attendance(): visible by the drop, not only by a manual publish
// ---------------------------------------------------------------------------

test('portal_attendance keeps an event the member checked into once it is dropped, not just published', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea06';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Attended Then Dropped', current_date - 2,
            'tok-ea06', false);
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${CAT_GBMS}', 'fixed', 1);
    insert into attendance_records (event_id, member_id, status, source)
    values ('${eventId}', '${MEMBERS.dorian}', 'approved', 'officer_entry');
  `);
  await forceReleaseAt(eventId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const card = await portalAttendance(MEMBERS.dorian);
  const event = card.events.find((row) => row.id === eventId);
  assert.ok(event, 'the event dropped by the Monday rule left a hole in the members history');
  assert.equal(event.status, 'attended');

  await db.exec(`delete from attendance_records where event_id = '${eventId}';
                 delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

test('portal_attendance still hides a queued event nobody has checked into yet', async () => {
  const eventId = '22222222-0000-4000-a000-00000000ea07';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Still Queued Not Dropped', current_date + 1,
            'tok-ea07', false);
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${CAT_GBMS}', 'fixed', 1);
  `);

  const card = await portalAttendance(MEMBERS.dorian);
  assert.equal(card.events.find((row) => row.id === eventId), undefined);

  await db.exec(`delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

test('an approved attendance on a queued, never-published, already-past event is never hidden', async () => {
  // The "publishes after the event" case docs/05-events-page.md calls out:
  // never auto-released, and never published by hand. Visibility alone
  // would hide this event from the very member who attended it while their
  // point total kept counting the credit anyway. occurred_on is in the
  // past (unlike a still-upcoming queued event, see the test below), which
  // is what makes the own-record branch apply at all.
  const eventId = '22222222-0000-4000-a000-00000000ea11';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Attended Never Published', current_date - 2,
            'tok-ea11', false);
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${CAT_GBMS}', 'fixed', 3);
    insert into attendance_records (event_id, member_id, status, source)
    values ('${eventId}', '${MEMBERS.dorian}', 'approved', 'officer_entry');
  `);

  // Confirm the premise: this event really is invisible by the ordinary
  // rule, so the test is exercising the asymmetry and not a fixture mistake.
  const check = await db.one(`select is_visible(e) from events e where e.id = $1`, [eventId]);
  assert.equal(
    check.is_visible,
    false,
    'the fixture event unexpectedly became visible; this test no longer exercises the case it is meant to',
  );

  const card = await portalAttendance(MEMBERS.dorian);
  const event = card.events.find((row) => row.id === eventId);
  assert.ok(
    event,
    'a member with an approved record on a queued, never-published, already-past event lost it from their own history',
  );
  assert.equal(event.status, 'attended');

  await db.exec(`delete from attendance_records where event_id = '${eventId}';
                 delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

test('a future queued events attendance stays hidden from anyone until the event has happened', async () => {
  // The leak item 3 closes: check-in has no gate on occurred_on, so a
  // member can check into a future, unannounced event the moment its QR
  // exists. portal_attendance() is anon-callable by member id and
  // portal_leaderboard() hands out every member id, so an unbounded
  // own-record exception would let a stranger read next weeks unannounced
  // event off of whoever already checked into it. The bound to
  // already-happened events is what keeps that from leaking, and it
  // self-heals the moment the event's date actually passes.
  const eventId = '22222222-0000-4000-a000-00000000ea17';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Future Attendance Hidden Until Past',
            current_date + 5, 'tok-ea17', false);
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${CAT_GBMS}', 'fixed', 1);
    insert into attendance_records (event_id, member_id, status, source)
    values ('${eventId}', '${MEMBERS.dorian}', 'approved', 'officer_entry');
  `);

  // Confirm the premise: genuinely not yet visible by the ordinary rule.
  const visible = await db.val(`select is_visible(e) from events e where e.id = $1`, [eventId]);
  assert.equal(visible, false, 'the fixture event unexpectedly became visible');

  const before = await portalAttendance(MEMBERS.dorian);
  assert.equal(
    before.events.find((row) => row.id === eventId),
    undefined,
    'a future, unannounced event that a member checked into leaked ahead of the Monday drop',
  );

  // The event happens; its date passes.
  await db.exec(`update events set occurred_on = current_date - 1 where id = '${eventId}'`);

  const after = await portalAttendance(MEMBERS.dorian);
  const event = after.events.find((row) => row.id === eventId);
  assert.ok(event, 'the members own attendance on a now-past event stayed hidden');
  assert.equal(event.status, 'attended');

  await db.exec(`delete from attendance_records where event_id = '${eventId}';
                 delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

test('the scorecard point total equals the sum of credit on the events portal_attendance actually returned, for a past, never-published event', async () => {
  // This is the invariant a member would notice breaking: points in the
  // total with no row anywhere on the page to explain them. Attaching a
  // past, never-published event to a member with a full published history
  // is what proves its credit is not just present but actually reconciles,
  // rather than being separately, coincidentally right.
  const eventId = '22222222-0000-4000-a000-00000000ea12';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${eventId}', '${YEAR_2026}', 'Test Reconciliation Queued Event', current_date - 3,
            'tok-ea12', false);
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${CAT_GBMS}', 'fixed', 4);
    insert into attendance_records (event_id, member_id, status, source)
    values ('${eventId}', '${MEMBERS.ada}', 'approved', 'officer_entry');
  `);

  const card = await portalAttendance(MEMBERS.ada);
  assert.ok(
    card.events.some((row) => row.id === eventId),
    'the queued, never-published event is missing from the events list this total is supposed to reconcile with',
  );

  let summedCredit = 0;
  for (const event of card.events) {
    for (const category of event.categories ?? []) {
      if (category.credit !== null && category.credit !== undefined) {
        summedCredit += Number(category.credit);
      }
    }
  }
  assert.equal(
    summedCredit,
    Number(card.scorecard.point_total),
    'the events portal_attendance returned do not add up to the scorecard total shipped alongside them',
  );

  await db.exec(`delete from attendance_records where event_id = '${eventId}';
                 delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

// ---------------------------------------------------------------------------
// fn_setting_bool(): never raises, whatever is in the row
// ---------------------------------------------------------------------------

test('fn_setting_bool never raises on a malformed row and falls back to the default', async () => {
  // A key other than events_auto_publish, so the check constraint (which
  // exists specifically to stop THAT key from ever holding a bad value) is
  // not in the way. This is what a differently-named setting, or a row that
  // predates the constraint, could still look like.
  await db.exec(`
    insert into app_settings (key, value) values ('test_malformed_bool', '2'::jsonb)
    on conflict (key) do update set value = excluded.value
  `);
  assert.equal(await db.val(`select fn_setting_bool('test_malformed_bool', true)`), true);

  await db.exec(`update app_settings set value = '"garbage"'::jsonb where key = 'test_malformed_bool'`);
  assert.equal(await db.val(`select fn_setting_bool('test_malformed_bool', false)`), false);

  await db.exec(`update app_settings set value = '{"nested": true}'::jsonb where key = 'test_malformed_bool'`);
  assert.equal(await db.val(`select fn_setting_bool('test_malformed_bool', true)`), true);

  await db.exec(`update app_settings set value = 'null'::jsonb where key = 'test_malformed_bool'`);
  assert.equal(await db.val(`select fn_setting_bool('test_malformed_bool', true)`), true);

  // And a key with no row at all.
  await db.exec(`delete from app_settings where key = 'test_malformed_bool'`);
  assert.equal(await db.val(`select fn_setting_bool('test_malformed_bool', true)`), true);
});

test('a real jsonb boolean still reads through fn_setting_bool correctly', async () => {
  await db.exec(`
    insert into app_settings (key, value) values ('test_real_bool', 'false'::jsonb)
    on conflict (key) do update set value = excluded.value
  `);
  assert.equal(await db.val(`select fn_setting_bool('test_real_bool', true)`), false);

  await db.exec(`delete from app_settings where key = 'test_real_bool'`);
});

test('the events_auto_publish row itself cannot be written as anything but a boolean', async () => {
  const before = await db.val(`select value from app_settings where key = 'events_auto_publish'`);

  const err = await db.expectError(
    `update app_settings set value = '2'::jsonb where key = 'events_auto_publish'`,
  );
  assert.match(String(err.code) + ' ' + err.message, /23514|check constraint|events_auto_publish_is_boolean/i);

  const stillType = await db.val(
    `select jsonb_typeof(value) from app_settings where key = 'events_auto_publish'`,
  );
  assert.equal(stillType, 'boolean', 'a malformed write was not actually refused');
  assert.equal(await db.val(`select value from app_settings where key = 'events_auto_publish'`), before);
});
