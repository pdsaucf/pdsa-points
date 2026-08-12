// Wholesale snapshot and restore of the small configuration tables a test
// mutates to prove a point.
//
// The failure this exists to stop: a test lowers a ceiling, an assertion in
// the middle of it throws, and the inline restore on the last line never runs.
// Every later test in the file then executes against a ceiling somebody set to
// two. That is not theoretical. Inducing one mid-test failure in
// checkin_limits.test.mjs, immediately after it lowers
// evidence_grants_outstanding_per_event to 2, is enough to make the next and
// entirely unrelated test fail with PDS04 "Too many photo uploads are pending
// for this event". The first failure is the real one and the second is noise,
// which is precisely the reading problem a flaky gate creates.
//
// Restoring from a snapshot in an afterEach hook makes the restore
// unconditional: it cannot be skipped by a throw, and it does not depend on a
// test remembering which keys it touched or what the shipped default was.
// That second point had already bitten. checkin_limits.test.mjs restored
// evidence_grants_outstanding_per_event to 400, but the migration ships 1200,
// so even the passing path left the wrong number behind for the rest of the
// file. The value 400 is the exact number the migration comment calls out as
// "the third instance of the same mistake".
//
// The restore is a whole-table replace rather than a per-key update, so it
// also undoes rows a test inserted or deleted, not just values it changed.

// Captures entire tables as JSON. Call it once the fixture is fully built.
export async function snapshotTables(db, tables) {
  const snapshot = [];
  for (const table of tables) {
    const rows = await db.val(
      `select coalesce(jsonb_agg(to_jsonb(t) order by t::text), '[]'::jsonb) from ${table} t`,
    );
    snapshot.push({ table, rows });
  }
  return snapshot;
}

// Puts them back exactly as they were. Safe to call when nothing changed.
export async function restoreTables(db, snapshot) {
  for (const { table, rows } of snapshot) {
    await db.q(`delete from ${table}`);
    await db.q(
      `insert into ${table}
       select * from jsonb_populate_recordset(null::${table}, $1::jsonb)`,
      [JSON.stringify(rows)],
    );
  }
}
