import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, USERS, YEAR_2026 } from './helpers/fixture.mjs';

const EVENT = '22222222-0000-4000-a000-00000000a701';
const NEW_EVENT = '22222222-0000-4000-a000-00000000a702';
const MEMBER = '11111111-0000-4000-a000-000000000004';
const GBMS = 'c0000000-0000-4000-a000-000000000001';
const SOCIALS = 'c0000000-0000-4000-a000-000000000005';

const fields = (title, startsAt = '2026-09-30T22:00:00.000Z') => ({
  title,
  occurred_on: '2026-09-30',
  starts_at: startsAt,
  ends_at: '2026-10-01T00:00:00.000Z',
  term_id: null,
  checkin_closes_at: '2026-10-01T00:30:00.000Z',
});

const categories = (gbmCredit = 2) => [
  { category_id: GBMS, credit_mode: 'fixed', fixed_credit: gbmCredit },
  { category_id: SOCIALS, credit_mode: 'fixed', fixed_credit: 1 },
];
const evidence = { kind: 'shirt_photo', prompt: 'Event photo' };

let db;

async function save({
  eventId = EVENT,
  eventFields,
  eventCategories = categories(),
  eventEvidence = evidence,
  expectedVersion = null,
  create = false,
}) {
  return db.val(
    `select save_event_config($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::bigint, $7)`,
    [
      eventId,
      YEAR_2026,
      JSON.stringify(eventFields),
      JSON.stringify(eventCategories),
      eventEvidence == null ? null : JSON.stringify(eventEvidence),
      expectedVersion,
      create,
    ],
  );
}

async function snapshot() {
  const event = await db.one(
    `select title, starts_at, config_version from events where id = $1`,
    [EVENT],
  );
  const eventCategories = await db.q(
    `select category_id, credit_mode, fixed_credit
       from event_categories where event_id = $1 order by category_id`,
    [EVENT],
  );
  const eventEvidence = await db.q(
    `select kind, prompt from event_evidence_requirements where event_id = $1 order by kind`,
    [EVENT],
  );
  const points = Number(
    await db.val(`select coalesce(sum(credit), 0) from v_attendance_credit where event_id = $1`, [EVENT]),
  );
  return { event, eventCategories, eventEvidence, points };
}

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
});

test.beforeEach(async () => {
  await db.asOwner();
});

test.after(async () => {
  await db.close();
});

test('one event RPC commits fields, categories and evidence together', async () => {
  await db.as('authenticated', USERS.officer);
  const result = await save({ eventFields: fields('Atomic Event'), create: true });
  await db.asOwner();

  assert.equal(result.id, EVENT);
  assert.equal(Number(result.config_version), 1);
  const state = await snapshot();
  assert.equal(state.event.title, 'Atomic Event');
  assert.equal(Number(state.event.config_version), 1);
  assert.equal(state.eventCategories.length, 2);
  assert.equal(state.eventEvidence.length, 1);
});

test('same-id create retries serialize before the missing-row lookup and remain idempotent', async () => {
  const source = String(
    await db.val(
      `select pg_get_functiondef(
         'save_event_config(uuid,uuid,jsonb,jsonb,jsonb,bigint,boolean)'::regprocedure
       )`,
    ),
  ).toLowerCase();
  const lockAt = source.indexOf('pg_advisory_xact_lock');
  const eventLookupAt = source.indexOf('select * into v_event from events');
  assert.ok(lockAt >= 0, 'same-id creates have no transaction advisory lock');
  assert.ok(eventLookupAt >= 0, 'the locked event lookup was not found');
  assert.ok(lockAt < eventLookupAt, 'the event lookup can run before the same-id create lock');

  await db.as('authenticated', USERS.officer);
  const result = await save({ eventFields: fields('Changed Retry Body'), create: true });
  await db.asOwner();

  assert.equal(result.id, EVENT);
  assert.equal(Number(result.config_version), 1);
  assert.equal(Number(await db.val(`select count(*) from events where id = $1`, [EVENT])), 1);
  assert.equal(await db.val(`select title from events where id = $1`, [EVENT]), 'Atomic Event');
});

test('a late configuration error rolls the event and derived points back', async () => {
  await db.q(
    `insert into attendance_records (event_id, member_id, status, source)
     values ($1, $2, 'approved', 'officer_entry')`,
    [EVENT, MEMBER],
  );
  const before = await snapshot();
  assert.equal(before.points, 3);

  await db.as('authenticated', USERS.officer);
  const error = await db.expectError(
    `select save_event_config($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::bigint, false)`,
    [
      EVENT,
      YEAR_2026,
      JSON.stringify(fields('Must Roll Back')),
      JSON.stringify(categories(9)),
      JSON.stringify({ kind: 'not_a_kind', prompt: 'Invalid after category replacement' }),
      1,
    ],
  );
  await db.asOwner();
  assert.equal(error.code, 'PDS03');
  assert.deepEqual(await snapshot(), before);
});

