// Event sign-ups: docs/09-event-signups.md.
//
// Properties this suite exists to catch:
//
//   A SIGN-UP HOLDS ITS SPOT AT ONCE AND SENDS NOTHING. portal_signup_submit()
//   ranks the sign-up and returns when its email goes out, and never an
//   address or a token.
//
//   A MEMBER IS ALWAYS EMAILED AT THE ROSTER ADDRESS. Whatever address was
//   typed beside a member's name, the scheduled email goes to the one on
//   file. A guest typing a roster member's address becomes that member.
//
//   MEMBERS ONLY MEANS THIS YEAR'S ACTIVE ROSTER.
//
//   THE RAW TOKEN NEVER REACHES ANON. signup_due_emails() is service_role
//   only, and claims each due email once.
//
//   NOT CONFIRMING DROPS THE SIGN-UP, AND THE WAITLIST MOVES UP. Computed,
//   with no job: a held sign-up past confirm_by is out of line.
//
//   NO SIGN-UP BEFORE THE DROP. A queued event cannot be signed up for.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, USERS, YEAR_2026 } from './helpers/fixture.mjs';
import { DEFAULT_BODY, DEFAULT_SUBJECT, renderEmail } from '../web/src/signup-email.js';

let db;

const SHARED_ADMIN = USERS.officer; // the shared officers@pdsaucf.com admin session
const EVENT = '22222222-0000-4000-a000-00000000f501';
const QUEUED = '22222222-0000-4000-a000-00000000f502';
const Q_YEAR = '33333333-0000-4000-a000-00000000f501';
const Q_SHIRT = '33333333-0000-4000-a000-00000000f502';
const Q_DIET = '33333333-0000-4000-a000-00000000f503';

const anon = (sql, params = []) => db.withRole('anon', null, () => db.val(sql, params));
const service = (sql, params = []) => db.withRole('service_role', null, () => db.val(sql, params));
const officer = (sql, params = []) => db.withRole('authenticated', SHARED_ADMIN, () => db.val(sql, params));
const anonError = (sql, params = []) => db.withRole('anon', null, () => db.expectError(sql, params));

const submit = ({ event = EVENT, member = null, name = null, email = null, answers = {} } = {}) =>
  anon(`select portal_signup_submit($1, $2, $3, $4, $5)`, [event, member, name, email, answers]);

const FORM = {
  enabled: true,
  members_only: false,
  capacity: 2,
  closes_at: null,
  email_days_before: 2,
  email_time: '18:00',
  confirm_hours: 24,
  questions: [
    { id: Q_YEAR, kind: 'single_choice', prompt: 'Year', required: true, options: ['Freshman', 'Senior', 'Freshman', ' '] },
    { id: Q_SHIRT, kind: 'multi_choice', prompt: 'Shirt', required: false, options: ['S', 'M', 'L'] },
    { id: Q_DIET, kind: 'short_text', prompt: 'Dietary needs', required: false },
  ],
};

async function saveForm(eventId, form, { title = 'Signup Clinic' } = {}) {
  const version = await db.val(`select config_version from events where id = $1`, [eventId]);
  return officer(`select save_event($1,$2,$3,$4,null,$5,false,$6)`, [
    eventId, YEAR_2026, { title, occurred_on: await db.val(`select (current_date + 5)::text`) },
    [], version, form,
  ]);
}

