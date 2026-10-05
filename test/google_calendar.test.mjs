// The Member Calendar sync: docs/10-google-calendar.md.
//
// calendar_sync_plan() is the whole decision; the Edge Function only does
// what it says. These check that it posts what is live, re-posts what
// changed, takes off what stopped being live or was deleted, moves upcoming
// events when the calendar is switched, leaves the past alone, and that only
// service_role can run any of it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, USERS, YEAR_2026 } from './helpers/fixture.mjs';

let db;

const LIVE = '22222222-0000-4000-a000-00000000ca01';
const QUEUED = '22222222-0000-4000-a000-00000000ca02';
const PAST = '22222222-0000-4000-a000-00000000ca03';

const service = (sql, params = []) => db.withRole('service_role', null, () => db.val(sql, params));
const plan = () => service(`select calendar_sync_plan()`);
const ids = (rows) => rows.map((row) => row.event_id).sort();
const setCalendar = (id, enabled = true) => db.exec(`
  update app_settings set value = to_jsonb('${id}'::text) where key = 'google_calendar_id';
  update app_settings set value = '${enabled}'::jsonb where key = 'google_calendar_enabled';
`);
const posted = async (eventId, calendarId) => {
  const version = await db.val(`select config_version from events where id = $1`, [eventId]);
  await service(`select calendar_sync_posted($1, $2, $3)`, [eventId, calendarId, version]);
};

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published, members_only)
    values ('${LIVE}', '${YEAR_2026}', 'Live Social', current_date + 4, 'tok-ca01', true, true),
           ('${QUEUED}', '${YEAR_2026}', 'Queued Social', current_date + 60, 'tok-ca02', false, false),
           ('${PAST}', '${YEAR_2026}', 'Past Social', current_date - 3, 'tok-ca03', true, false);
  `);
});

test.after(async () => {
  await db?.close();
});

test('nothing happens until a calendar is set and posting is on', async () => {
  const off = await plan();
  assert.equal(off.enabled, false);
  assert.deepEqual(off.upserts, []);
  await setCalendar('club@group.calendar.google.com', false);
  assert.equal((await plan()).enabled, false);
});

test('live upcoming events are posted, queued and past ones are not', async () => {
  await setCalendar('club@group.calendar.google.com');
  const answer = await plan();
  assert.equal(answer.calendar_id, 'club@group.calendar.google.com');
  const mine = answer.upserts.filter((row) => [LIVE, QUEUED, PAST].includes(row.event_id));
  assert.deepEqual(ids(mine), [LIVE]);
  assert.equal(mine[0].members_only, true);
  await posted(LIVE, 'club@group.calendar.google.com');
  assert.equal((await plan()).upserts.some((row) => row.event_id === LIVE), false, 'posted twice');
});

test('an edit re-posts, an unpublish takes it off, and a delete leaves a removal', async () => {
  await db.exec(`update events set location = 'HPA II' where id = '${LIVE}'`);
  assert.ok((await plan()).upserts.some((row) => row.event_id === LIVE), 'an edit was not re-posted');
  await posted(LIVE, 'club@group.calendar.google.com');

  await db.exec(`update events set is_published = false, release_at = now() + interval '30 days' where id = '${LIVE}'`);
  const off = (await plan()).deletes.find((row) => row.event_id === LIVE);
  assert.deepEqual(off, { event_id: LIVE, calendar_id: 'club@group.calendar.google.com' });
  await service(`select calendar_sync_removed($1, $2)`, [LIVE, 'club@group.calendar.google.com']);
  assert.equal((await plan()).deletes.some((row) => row.event_id === LIVE), false);

  await db.exec(`update events set is_published = true where id = '${LIVE}'`);
  await posted(LIVE, 'club@group.calendar.google.com');
  await db.exec(`delete from events where id = '${LIVE}'`);
  const gone = (await plan()).deletes.find((row) => row.event_id === LIVE);
  assert.equal(gone.calendar_id, 'club@group.calendar.google.com');
  await service(`select calendar_sync_removed($1, $2)`, [LIVE, 'club@group.calendar.google.com']);
  assert.equal((await plan()).deletes.some((row) => row.event_id === LIVE), false);
});

test('switching calendars moves upcoming events and leaves the past alone', async () => {
  const event = '22222222-0000-4000-a000-00000000ca04';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${event}', '${YEAR_2026}', 'Moving Social', current_date + 2, 'tok-ca04', true);
  `);
  await posted(event, 'club@group.calendar.google.com');
  await posted(PAST, 'club@group.calendar.google.com');
  await setCalendar('next-year@group.calendar.google.com');
  const answer = await plan();
  assert.ok(answer.upserts.some((row) => row.event_id === event), 'the upcoming event did not move');
  assert.equal(answer.upserts.some((row) => row.event_id === PAST), false, 'a past event moved');

  // Posted to the new calendar: the old one owes a removal until Google
  // confirms it, however many runs fail first.
  await posted(event, 'next-year@group.calendar.google.com');
  const owed = (await plan()).deletes.filter((row) => row.event_id === event);
  assert.deepEqual(owed, [{ event_id: event, calendar_id: 'club@group.calendar.google.com' }]);
  assert.deepEqual((await plan()).deletes.filter((row) => row.event_id === event), owed, 'a removal was forgotten');
  await service(`select calendar_sync_removed($1, $2)`, [event, 'club@group.calendar.google.com']);
  assert.equal((await plan()).deletes.some((row) => row.event_id === event), false);
  assert.equal(await db.val(`select calendar_posted_to from events where id = $1`, [event]),
    'next-year@group.calendar.google.com', 'clearing the old calendar cleared the new one');
});

