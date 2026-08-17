// Putting somebody on this year's roster, in one call.
//
// upsert_member_and_enroll() replaced two writes from the roster screen, an
// insert into members followed by an insert into member_enrollments. The gap
// between them was real: a connection that dropped after the first left a
// member row with no enrollment for the year, invisible on the roster and
// holding an email address the unique index would not hand to anybody else.
//
// So the assertions this file exists for are the two that make a re-run safe:
//
//   * the same row imported twice writes nothing the second time
//   * a member who exists from a previous year is ENROLLED, never written down
//     a second time, whether the officer confirmed the match in the preview or
//     the function had to find them itself
//
// WHAT FINDING THEM MEANS CHANGED IN MIGRATION 20. A member has no email
// address any more, so the tier that used to carry every re-run (email, then
// student id) matches nothing on a row nobody typed an address into. The name
// is the identity now, and it is the last tier: an officer's answer first, then
// an address or a student id if the row still carries one, then the normalised
// name among live members. The tests below drive all four.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, USERS, YEAR_2025, YEAR_2026 } from './helpers/fixture.mjs';

let db;

const R = (n) => `44444444-0000-4000-a000-0000000000${n}`;

const CAST = {
  returning: R('01'), // on 2025-2026 only, with an address
  quiet: R('02'), // on 2025-2026 only, a student id and no address
  gone: R('03'), // merged into survivor, and still holding its address
  survivor: R('04'),
  retired: R('05'), // archived, and not merged into anybody
};

// Nobody signed in has a profiles row, which is the case fn_is_officer()
// answers NULL for rather than false. See the guard in migration 15.
const NO_PROFILE = '99999999-0000-4000-a000-0000000000f9';

function upsert(
  { first, last, email = null, nid = null, year = YEAR_2026, matched = null },
  userId = USERS.officer,
) {
  return db.withRole('authenticated', userId, () =>
    db.val(`select upsert_member_and_enroll($1, $2, $3::citext, $4::citext, $5::uuid, $6::uuid)`, [
      first,
      last,
      email,
      nid,
      year,
      matched,
    ]),
  );
}

async function refuses(args, userId = USERS.officer) {
  await db.as('authenticated', userId);
  const err = await db.expectError(
    `select upsert_member_and_enroll($1, $2, $3::citext, $4::citext, $5::uuid, $6::uuid)`,
    [args.first, args.last, args.email ?? null, args.nid ?? null, args.year ?? YEAR_2026, args.matched ?? null],
  );
  await db.asOwner();
  return err;
}

