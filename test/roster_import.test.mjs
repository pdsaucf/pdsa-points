// scripts/import_roster.py, end to end against a real database.
//
// The fixture CSV holds fictional names only. A real roster is student PII and
// is gitignored, along with the SQL generated from it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDb } from './helpers/db.mjs';
import { YEAR_2026 } from './helpers/fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'import_roster.py');
const SAMPLE = join(HERE, 'fixtures', 'sample_roster.csv');

let db;

function runScript(args) {
  // stderr is captured rather than inherited: the script's progress summary is
  // for a human at a terminal, not for the test log.
  return execFileSync('python3', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function runScriptExpectingFailure(args) {
  try {
    execFileSync('python3', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    return { status: err.status, stderr: err.stderr };
  }
  throw new Error('expected the script to fail');
}

test.before(async () => {
  db = await freshDb();
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('generated SQL loads the roster, and running it twice changes nothing', async () => {
  const sql = runScript([SAMPLE, '--year', '2026-2027']);

  await db.exec(sql);

  const members = await db.q(`select first_name, last_name, email from members order by last_name`);
  assert.deepEqual(members, [
    { first_name: 'Cressida', last_name: 'Boundary', email: 'CRESSIDA@example.test' },
    { first_name: 'Barnaby', last_name: 'Fixture', email: null },
    { first_name: 'Ada', last_name: 'Testwood', email: 'ada@example.test' },
  ]);

  const enrolled = Number(
    await db.val(`select count(*) from member_enrollments where academic_year_id = $1`, [
      YEAR_2026,
    ]),
  );
  assert.equal(enrolled, 3);

  // Idempotent: the same file applied again must not create anybody.
  await db.exec(sql);
  assert.equal(Number(await db.val(`select count(*) from members`)), 3);
  assert.equal(Number(await db.val(`select count(*) from member_enrollments`)), 3);
});

test('a second file matching existing people enrolls them without duplicating them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdsa-roster-'));
  const path = join(dir, 'second.csv');

  // Ada by a differently cased email, Barnaby by name with no email, plus one
  // genuinely new person.
  writeFileSync(
    path,
    ['first_name,last_name,email', 'Ada,Testwood,ADA@example.test', 'Barnaby,Fixture,', 'Dorian,Nullstone,'].join(
      '\n',
    ),
  );

  await db.exec(runScript([path, '--year', '2026-2027']));

  assert.equal(Number(await db.val(`select count(*) from members`)), 4);
  assert.equal(
    Number(await db.val(`select count(*) from members where last_name = 'Testwood'`)),
    1,
    'citext email match, so a different case is the same person',
  );
  assert.equal(
    Number(await db.val(`select count(*) from members where last_name = 'Fixture'`)),
    1,
    'normalised name match when there is no email',
  );
});

test('the script refuses malformed input and names the offending row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdsa-roster-'));

  const missingColumn = join(dir, 'no-header.csv');
  writeFileSync(missingColumn, 'name,email\nAda Testwood,ada@example.test');
  const a = runScriptExpectingFailure([missingColumn, '--year', '2026-2027']);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /missing required column\(s\): first_name, last_name/);

  const blankName = join(dir, 'blank.csv');
  writeFileSync(blankName, 'first_name,last_name\nAda,Testwood\n,Nolastname');
  const b = runScriptExpectingFailure([blankName, '--year', '2026-2027']);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /row 3/);

  const badEmail = join(dir, 'bad-email.csv');
  writeFileSync(badEmail, 'first_name,last_name,email\nAda,Testwood,555-0100');
  const c = runScriptExpectingFailure([badEmail, '--year', '2026-2027']);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /row 2.*does not look like an email/s);

  const empty = join(dir, 'empty.csv');
  writeFileSync(empty, '');
  const d = runScriptExpectingFailure([empty, '--year', '2026-2027']);
  assert.equal(d.status, 1);
  assert.match(d.stderr, /empty/);
});

test('the generated SQL refuses to run against a year that does not exist', async () => {
  const sql = runScript([SAMPLE, '--year', '2099-2100']);
  const err = await db.expectExecError(sql);
  assert.match(err.message, /2099-2100 does not exist/);
});