test('an event deleted while it was being posted still comes off the calendar', async () => {
  const event = '22222222-0000-4000-a000-00000000ca05';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${event}', '${YEAR_2026}', 'Racing Social', current_date + 2, 'tok-ca05', true);
  `);
  const version = await db.val(`select config_version from events where id = $1`, [event]);
  await db.exec(`delete from events where id = '${event}'`);
  // The run had already read the plan and written to Google.
  await service(`select calendar_sync_posted($1, $2, $3)`, [event, 'next-year@group.calendar.google.com', version]);
  assert.deepEqual((await plan()).deletes.filter((row) => row.event_id === event),
    [{ event_id: event, calendar_id: 'next-year@group.calendar.google.com' }]);
});

test('only service_role runs the sync, and settings reject the wrong shape', async () => {
  for (const sql of [`select calendar_sync_plan()`, `select calendar_sync_removed('${PAST}', 'x')`,
                     `select report_integration_status('calendar_status', '{}'::jsonb)`]) {
    const anon = await db.withRole('anon', null, () => db.expectError(sql));
    assert.equal(anon.code, '42501');
    const officer = await db.withRole('authenticated', USERS.officer, () => db.expectError(sql));
    assert.equal(officer.code, '42501');
  }
  const bad = await db.expectError(`update app_settings set value = '7'::jsonb where key = 'google_calendar_id'`);
  assert.equal(bad.code, '23514');
  await service(`select report_integration_status('calendar_status', '{"ok": true}'::jsonb)`);
  assert.deepEqual(await db.val(`select value from app_settings where key = 'calendar_status'`), { ok: true });
});

test('a write Google accepted but nobody acknowledged is cleaned up, even after a delete', async () => {
  const event = '22222222-0000-4000-a000-00000000ca06';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${event}', '${YEAR_2026}', 'Crashing Social', current_date + 2, 'tok-ca06', true);
  `);
  await service(`select calendar_sync_intent($1, $2)`, [event, 'next-year@group.calendar.google.com']);
  // The run died after Google accepted the event. An officer deletes it.
  await db.exec(`delete from events where id = '${event}'`);
  assert.deepEqual((await plan()).deletes.filter((row) => row.event_id === event),
    [{ event_id: event, calendar_id: 'next-year@group.calendar.google.com' }]);

  // And without a delete: a stale intent is owed after ten minutes.
  const live = '22222222-0000-4000-a000-00000000ca07';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${live}', '${YEAR_2026}', 'Stalled Social', current_date + 2, 'tok-ca07', true);
  `);
  await service(`select calendar_sync_intent($1, $2)`, [live, 'old@group.calendar.google.com']);
  assert.equal((await plan()).deletes.some((row) => row.event_id === live), false, 'a fresh intent was removed');
  await db.exec(`update calendar_pending set created_at = now() - interval '11 minutes' where event_id = '${live}'`);
  assert.ok((await plan()).deletes.some((row) => row.event_id === live && row.calendar_id === 'old@group.calendar.google.com'));
});