const memberCount = () => db.val(`select count(*)::int from members`);
const yearsOf = (memberId) =>
  db.q(
    `select academic_year_id from member_enrollments where member_id = $1 order by academic_year_id`,
    [memberId],
  );

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  await db.exec(`
    insert into members (id, first_name, last_name, email, ucf_nid, merged_into_id, archived_at) values
      ('${CAST.returning}', 'Rosalind', 'Vance',        'rosalind.vance@ucf.edu', null,     null, null),
      ('${CAST.quiet}',     'Quintus',  'Ashgrove',     null,                     'qa2481', null, null),
      ('${CAST.survivor}',  'Tamsin',   'Redfern',      'tamsin.redfern@ucf.edu', null,     null, null),
      ('${CAST.gone}',      'Tam',      'Redfern',      'tam.redfern@ucf.edu',    null,     null, null),
      ('${CAST.retired}',   'Orla',     'Winterbourne', 'orla.w@ucf.edu',         null,     null, now());

    -- The tombstone merge_members() leaves: the loser keeps its address.
    update members set merged_into_id = '${CAST.survivor}', archived_at = now()
    where id = '${CAST.gone}';

    -- Last year only. These are the people this year's roster cannot see.
    insert into member_enrollments (member_id, academic_year_id, joined_on) values
      ('${CAST.returning}', '${YEAR_2025}', date '2025-08-19'),
      ('${CAST.quiet}',     '${YEAR_2025}', date '2025-08-19');

    insert into member_enrollments (member_id, academic_year_id) values
      ('${CAST.survivor}', '${YEAR_2026}');
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.afterEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('an officer creates somebody nobody had and enrolls them in one call', async () => {
  const before = await memberCount();

  const result = await upsert({
    first: 'Nkechi',
    last: 'Okorie',
    email: 'nkechi.okorie@ucf.edu',
  });

  assert.equal(result.was_created, true);
  assert.equal(result.was_enrolled, true);
  assert.equal(await memberCount(), before + 1);

  const member = await db.one(`select * from members where id = $1`, [result.member_id]);
  assert.equal(member.display_name, 'Nkechi Okorie');
  assert.equal(member.email, 'nkechi.okorie@ucf.edu');

  // The enrollment is the half that used to be able to go missing.
  assert.deepEqual(await yearsOf(result.member_id), [{ academic_year_id: YEAR_2026 }]);

  const audit = await db.one(
    `select * from audit_log where action = 'upsert_member_and_enroll' order by id desc limit 1`,
  );
  assert.equal(audit.actor_user_id, USERS.officer);
  assert.equal(audit.entity_id, result.member_id);
  assert.equal(audit.detail.was_created, true);
});

test('running the same row again writes nothing', async () => {
  const first = await upsert({ first: 'Idris', last: 'Kalu', email: 'idris.kalu@ucf.edu' });
  const before = await memberCount();

  const again = await upsert({ first: 'Idris', last: 'Kalu', email: 'idris.kalu@ucf.edu' });

  assert.equal(again.member_id, first.member_id);
  assert.equal(again.was_created, false);
  assert.equal(again.was_enrolled, false, 'enrolling somebody already enrolled was not a no-op');
  assert.equal(await memberCount(), before);
  assert.deepEqual(await yearsOf(first.member_id), [{ academic_year_id: YEAR_2026 }]);
});

test('a member from a previous year is enrolled, not written down twice', async () => {
  // THE FINDING. Nothing about this row is on this year's roster, so a caller
  // matching against this year's enrollments would file them as new. With an
  // address that is a unique-index collision, and without one it is a second
  // person for somebody the club already has.
  const before = await memberCount();

  const result = await upsert({
    first: 'Rosalind',
    last: 'Vance',
    email: 'rosalind.vance@ucf.edu',
  });

  assert.equal(result.member_id, CAST.returning);
  assert.equal(result.was_created, false, 'a returning member was created a second time');
  assert.equal(result.was_enrolled, true);
  assert.equal(await memberCount(), before);

  // On both years now. Last year's history is still theirs.
  assert.deepEqual(await yearsOf(CAST.returning), [
    { academic_year_id: YEAR_2025 },
    { academic_year_id: YEAR_2026 },
  ].sort((a, b) => a.academic_year_id.localeCompare(b.academic_year_id)));
});

test('the name finds somebody nothing else could identify', async () => {
  // THE FINDING FROM MIGRATION 20, and the reason the name tier exists at all.
  // Nothing collects an address, so this is what an import row now looks like:
  // two names and nothing else. Before the name tier, the second call created a
  // second Perpetua Lang, which is how re-importing a file after a dropped
  // response quietly doubled the roster.
  const first = await upsert({ first: 'Perpetua', last: 'Lang' });
  assert.equal(first.was_created, true);
  const before = await memberCount();

  const again = await upsert({ first: 'Perpetua', last: 'Lang', year: YEAR_2025 });

  assert.equal(again.member_id, first.member_id, 'the same name was written down twice');
  assert.equal(again.was_created, false);
  assert.equal(again.was_enrolled, true, 'the year did not get the enrollment it asked for');
  assert.equal(await memberCount(), before);
});

test('the name is matched the way a person reads it, punctuation and all', async () => {
  const made = await upsert({ first: 'Sinead', last: "O'Halloran" });
  const again = await upsert({ first: '  sinead ', last: 'o halloran' });
  assert.equal(again.member_id, made.member_id, 'case and punctuation made a second person');
  assert.equal(again.was_created, false);
});

test('a preferred name on the row is a name this finds them by', async () => {
  // display_name is coalesce(preferred_name, first_name) || ' ' || last_name,
  // so the roster screen shows "Abby Catto" for somebody whose first name is
  // Abigail. Both spellings have to resolve to her, or the officer who types
  // what the screen shows creates a second row.
  const made = await upsert({ first: 'Abigail', last: 'Fenwick' });
  await db.exec(
    `update members set preferred_name = 'Abby' where id = '${made.member_id}'`,
  );

  const byPreferred = await upsert({ first: 'Abby', last: 'Fenwick' });
  assert.equal(byPreferred.member_id, made.member_id, 'the name on screen found nobody');
  assert.equal(byPreferred.was_created, false);

  const byGiven = await upsert({ first: 'Abigail', last: 'Fenwick' });
  assert.equal(byGiven.member_id, made.member_id, 'the name on the row found nobody');
  assert.equal(byGiven.was_created, false);
});

test('an archived member is not revived by their name', async () => {
  // Found by an address, an archived row is refused outright, because a caller
  // naming them outright deserves to be told. The name tier is a guess, so it
  // does not reach that refusal: it skips them, and the officer gets the member
  // they asked for. Orla Winterbourne is archived in the fixture above.
  const before = await memberCount();
  const result = await upsert({ first: 'Orla', last: 'Winterbourne' });

  assert.equal(result.was_created, true, 'the archived row was resolved to instead');
  assert.notEqual(result.member_id, CAST.retired);
  assert.equal(await memberCount(), before + 1);
});

test('a student id resolves somebody with no address on file', async () => {
  const before = await memberCount();

  const result = await upsert({ first: 'Quintus', last: 'Ashgrove', nid: 'QA2481' });

  // citext, so the case the officer typed does not make a second person.
  assert.equal(result.member_id, CAST.quiet);
  assert.equal(result.was_created, false);
  assert.equal(result.was_enrolled, true);
  assert.equal(await memberCount(), before);
});

test('the officers answer from the preview outranks the lookup', async () => {
  // p_matched_member_id is a person's decision about who this row is. The
  // address below belongs to somebody else entirely, and it must not win.
  const before = await memberCount();

  const result = await upsert({
    first: 'Dorian',
    last: 'Nullstone',
    email: 'rosalind.vance@ucf.edu',
    year: YEAR_2025,
    matched: MEMBERS.dorian,
  });

  assert.equal(result.member_id, MEMBERS.dorian);
  assert.equal(result.was_created, false);
  assert.equal(result.was_enrolled, true);
  assert.equal(await memberCount(), before);
});

test('a merged row resolves to the survivor rather than being put back', async () => {
  // merge_members() leaves the loser's address on the tombstone, so last
  // year's file still finds it. Enrolling that row would put somebody on the
  // roster whom merged_into_id says is not a person, and creating a new one
  // would collide with the unique index on the way.
  const before = await memberCount();

  const result = await upsert({ first: 'Tam', last: 'Redfern', email: 'tam.redfern@ucf.edu' });

  assert.equal(result.member_id, CAST.survivor);
  assert.equal(result.was_created, false);
  assert.equal(result.was_enrolled, false, 'the survivor was already on this year');
  assert.equal(await memberCount(), before);
  assert.deepEqual(await yearsOf(CAST.gone), [], 'a tombstone was put on the roster');
});

test('an archived member is refused rather than quietly revived', async () => {
  const before = await memberCount();
  const err = await refuses({ first: 'Orla', last: 'Winterbourne', email: 'orla.w@ucf.edu' });
  assert.equal(err.code, 'PDS03');
  assert.match(err.message, /archived/i);
  assert.equal(await memberCount(), before);
});

test('it refuses half a name, an unknown year and an unknown match', async () => {
  const before = await memberCount();

  const blank = await refuses({ first: '  ', last: 'Nameless', email: null });
  assert.equal(blank.code, 'PDS03');

  const year = await refuses({
    first: 'Yara',
    last: 'Bright',
    year: '00000000-0000-4000-a000-000000000000',
  });
  assert.equal(year.code, 'PDS03');

  const match = await refuses({
    first: 'Yara',
    last: 'Bright',
    matched: '00000000-0000-4000-a000-000000000000',
  });
  assert.equal(match.code, 'PDS03');

  assert.equal(await memberCount(), before, 'a refused call still wrote somebody');
});

test('an empty email cell is not an address', async () => {
  // Two CSV rows with an empty email column would otherwise both try to store
  // '', and the second one would collide with the unique index.
  const one = await upsert({ first: 'Hale', last: 'Ferrow', email: '  ' });
  const two = await upsert({ first: 'Wynne', last: 'Cadogan', email: '' });

  assert.equal(one.was_created, true);
  assert.equal(two.was_created, true);
  assert.notEqual(one.member_id, two.member_id);
  assert.equal(await db.val(`select email from members where id = $1`, [one.member_id]), null);
});

test('a member account, an unknown account and anon cannot call it', async () => {
  const before = await memberCount();

  const member = await refuses({ first: 'Snuck', last: 'In' }, USERS.adaAccount);
  assert.equal(member.code, 'PDS07');

  // The NULL-role gap. fn_is_officer() is NULL for a caller with no profiles
  // row, and `if not NULL` does not raise, so the guard asserts officer status
  // positively instead. A caller landing here without being refused would be
  // writing the roster with no role at all.
  const unknown = await refuses({ first: 'Snuck', last: 'In' }, NO_PROFILE);
  assert.equal(unknown.code, 'PDS07');

  await db.as('anon');
  const anon = await db.expectError(
    `select upsert_member_and_enroll('Snuck', 'In', null, null, $1::uuid, null)`,
    [YEAR_2026],
  );
  await db.asOwner();
  assert.equal(anon.code, '42501');

  assert.equal(await memberCount(), before);
});

test('the function grants EXECUTE to nobody it should not', async () => {
  // Postgres creates a function with EXECUTE granted to PUBLIC, and migration
  // 11's blanket revoke ran before this one existed. A SECURITY DEFINER
  // function that writes the roster, left reachable by anon, is the whole hole.
  const leaky = await db.q(`
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join lateral aclexplode(p.proacl) a on a.grantee = 0
    where n.nspname = 'public'
      and p.proname = 'upsert_member_and_enroll'
      and (p.proacl is null or a.grantee is not null)
  `);
  assert.deepEqual(leaky, [], 'upsert_member_and_enroll still grants EXECUTE to PUBLIC');
});