/** A fresh visible event with the form on. */
async function makeEvent(id, { capacity = null, membersOnly = false, daysOut = 3, daysBefore = 2 } = {}) {
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, starts_at, ends_at, checkin_token,
                        is_published, signups_enabled, signup_capacity, members_only,
                        signup_email_days_before, location)
    values ('${id}', '${YEAR_2026}', 'Event ${id.slice(-4)}', current_date + ${daysOut},
            (current_date + ${daysOut} + time '18:00') at time zone 'America/New_York',
            (current_date + ${daysOut} + time '20:00') at time zone 'America/New_York',
            'tok-${id.slice(-4)}', true, true, ${capacity ?? 'null'}, ${membersOnly}, ${daysBefore},
            'HPA II');
  `);
}

const signupId = (eventId, memberId) =>
  db.val(`select id from event_signups where event_id = $1 and member_id = $2`, [eventId, memberId]);
const stateOf = (id) => db.one(`select state, waitlist_position, reply from v_event_signups where id = $1`, [id]);
const dueEmails = () => service(`select signup_due_emails(100)`);
/** What the Edge Function does after Resend accepts an email. */
const acknowledge = (rows) =>
  Promise.all(rows.map((row) => service(`select signup_email_sent($1, $2)`, [row.signup_id, row.delivery_id])));

// The rate limiter is per calendar minute; each test starts clean.
const clearLimits = () => db.exec(`delete from rpc_call_counters`);

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
  await db.exec(`
    update members set email = 'ada@example.test' where id = '${MEMBERS.ada}';
    update members set email = 'barnaby@example.test' where id = '${MEMBERS.barnaby}';
    update members set email = 'cressida@example.test' where id = '${MEMBERS.cressida}';
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${EVENT}', '${YEAR_2026}', 'Signup Clinic', current_date + 5, 'tok-f501', true),
           ('${QUEUED}', '${YEAR_2026}', 'Queued Clinic', current_date + 40, 'tok-f502', false);
  `);
  await saveForm(EVENT, FORM);
});

test.beforeEach(async () => {
  await db?.asOwner();
  await clearLimits();
});

test.after(async () => {
  await db?.close();
});

test('save_event writes the form and the email settings with the event in one revision', async () => {
  const event = await db.one(
    `select signups_enabled, signup_capacity, signup_email_days_before,
            signup_email_time::text as email_time, signup_email_subject
     from events where id = $1`,
    [EVENT],
  );
  assert.equal(event.signups_enabled, true);
  assert.equal(event.signup_capacity, 2);
  assert.equal(event.signup_email_days_before, 2);
  assert.equal(event.email_time, '18:00:00');
  assert.equal(event.signup_email_subject, null, 'a blank subject is the default');
  const questions = await db.q(
    `select id, options from event_signup_questions where event_id = $1 order by position`,
    [EVENT],
  );
  assert.deepEqual(questions.map((q) => q.id), [Q_YEAR, Q_SHIRT, Q_DIET]);
  assert.deepEqual(questions[0].options, ['Freshman', 'Senior'], 'blank and repeated choices kept');

  // The default typed out word for word stores as the default.
  await saveForm(EVENT, { ...FORM, email_subject: DEFAULT_SUBJECT, email_body: DEFAULT_BODY });
  assert.equal(await db.val(`select signup_email_body from events where id = $1`, [EVENT]), null);
  await saveForm(EVENT, { ...FORM, email_subject: 'See you {name}' });
  assert.equal(await db.val(`select signup_email_subject from events where id = $1`, [EVENT]), 'See you {name}');
  await saveForm(EVENT, FORM);

  const version = await db.val(`select config_version from events where id = $1`, [EVENT]);
  const stale = await db.withRole('authenticated', SHARED_ADMIN, () => db.expectError(
    `select save_event($1,$2,$3,'[]'::jsonb,null,$4,false,$5)`,
    [EVENT, YEAR_2026, { title: 'Stale', occurred_on: '2026-12-01' }, Number(version) - 1,
     { ...FORM, capacity: 99 }],
  ));
  assert.equal(stale.code, 'PDS15');
  assert.equal(await db.val(`select signup_capacity from events where id = $1`, [EVENT]), 2);
});

test('the email defaults and rendering match the form preview', async () => {
  assert.equal(await db.val(`select fn_signup_email_default_subject()`), DEFAULT_SUBJECT);
  assert.equal(await db.val(`select fn_signup_email_default_body()`), DEFAULT_BODY);
  const event = '22222222-0000-4000-a000-00000000f518';
  await makeEvent(event);
  await db.exec(`update events set occurred_on = '2026-10-07', starts_at = '2026-10-07T22:00:00Z',
                 ends_at = '2026-10-08T00:00:00Z' where id = '${event}'`);
  const confirmBy = '2026-10-06T22:00:00Z';
  const sql = await db.val(
    `select fn_signup_email_render($1, 'Ada Lovelace', e, $2::timestamptz) from events e where id = $3`,
    [DEFAULT_BODY, confirmBy, event],
  );
  const row = await db.one(`select title, location from events where id = $1`, [event]);
  const js = renderEmail(DEFAULT_BODY, {
    name: 'Ada Lovelace',
    event: { ...row, occurred_on: '2026-10-07', starts_at: '2026-10-07T22:00:00Z', ends_at: '2026-10-08T00:00:00Z' },
    confirmBy,
  });
  assert.equal(js, sql);
  assert.match(sql, /on Wednesday, October 7, 6:00 PM to 8:00 PM, at HPA II/);
  assert.match(sql, /Confirm by Tuesday, October 6, 6:00 PM/);
});

test('only officers can save a form or read sign-ups, and only service_role mints tokens', async () => {
  const refused = await anonError(
    `select save_event($1,$2,$3,'[]'::jsonb,null,1,false,$4)`,
    [EVENT, YEAR_2026, { title: 'x', occurred_on: '2026-12-01' }, FORM],
  );
  assert.equal(refused.code, '42501');
  assert.equal((await anonError(`select * from event_signups`)).code, '42501');
  assert.equal((await anonError(`select signup_due_emails(10)`)).code, '42501');
  const officerDue = await db.withRole('authenticated', SHARED_ADMIN, () => db.expectError(`select signup_due_emails(10)`));
  assert.equal(officerDue.code, '42501');
});

test('a sign-up holds a spot at once and returns no address or token', async () => {
  const event = '22222222-0000-4000-a000-00000000f511';
  await makeEvent(event, { daysOut: 10 });
  const answer = await submit({ event, member: MEMBERS.ada, email: 'attacker@example.test' });
  assert.deepEqual(Object.keys(answer).sort(), ['confirm_hours', 'email_at', 'is_member', 'state', 'waitlist_position']);
  assert.equal(answer.state, 'going');
  assert.ok(new Date(answer.email_at) > new Date(), 'the email is not scheduled ahead');
  assert.ok(!JSON.stringify(answer).includes('@'), 'the response carries an address');
  const stored = await db.one(`select email, status, token_hash from event_signups where event_id = $1`, [event]);
  assert.equal(stored.email, 'ada@example.test', 'the typed address replaced the roster one');
  assert.equal(stored.status, 'held');
  assert.equal(stored.token_hash, null);
});

test('a guest typing a roster address becomes that member', async () => {
  const answer = await submit({ name: 'Not Barnaby', email: 'BARNABY@example.test', answers: { [Q_YEAR]: 'Senior' } });
  assert.equal(answer.is_member, true);
  const name = await db.val(`select name from event_signups where event_id = $1 and member_id = $2`, [EVENT, MEMBERS.barnaby]);
  assert.notEqual(name, 'Not Barnaby');
});

test('a member without an address on file is told so', async () => {
  const err = await anonError(`select portal_signup_submit($1, $2, null, null, $3)`,
    [EVENT, MEMBERS.dorian, { [Q_YEAR]: 'Senior' }]);
  assert.equal(err.code, 'PDS20');
});

test('answers are checked against the questions', async () => {
  assert.equal((await anonError(
    `select portal_signup_submit($1, null, 'Gail Guest', 'gail@example.test', '{}'::jsonb)`, [EVENT],
  )).code, 'PDS03');
  assert.equal((await anonError(
    `select portal_signup_submit($1, null, 'Gail Guest', 'gail@example.test', $2)`, [EVENT, { [Q_YEAR]: 'Sophomore' }],
  )).code, 'PDS03');

  await submit({
    name: '  Gail   Guest ', email: 'gail@example.test',
    answers: { [Q_YEAR]: 'Freshman', [Q_SHIRT]: ['L', 'S'], [Q_DIET]: '  ', stray: 'dropped' },
  });
  const stored = await db.one(`select name, answers from event_signups where email = 'gail@example.test'`);
  assert.deepEqual(stored.answers, { [Q_YEAR]: 'Freshman', [Q_SHIRT]: ['S', 'L'] });
  assert.equal(stored.name, 'Gail Guest');
});

test('members only refuses guests and anybody off this years active roster', async () => {
  const event = '22222222-0000-4000-a000-00000000f512';
  await makeEvent(event, { membersOnly: true });
  assert.equal((await anonError(
    `select portal_signup_submit($1, null, 'Hal Guest', 'hal@example.test', '{}'::jsonb)`, [event],
  )).code, 'PDS17');
  await db.exec(`update members set email = 'imogen@example.test' where id = '${MEMBERS.imogen}';
                 update member_enrollments set status = 'inactive'
                 where member_id = '${MEMBERS.imogen}' and academic_year_id = '${YEAR_2026}'`);
  try {
    assert.equal((await anonError(
      `select portal_signup_submit($1, $2, null, null, '{}'::jsonb)`, [event, MEMBERS.imogen],
    )).code, 'PDS17');
  } finally {
    await db.exec(`update member_enrollments set status = 'active'
                   where member_id = '${MEMBERS.imogen}' and academic_year_id = '${YEAR_2026}'`);
  }
});

test('a queued event cannot be signed up for before it is released', async () => {
  await db.exec(`update events set signups_enabled = true where id = '${QUEUED}'`);
  assert.equal((await anonError(
    `select portal_signup_submit($1, $2, null, null, '{}'::jsonb)`, [QUEUED, MEMBERS.ada],
  )).code, 'PDS03');
});

test('spots rank by sign-up time, the email is claimed once, and a drop moves the waitlist up', async () => {
  const event = '22222222-0000-4000-a000-00000000f513';
  // Dated three days out with the email five days before: already due.
  await makeEvent(event, { capacity: 1, daysBefore: 5 });
  assert.equal((await submit({ event, member: MEMBERS.ada })).state, 'going');
  const second = await submit({ event, member: MEMBERS.barnaby });
  assert.deepEqual([second.state, second.waitlist_position], ['waitlist', 1]);
  assert.equal((await submit({ event, member: MEMBERS.cressida })).waitlist_position, 2);
  assert.equal((await anonError(`select portal_signup_submit($1, $2, null, null, '{}'::jsonb)`,
    [event, MEMBERS.barnaby])).code, 'PDS18');

  const counts = (await anon(`select portal_events()`)).events.find((row) => row.id === event).signups;
  assert.deepEqual([counts.going, counts.waitlist], [1, 2]);

  const title = `Event ${event.slice(-4)}`;
  const mine = (await dueEmails()).filter((row) => row.subject.includes(title));
  assert.deepEqual(mine.map((row) => row.email), ['ada@example.test', 'barnaby@example.test', 'cressida@example.test']);
  assert.match(mine[0].token, /^[0-9a-f]{48}$/);
  assert.equal(mine[0].subject, `Confirm your spot: ${title}`);
  assert.match(mine[0].body, /^Ada Testwood,/);
  assert.equal((await dueEmails()).filter((row) => row.subject.includes(title)).length, 0,
    'a second run sent the same emails again');

  await acknowledge(mine);
  const token = Object.fromEntries(mine.map((row) => [row.email, row.token]));
  const ada = await anon(`select portal_signup($1)`, [token['ada@example.test']]);
  assert.deepEqual([ada.state, ada.reply], ['going', 'awaiting']);
  assert.ok(!JSON.stringify(ada).includes('@'), 'the link view carries an address');
  assert.equal((await anon(`select portal_signup_confirm($1)`, [token['ada@example.test']])).reply, 'confirmed');
  assert.equal((await anon(`select portal_signup_confirm($1)`, [token['ada@example.test']])).reply, 'confirmed');

  // Barnaby lets the window pass: dropped, and Cressida moves up.
  const barnaby = await signupId(event, MEMBERS.barnaby);
  await db.exec(`update event_signups set confirm_by = now() - interval '1 minute' where id = '${barnaby}'`);
  assert.equal((await stateOf(barnaby)).state, 'dropped');
  assert.equal((await stateOf(await signupId(event, MEMBERS.cressida))).waitlist_position, 1);
  assert.equal((await anonError(`select portal_signup_confirm($1)`, [token['barnaby@example.test']])).code, 'PDS21');

  // Ada cancels: Cressida is going.
  assert.equal((await anon(`select portal_signup_cancel($1)`, [token['ada@example.test']])).state, 'cancelled');
  assert.equal((await stateOf(await signupId(event, MEMBERS.cressida))).state, 'going');

  // Dropped Barnaby signs up again, at the back of the line, with a new email to come.
  const again = await submit({ event, member: MEMBERS.barnaby });
  assert.deepEqual([again.state, again.waitlist_position], ['waitlist', 1]);
  assert.equal((await stateOf(barnaby)).reply, 'scheduled');

  // An event somebody signed up for is not empty.
  const del = await db.withRole('authenticated', SHARED_ADMIN, () =>
    db.expectError(`delete from events where id = $1`, [event]));
  assert.equal(del.code, '23001');
});

test('the confirm window never runs past the start of the event', async () => {
  const event = '22222222-0000-4000-a000-00000000f514';
  await makeEvent(event, { daysOut: 1, daysBefore: 2 });
  await db.exec(`update events set starts_at = now() + interval '2 hours', ends_at = now() + interval '3 hours'
                 where id = '${event}'`);
  await submit({ event, member: MEMBERS.ada });
  await acknowledge((await dueEmails()).filter((due) => due.email === 'ada@example.test'));
  const row = await db.one(`select s.confirm_by, e.starts_at from event_signups s join events e on e.id = s.event_id
                            where s.event_id = $1`, [event]);
  assert.equal(new Date(row.confirm_by).getTime(), new Date(row.starts_at).getTime());
});

test('a failed send goes back in the queue', async () => {
  const event = '22222222-0000-4000-a000-00000000f515';
  await makeEvent(event, { daysBefore: 5 });
  await submit({ event, name: 'Ivy Guest', email: 'ivy@example.test' });
  const [first] = (await dueEmails()).filter((row) => row.email === 'ivy@example.test');
  await service(`select signup_email_failed($1)`, [first.signup_id]);
  assert.equal((await anonError(`select portal_signup($1)`, [first.token])).code, 'PDS21');
  const [retry] = (await dueEmails()).filter((row) => row.email === 'ivy@example.test');
  assert.equal(retry.signup_id, first.signup_id);
  assert.notEqual(retry.token, first.token);
});

test('nothing is emailed before its time', async () => {
  const event = '22222222-0000-4000-a000-00000000f516';
  await makeEvent(event, { daysOut: 20, daysBefore: 2 });
  await submit({ event, name: 'Jo Guest', email: 'jo@example.test' });
  assert.equal((await dueEmails()).filter((row) => row.email === 'jo@example.test').length, 0);
  const view = await db.one(`select reply, email_at from v_event_signups where email = 'jo@example.test'`);
  assert.equal(view.reply, 'scheduled');
  assert.ok(new Date(view.email_at) > new Date());
});

test('closed sign-ups refuse submits', async () => {
  const event = '22222222-0000-4000-a000-00000000f517';
  await makeEvent(event);
  await db.exec(`update events set signup_closes_at = now() - interval '1 minute' where id = '${event}'`);
  assert.equal((await anonError(
    `select portal_signup_submit($1, null, 'Kai Guest', 'kai@example.test', '{}'::jsonb)`, [event],
  )).code, 'PDS19');
  const listed = (await anon(`select portal_events()`)).events.find((row) => row.id === event);
  assert.equal(listed.signups.open, false);
});

test('nothing anon reads carries an address, a name list or an answer', async () => {
  const answer = await anon(`select portal_events()`);
  const text = JSON.stringify(answer);
  assert.ok(!text.includes('@example.test'), 'portal_events leaked an address');
  assert.ok(!text.includes('Gail Guest'), 'portal_events leaked a sign-up name');
  const listed = answer.events.find((row) => row.id === EVENT);
  assert.deepEqual(Object.keys(listed.signups).sort(),
    ['capacity', 'closes_at', 'confirm_hours', 'email_at', 'email_days_before', 'going', 'open', 'questions', 'waitlist']);
});

test('a hand publish stamps published_at, which the New ribbon reads', async () => {
  const event = '22222222-0000-4000-a000-00000000f506';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token)
    values ('${event}', '${YEAR_2026}', 'Fresh Social', current_date + 30, 'tok-f506');
  `);
  await officer(`select set_event_published($1, true)`, [event]);
  assert.ok(await db.val(`select published_at from events where id = $1`, [event]));
  const listed = (await anon(`select portal_events()`)).events.find((row) => row.id === event);
  assert.ok(listed.released_at, 'released_at missing for a hand-published event');
  await officer(`select set_event_published($1, false)`, [event]);
  assert.equal(await db.val(`select published_at from events where id = $1`, [event]), null);
});

