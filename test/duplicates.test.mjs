// Duplicate people: finding the pairs, and not asking twice.
//
// The roster is the one thing the spreadsheet this replaces got right: 355
// names with zero duplicates. Members self-identify at events, including
// through a free-text "my name is not listed" path, so keeping that property
// is detection plus a memory of what an officer has already answered.
//
// The assertion this file exists for is the order-independence one. A
// dismissal of (a,b) must suppress (b,a), because a pair is an unordered
// thing and a uuid pair is not.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, EVENTS, MEMBERS, USERS, YEAR_2026 } from './helpers/fixture.mjs';
import { snapshotTables, restoreTables } from './helpers/settings.mjs';

let db;
let settings;

const D = (n) => `33333333-0000-4000-a000-0000000000${n}`;

const DUP = {
  abby: D('01'), // Abby Catto,    the worked example throughout the docs
  abigail: D('02'), // Abigail Catto
  abbi: D('03'), // Abbi Catto,    a third variant, so a merge can be watched
  aaron: D('04'), // Aaron Ozan,   nothing like anybody
  priya: D('05'), // Priya Raman,  same inbox as Rita, nothing like her name
  rita: D('06'), // Rita Solano
  ghost: D('07'), // Abbey Catto,  archived
  cato: D('08'), // Abby Cato,     a surname typo, caught by whole-name only
};

// Every pair the detector should find in this cast, whichever way round the
// caller asks about it.
async function pairOf(a, b) {
  const rows = await db.q(
    `select * from v_possible_duplicate_members
     where (member_a = $1 and member_b = $2) or (member_a = $2 and member_b = $1)`,
    [a, b],
  );
  return rows;
}

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  await db.exec(`
    insert into members (id, first_name, last_name, email, archived_at) values
      ('${DUP.abby}',    'Abby',    'Catto',  'abby.catto@ucf.edu',      null),
      ('${DUP.abigail}', 'Abigail', 'Catto',  'abigail@knights.ucf.edu', null),
      ('${DUP.abbi}',    'Abbi',    'Catto',  'abbi.catto@ucf.edu',      null),
      ('${DUP.aaron}',   'Aaron',   'Ozan',   'aaron@ucf.edu',           null),
      ('${DUP.priya}',   'Priya',   'Raman',  'priya.raman@ucf.edu',     null),
      ('${DUP.rita}',    'Rita',    'Solano', 'priyaraman@ucf.edu',      null),
      ('${DUP.ghost}',   'Abbey',   'Catto',  'abbey@ucf.edu',           now()),
      ('${DUP.cato}',    'Abby',    'Cato',   null,                      null);

    insert into member_enrollments (member_id, academic_year_id, joined_on) values
      ('${DUP.abby}',    '${YEAR_2026}', date '2026-01-15'),
      ('${DUP.abigail}', '${YEAR_2026}', date '2025-08-20'),
      ('${DUP.abbi}',    '${YEAR_2026}', date '2026-02-01'),
      ('${DUP.aaron}',   '${YEAR_2026}', date '2026-01-15'),
      ('${DUP.priya}',   '${YEAR_2026}', date '2026-01-15'),
      ('${DUP.rita}',    '${YEAR_2026}', date '2026-01-15');

    insert into attendance_records (event_id, member_id, status, source) values
      ('${EVENTS.gbmSingle}', '${DUP.abby}',    'approved', 'self_checkin'),
      ('${EVENTS.gbmBlock}',  '${DUP.abigail}', 'approved', 'officer_entry'),
      ('${EVENTS.clinA}',     '${DUP.abigail}', 'approved', 'officer_entry'),
      ('${EVENTS.nonClin}',   '${DUP.abigail}', 'rejected', 'self_checkin');
  `);

  settings = await snapshotTables(db, ['app_settings']);
});

// A failing assertion can leave the connection inside `set role`, and a test
// that lowers a threshold must not leave it lowered for the next one.
test.beforeEach(async () => {
  await db?.asOwner();
});

test.afterEach(async () => {
  await db?.asOwner();
  await restoreTables(db, settings);
});

test.after(async () => {
  await db?.close();
});

