import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, USERS, YEAR_2026 } from './helpers/fixture.mjs';

test('name-only member creation locks the normalized identity before lookup and insert', async () => {
  const db = await freshDb();
  try {
    await loadFixture(db);
    const source = await db.val(
      `select pg_get_functiondef(
         'upsert_member_and_enroll(text,text,citext,citext,uuid,uuid)'::regprocedure
       )`,
    );
    const lockAt = source.indexOf('pg_advisory_xact_lock');
    const nameLookupAt = source.indexOf('fn_normalise_name(display_name)');
    const insertAt = source.toLowerCase().indexOf('insert into members');
    assert.ok(lockAt >= 0, 'the normalized name has no transaction lock');
    assert.ok(lockAt < nameLookupAt, 'the name lookup ran before its lock');
    assert.ok(lockAt < insertAt, 'the member insert ran before its lock');

    await db.as('authenticated', USERS.officer);
    const first = await db.val(
      `select upsert_member_and_enroll('Concurrent', 'Noemail', null, null, $1, null)`,
      [YEAR_2026],
    );
    const retry = await db.val(
      `select upsert_member_and_enroll(' concurrent ', 'NOEMAIL', null, null, $1, null)`,
      [YEAR_2026],
    );
    await db.asOwner();

    assert.equal(retry.member_id, first.member_id);
    assert.equal(retry.was_created, false);
    assert.equal(
      Number(
        await db.val(
          `select count(*) from members
            where fn_normalise_name(display_name) = fn_normalise_name('Concurrent Noemail')`,
        ),
      ),
      1,
    );
  } finally {
    await db.asOwner();
    await db.close();
  }
});