test('set_member_emails applies row by row', async () => {
  const result = await officer(`select set_member_emails($1)`, [[
    { member_id: MEMBERS.edda, email: 'edda@example.test' },
    { member_id: MEMBERS.fergus, email: 'ada@example.test' },
    { member_id: MEMBERS.greta, email: 'not an address' },
  ]]);
  assert.equal(result[0].email, 'edda@example.test');
  assert.equal(result[1].error, 'Email used by another member');
  assert.equal(result[2].error, 'Not an email address');
});

test('portal_member_names lists the active roster with ids and names only', async () => {
  const names = await anon(`select portal_member_names()`);
  assert.ok(names.length > 0);
  assert.deepEqual(Object.keys(names[0]).sort(), ['display_name', 'joined_on', 'member_id']);
  assert.ok(!JSON.stringify(names).includes('@example.test'));
});

test('an officer adds somebody by hand, confirmed and in line', async () => {
  const event = '22222222-0000-4000-a000-00000000f507';
  await makeEvent(event, { capacity: 1, membersOnly: true });
  await officer(`select add_event_signup($1, $2, null, null, '{}'::jsonb)`, [event, MEMBERS.dorian]);
  await officer(`select add_event_signup($1, null, 'Walk In', null, '{}'::jsonb)`, [event]);
  const rows = await db.q(
    `select state, reply, email from v_event_signups where event_id = $1 order by created_at`, [event]);
  assert.deepEqual(rows.map((r) => [r.state, r.reply]), [['going', 'confirmed'], ['waitlist', 'confirmed']]);
  assert.equal(rows[1].email, null);
  assert.equal((await db.withRole('authenticated', SHARED_ADMIN, () => db.expectError(
    `select add_event_signup($1, $2, null, null, '{}'::jsonb)`, [event, MEMBERS.dorian]))).code, 'PDS18');
  assert.equal((await anonError(`select add_event_signup($1, null, 'x', null, '{}'::jsonb)`, [event])).code, '42501');

  const removed = await db.val(`select id from event_signups where event_id = $1 and member_id = $2`, [event, MEMBERS.dorian]);
  await officer(`select remove_event_signup($1)`, [removed]);
  assert.equal((await db.one(`select state from v_event_signups where event_id = $1 and name = 'Walk In'`, [event])).state, 'going');
});