test('Abby Catto and Abigail Catto surface as a pair', async () => {
  const rows = await pairOf(DUP.abby, DUP.abigail);
  assert.equal(rows.length, 1);

  const pair = rows[0];
  assert.equal(pair.reason, 'close_name');
  assert.ok(Number(pair.score) > 0.4, `score was ${pair.score}`);
  assert.deepEqual(
    [pair.display_a, pair.display_b].sort(),
    ['Abby Catto', 'Abigail Catto'],
  );
});

test('the pair carries what an officer picks the survivor on', async () => {
  const [pair] = await pairOf(DUP.abby, DUP.abigail);

  // member_a is the lower uuid, which is Abby.
  assert.equal(pair.member_a, DUP.abby);
  assert.equal(pair.display_a, 'Abby Catto');
  assert.equal(pair.email_a, 'abby.catto@ucf.edu');
  assert.equal(pair.email_b, 'abigail@knights.ucf.edu');

  // Every attendance row counts, whatever its status, because that is what
  // merge_members would move: Abigail has two approved and one rejected.
  assert.equal(pair.records_a, 1);
  assert.equal(pair.records_b, 3);

  assert.equal(pair.joined_a.toISOString().slice(0, 10), '2026-01-15');
  assert.equal(pair.joined_b.toISOString().slice(0, 10), '2025-08-20');
});

test('two clearly different people do not surface', async () => {
  assert.deepEqual(await pairOf(MEMBERS.ada, MEMBERS.barnaby), []);
  assert.deepEqual(await pairOf(DUP.aaron, DUP.abigail), []);
  assert.deepEqual(await pairOf(DUP.aaron, MEMBERS.ada), []);

  // Nobody in the ten-member fixture resembles anybody else in it.
  const fixtureIds = Object.values(MEMBERS);
  const rows = await db.q(
    `select count(*)::int as n from v_possible_duplicate_members
     where member_a = any($1) and member_b = any($1)`,
    [fixtureIds],
  );
  assert.equal(rows[0].n, 0);
});

test('a pair appears exactly once, in canonical uuid order', async () => {
  const rows = await db.q(`
    select member_a, member_b from v_possible_duplicate_members
  `);
  assert.ok(rows.length > 0, 'the cast should produce some pairs');

  const seen = new Set();
  for (const r of rows) {
    assert.ok(r.member_a < r.member_b, `${r.member_a} should sort before ${r.member_b}`);
    const key = [r.member_a, r.member_b].sort().join('|');
    assert.equal(seen.has(key), false, `pair ${key} appeared twice`);
    seen.add(key);
  }

  // Abby matches Abigail on the name, and would also match her on the
  // surname-and-initial rule. One row, one reason.
  assert.equal((await pairOf(DUP.abby, DUP.abigail)).length, 1);
});

test('an archived member never appears', async () => {
  const rows = await db.q(
    `select count(*)::int as n from v_possible_duplicate_members
     where member_a = $1 or member_b = $1`,
    [DUP.ghost],
  );
  assert.equal(rows[0].n, 0);

  // And is genuinely similar enough that only the archive is keeping it out.
  const sim = await db.val(`select similarity('Abbey Catto', 'Abigail Catto')`);
  assert.ok(sim > 0.4, `Abbey/Abigail similarity was ${sim}`);
});

test('an exact email match ranks above a mere name similarity', async () => {
  const [email] = await pairOf(DUP.priya, DUP.rita);
  assert.equal(email.reason, 'exact_email');
  assert.equal(Number(email.score), 1);

  // The two names have nothing in common: the address is the whole signal.
  const sim = await db.val(`select similarity('Priya Raman', 'Rita Solano')`);
  assert.ok(sim < 0.2, `Priya/Rita name similarity was ${sim}`);

  const rows = await db.q(`select reason, score from v_possible_duplicate_members`);
  const exact = rows.filter((r) => r.reason === 'exact_email').map((r) => Number(r.score));
  const close = rows.filter((r) => r.reason === 'close_name').map((r) => Number(r.score));
  assert.ok(exact.length > 0 && close.length > 0);
  assert.ok(Math.min(...exact) > Math.max(...close));

  // The view hands the UI its ranking already applied.
  assert.equal(rows[0].reason, 'exact_email');
});