test('a title and time edit preserves an archived link and approved credit', async () => {
  await db.q(`update categories set archived_at = now() where id = $1`, [SOCIALS]);

  await db.as('authenticated', USERS.officer);
  const result = await save({
    eventFields: fields('Retired Link Preserved', '2026-09-30T22:30:00.000Z'),
    expectedVersion: 1,
  });
  await db.asOwner();

  assert.equal(Number(result.config_version), 2);
  const state = await snapshot();
  assert.equal(state.event.title, 'Retired Link Preserved');
  assert.equal(new Date(state.event.starts_at).toISOString(), '2026-09-30T22:30:00.000Z');
  assert.equal(Number(state.event.config_version), 2);
  assert.equal(state.eventCategories.length, 2);
  assert.equal(state.points, 3);
});

test('an archived link cannot be changed or added to a new event', async () => {
  const before = await snapshot();
  await db.as('authenticated', USERS.officer);
  const changed = await db.expectError(
    `select save_event_config($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, 2, false)`,
    [
      EVENT,
      YEAR_2026,
      JSON.stringify(fields('No Archived Change')),
      JSON.stringify([
        { category_id: GBMS, credit_mode: 'fixed', fixed_credit: 2 },
        { category_id: SOCIALS, credit_mode: 'fixed', fixed_credit: 2 },
      ]),
      JSON.stringify(evidence),
    ],
  );
  const added = await db.expectError(
    `select save_event_config($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, null, true)`,
    [NEW_EVENT, YEAR_2026, JSON.stringify(fields('No Archived Add')), JSON.stringify(categories()), null],
  );
  await db.asOwner();

  assert.equal(changed.code, 'PDS03');
  assert.equal(added.code, 'PDS03');
  assert.deepEqual(await snapshot(), before);
  assert.equal(Number(await db.val(`select count(*) from events where id = $1`, [NEW_EVENT])), 0);
});

test('two stale snapshots cannot overwrite event configuration', async () => {
  await db.as('authenticated', USERS.officer);
  const first = await save({
    eventFields: fields('First Save Wins'),
    eventCategories: categories(4),
    expectedVersion: 2,
  });
  assert.equal(Number(first.config_version), 3);

  const stale = await db.expectError(
    `select save_event_config($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, 2, false)`,
    [
      EVENT,
      YEAR_2026,
      JSON.stringify(fields('Stale Save')),
      JSON.stringify(categories(8)),
      null,
    ],
  );
  await db.asOwner();

  assert.equal(stale.code, 'PDS15');
  const state = await snapshot();
  assert.equal(state.event.title, 'First Save Wins');
  assert.equal(Number(state.event.config_version), 3);
  assert.equal(state.eventEvidence[0].prompt, 'Event photo');
  assert.equal(state.points, 5, 'fixed-credit changes remain intentionally retroactive');
});

test('attendance prevents changing the submission-credit category set', async () => {
  const before = await snapshot();
  await db.as('authenticated', USERS.officer);
  const error = await db.expectError(
    `select save_event_config($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, 3, false)`,
    [
      EVENT,
      YEAR_2026,
      JSON.stringify(fields('Unsafe Transition')),
      JSON.stringify([
        { category_id: GBMS, credit_mode: 'from_submission', fixed_credit: null },
        { category_id: SOCIALS, credit_mode: 'fixed', fixed_credit: 1 },
      ]),
      JSON.stringify(evidence),
    ],
  );
  await db.asOwner();

  assert.equal(error.code, 'PDS03');
  assert.deepEqual(await snapshot(), before);
});

test('direct child configuration writes also invalidate stale snapshots', async () => {
  await db.q(
    `update event_categories set fixed_credit = 5 where event_id = $1 and category_id = $2`,
    [EVENT, GBMS],
  );
  const state = await snapshot();
  assert.equal(Number(state.event.config_version), 4);
  assert.equal(state.points, 6);
});

test('check-in takes a shared event lock and remains volatile', async () => {
  const source = await db.val(
    `select pg_get_functiondef('fn_checkin_event(text,boolean)'::regprocedure)`,
  );
  const volatility = await db.val(
    `select provolatile from pg_proc where oid = 'fn_checkin_event(text,boolean)'::regprocedure`,
  );
  assert.match(source, /for share/i);
  assert.equal(volatility, 'v');
});

test('anon cannot save event configuration', async () => {
  await db.as('anon');
  const error = await db.expectError(
    `select save_event_config($1, $2, $3::jsonb, $4::jsonb, null, 4, false)`,
    [EVENT, YEAR_2026, JSON.stringify(fields('No')), JSON.stringify(categories(5))],
  );
  await db.asOwner();
  assert.equal(error.code, '42501');
});