test('a claim whose run died is resent with the same token, and nothing drops before delivery', async () => {
  const event = '22222222-0000-4000-a000-00000000f519';
  await makeEvent(event, { daysBefore: 5 });
  await submit({ event, name: 'Lia Guest', email: 'lia@example.test' });
  const [first] = (await dueEmails()).filter((row) => row.email === 'lia@example.test');
  // The run dies here: no acknowledgement. Nothing counts as sent.
  const held = await db.one(`select emailed_at, confirm_by from event_signups where id = $1`, [first.signup_id]);
  assert.deepEqual([held.emailed_at, held.confirm_by], [null, null]);
  assert.equal((await dueEmails()).filter((row) => row.email === 'lia@example.test').length, 0,
    'a claim was handed out twice inside its lease');

  await db.exec(`update signup_deliveries set claimed_at = now() - interval '11 minutes'
                 where signup_id = '${first.signup_id}'`);
  const [again] = (await dueEmails()).filter((row) => row.email === 'lia@example.test');
  assert.equal(again.delivery_id, first.delivery_id, 'a reclaim is a different Resend send');
  assert.equal(again.token, first.token, 'a reclaim sent a different link');
  assert.equal(again.body, first.body);

  // Delivered, and the link was used before the acknowledgement landed.
  assert.equal((await anon(`select portal_signup_confirm($1)`, [first.token])).reply, 'confirmed');
  await acknowledge([again]);
  assert.equal(await db.val(`select count(*)::int from signup_deliveries where signup_id = $1`, [first.signup_id]), 0);
  assert.equal(await db.val(`select status from event_signups where id = $1`, [first.signup_id]), 'confirmed');
});