test('anon cannot dismiss a pair', async () => {
  await db.as('anon');
  const anon = await db.expectError(`select dismiss_duplicate_pair($1, $2)`, [
    DUP.priya,
    DUP.rita,
  ]);
  await db.asOwner();
  assert.equal(anon.code, '42501');

  assert.equal(await db.val(`select count(*)::int from member_duplicate_dismissals`), 0);
});

test('a signed-in shared session needs no profile to read pairs', async () => {
  await db.exec(`
    insert into auth.users (id, email)
    values ('99999999-0000-4000-a000-0000000000f9', 'officers@pdsaucf.com')
    on conflict do nothing;
  `);

  await db.as('authenticated', '99999999-0000-4000-a000-0000000000f9');
  const pairs = await db.q(`select * from fn_duplicate_member_pairs()`);
  await db.asOwner();

  assert.ok(pairs.length > 0);
});

test('the shared session reads duplicate pairs, and anon cannot read the view', async () => {
  await db.as('authenticated', USERS.officer);
  const own = await db.q(`select * from v_possible_duplicate_members`);
  await db.asOwner();
  assert.ok(own.length > 0);

  await db.as('anon');
  const err = await db.expectError(`select * from v_possible_duplicate_members`);
  await db.asOwner();
  assert.equal(err.code, '42501');
});

// The view is a security_invoker view over a SECURITY DEFINER function, so the
// function is the thing that must not be reachable. Reading the roster through
// it would leak every name and address on it.
test('anon cannot reach the detector behind the view', async () => {
  await db.as('anon');
  const err = await db.expectError(`select * from fn_duplicate_member_pairs()`);
  await db.asOwner();
  assert.equal(err.code, '42501');

  // Postgres creates a function with EXECUTE granted to PUBLIC (grantee 0),
  // and migration 11's blanket revoke ran before these functions existed. Any
  // of them left with a PUBLIC grant is reachable by anon.
  const leaky = await db.q(`
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join lateral aclexplode(p.proacl) a on a.grantee = 0
    where n.nspname = 'public'
      and p.proname in ('dismiss_duplicate_pair', 'fn_duplicate_member_pairs',
                        'fn_normalise_email', 'fn_normalise_nid')
      and (p.proacl is null or a.grantee is not null)
    order by p.proname
  `);
  assert.deepEqual(leaky, [], 'these functions still grant EXECUTE to PUBLIC');
});

test('nobody can write the dismissal table directly', async () => {
  await db.as('authenticated', USERS.officer);
  const err = await db.expectError(
    `insert into member_duplicate_dismissals (member_a, member_b) values ($1, $2)`,
    [DUP.priya, DUP.rita],
  );
  await db.asOwner();
  assert.equal(err.code, '42501');
});

test('the table refuses a pair stored in the wrong order', async () => {
  const err = await db.expectError(
    `insert into member_duplicate_dismissals (member_a, member_b) values ($1, $2)`,
    [DUP.rita, DUP.priya], // deliberately the higher uuid first
  );
  assert.equal(err.code, '23514');
  assert.equal(err.constraint, 'member_duplicate_dismissals_canonical');
});

test('dismissing (a,b) also suppresses (b,a)', async () => {
  assert.equal((await pairOf(DUP.priya, DUP.rita)).length, 1);

  // Called with the arguments the other way round from how the view returns
  // them. This is the whole test: if the pair were keyed on argument order,
  // the row below would be stored reversed and the pair would come straight
  // back.
  await db.withRole('authenticated', USERS.officer, async () => {
    await db.q(`select dismiss_duplicate_pair($1, $2)`, [DUP.rita, DUP.priya]);
  });

  assert.deepEqual(await pairOf(DUP.priya, DUP.rita), []);
  assert.deepEqual(await pairOf(DUP.rita, DUP.priya), []);

  const stored = await db.one(`select * from member_duplicate_dismissals`);
  assert.ok(stored.member_a < stored.member_b);
  assert.equal(stored.dismissed_by, USERS.officer);

  // Idempotent, and dismissing it again the original way round changes
  // nothing.
  await db.withRole('authenticated', USERS.officer, async () => {
    await db.q(`select dismiss_duplicate_pair($1, $2)`, [DUP.priya, DUP.rita]);
  });
  assert.equal(await db.val(`select count(*)::int from member_duplicate_dismissals`), 1);
  assert.deepEqual(await pairOf(DUP.priya, DUP.rita), []);

  // It is auditable.
  const audit = await db.one(
    `select * from audit_log where action = 'dismiss_duplicate_pair' order by id desc limit 1`,
  );
  assert.equal(audit.actor_user_id, USERS.officer);

  await db.q(`delete from member_duplicate_dismissals`);
});

test('dismiss_duplicate_pair refuses nonsense', async () => {
  await db.as('authenticated', USERS.officer);
  const same = await db.expectError(`select dismiss_duplicate_pair($1, $1)`, [DUP.priya]);
  const unknown = await db.expectError(`select dismiss_duplicate_pair($1, $2)`, [
    DUP.priya,
    '33333333-0000-4000-a000-0000000000ff',
  ]);
  await db.asOwner();

  assert.equal(same.code, 'PDS03');
  assert.equal(unknown.code, 'PDS03');
});

test('both thresholds are settings, and the whole-name one has a floor', async () => {
  // Abby Cato is a surname typo, so only the whole-name rule can catch it.
  assert.equal((await pairOf(DUP.abby, DUP.cato)).length, 1);

  await db.q(`update app_settings set value = '0.9'::jsonb where key = 'duplicate_person_similarity'`);
  assert.deepEqual(await pairOf(DUP.abby, DUP.cato), []);
  // The surname-and-initial rule is a separate row, so it still fires.
  assert.equal((await pairOf(DUP.abby, DUP.abigail)).length, 1);

  await db.q(
    `update app_settings set value = '0.9'::jsonb where key = 'duplicate_person_variant_similarity'`,
  );
  assert.deepEqual(await pairOf(DUP.abby, DUP.abigail), []);

  // Dropping the whole-name bar below the trigram prefilter clamps to 0.30
  // rather than quietly handing the prefilter the decision.
  await db.q(
    `update app_settings set value = '0.01'::jsonb where key = 'duplicate_person_similarity'`,
  );
  const sim = await db.val(`select similarity('Aaron Ozan', 'Abigail Catto')`);
  assert.ok(sim < 0.3, `Aaron/Abigail similarity was ${sim}`);
  assert.deepEqual(await pairOf(DUP.aaron, DUP.abigail), []);
});

// Last, because it tombstones a member.
test('after merge_members the pair is gone and the survivor holds both records', async () => {
  const before = await pairOf(DUP.abby, DUP.abigail);
  assert.equal(before.length, 1);
  assert.equal(before[0].records_a, 1);
  assert.equal(before[0].records_b, 3);

  await db.withRole('authenticated', USERS.officer, async () => {
    await db.q(`select merge_members($1, $2)`, [DUP.abby, DUP.abigail]);
  });

  assert.deepEqual(await pairOf(DUP.abby, DUP.abigail), []);

  // Abby is a tombstone now, so she is not a candidate against anybody,
  // including the third variant she matched before the merge.
  assert.equal((await pairOf(DUP.abby, DUP.abbi)).length, 0);
  const anywhere = await db.q(
    `select count(*)::int as n from v_possible_duplicate_members
     where member_a = $1 or member_b = $1`,
    [DUP.abby],
  );
  assert.equal(anywhere[0].n, 0);

  // The survivor still pairs with the third variant, so the merge removed a
  // member and not the detection.
  assert.equal((await pairOf(DUP.abigail, DUP.abbi)).length, 1);

  const survivor = await db.one(
    `select count(*)::int as n from attendance_records where member_id = $1`,
    [DUP.abigail],
  );
  assert.equal(survivor.n, 4);
  assert.equal(
    await db.val(`select count(*)::int from attendance_records where member_id = $1`, [DUP.abby]),
    0,
  );
});