test('the token is never readable by an officer', async () => {
  const read = await db.withRole('authenticated', SHARED_ADMIN, () => db.expectError(`select token from signup_deliveries`));
  assert.equal(read.code, '42501');
});

test('a corrected roster address is the one emailed', async () => {
  const event = '22222222-0000-4000-a000-00000000f520';
  await makeEvent(event, { daysBefore: 5 });
  await db.exec(`update members set email = 'old-edda@example.test' where id = '${MEMBERS.edda}'`);
  await submit({ event, member: MEMBERS.edda });
  await db.exec(`update members set email = 'edda-fixed@example.test' where id = '${MEMBERS.edda}'`);
  const due = (await dueEmails()).filter((row) => row.signup_id === undefined || row.email.includes('edda'));
  assert.deepEqual(due.map((row) => row.email), ['edda-fixed@example.test']);
});

test('a retried create changes nothing saved since', async () => {
  const event = '22222222-0000-4000-a000-00000000f521';
  const form = { ...FORM, capacity: 10, members_only: false, questions: [] };
  const create = () => officer(`select save_event($1,$2,$3,'[]'::jsonb,null,null,true,$4)`, [
    event, YEAR_2026, { title: 'Replay Social', occurred_on: '2026-12-01' }, form,
  ]);
  await create();
  const version = await db.val(`select config_version from events where id = $1`, [event]);
  await officer(`select save_event($1,$2,$3,'[]'::jsonb,null,$4,false,$5)`, [
    event, YEAR_2026, { title: 'Replay Social', occurred_on: '2026-12-01' }, version,
    { ...form, capacity: 1, members_only: true },
  ]);
  // The first create's response was lost, and the browser retries it.
  await create();
  const row = await db.one(`select signup_capacity, members_only from events where id = $1`, [event]);
  assert.deepEqual([row.signup_capacity, row.members_only], [1, true]);
});

test('an email schedule that lands after the event starts is refused', async () => {
  const event = '22222222-0000-4000-a000-00000000f522';
  await makeEvent(event, { daysOut: 10 });
  const version = await db.val(`select config_version from events where id = $1`, [event]);
  const day = await db.val(`select (current_date + 10)::text`);
  const err = await db.withRole('authenticated', SHARED_ADMIN, () => db.expectError(
    `select save_event($1,$2,$3,'[]'::jsonb,null,$4,false,$5)`,
    [event, YEAR_2026, {
      title: 'Morning Clinic', occurred_on: day,
      starts_at: `${day}T13:00:00Z`, ends_at: `${day}T15:00:00Z`,
    }, version, { ...FORM, questions: [], email_days_before: 0, email_time: '18:00' }],
  ));
  assert.equal(err.code, 'PDS03');
  assert.match(err.message, /after the event starts/);
});

test('a resend after an edit is the email first sent, and an address collision blocks nobody', async () => {
  const event = '22222222-0000-4000-a000-00000000f523';
  await makeEvent(event, { daysBefore: 5 });
  await db.exec(`update members set email = 'wrong-fergus@example.test' where id = '${MEMBERS.fergus}'`);
  await submit({ event, member: MEMBERS.fergus });
  await submit({ event, name: 'Mo Guest', email: 'fergus@example.test' });
  // The roster is corrected to the guest's address.
  await db.exec(`update members set email = 'fergus@example.test' where id = '${MEMBERS.fergus}'`);
  const due = (await dueEmails()).filter((row) => row.email === 'fergus@example.test');
  assert.equal(due.length, 2, 'the run stopped on the collision');

  const [first] = due;
  await db.exec(`update events set title = 'Renamed' where id = '${event}';
                 update signup_deliveries set claimed_at = now() - interval '11 minutes'
                 where signup_id = '${first.signup_id}'`);
  const [again] = (await dueEmails()).filter((row) => row.signup_id === first.signup_id);
  assert.deepEqual([again.subject, again.body], [first.subject, first.body]);
});
