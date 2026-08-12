// Deterministic control of the rate limiter's window, with no production
// change and nothing new for a caller to reach.
//
// fn_rate_limit_check buckets on date_trunc('minute', now()). In Postgres
// now() is transaction_timestamp(): it is fixed when the transaction starts
// and does not advance while that transaction is open. Running a burst inside
// one explicit transaction therefore pins every call in it to exactly one
// limiter window, chosen by nothing more than when the test began.
//
// This replaces waitForRoomInThisMinute(), which slept up to a full minute
// hoping a burst would not straddle a boundary. Sleeping only made straddling
// unlikely, and an unlucky run still collected two allowances and passed for
// the wrong reason. A pinned transaction makes straddling impossible, and
// costs no wall-clock time at all.
//
// Two properties worth stating plainly, because they were the conditions on
// this work:
//
//   * Production behaviour is identical. There is no test-only branch in the
//     limiter, no setting, GUC or argument that selects a window, and not one
//     line of supabase/migrations changed for this. A real request is one
//     transaction and gets real wall-clock now().
//
//   * There is nothing here an anonymous caller can reach. The determinism
//     comes from how the test harness drives its own connection, outside the
//     database entirely. An anonymous caller does not get to choose its
//     transaction boundaries: PostgREST opens one per request.

// Runs fn inside a single explicit transaction, so every now() inside it, and
// therefore every limiter bucket, belongs to one minute. fn is handed that
// minute so assertions can name the window they expect rows in.
export async function inPinnedMinute(db, fn) {
  await db.exec('begin');
  let committed = false;
  try {
    const windowStart = await db.val(`select date_trunc('minute', now())`);
    const result = await fn(windowStart);
    await db.exec('commit');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      // Best effort: the interesting error is the one already propagating.
      try {
        await db.exec('rollback');
      } catch {
        /* the transaction is going away with the connection regardless */
      }
    }
  }
}

// Runs one caller's turn inside a savepoint, and reports whether it succeeded
// instead of throwing.
//
// Inside an explicit transaction a raised exception poisons everything after
// it, so a single limiter refusal would turn "3 of 167 attendees were turned
// away, first failure Burstone Attendee041 at submit, PDS09" into 164 cascaded
// 'current transaction is aborted' errors. That message is the most valuable
// thing the burst tests produce, so the savepoint is what protects it.
//
// It also keeps the semantics honest: a refused call rolls back its own writes
// and leaves everyone else's alone, which is exactly what happens in
// production, where the raise rolls back that one request's transaction.
export async function attempt(db, name, fn) {
  // The name goes into SQL unquoted, so keep it to a bare identifier.
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`savepoint name must be a plain identifier, got ${name}`);
  }
  await db.exec(`savepoint ${name}`);
  try {
    const value = await fn();
    await db.exec(`release savepoint ${name}`);
    return { ok: true, value };
  } catch (error) {
    await db.exec(`rollback to savepoint ${name}`);
    await db.exec(`release savepoint ${name}`);
    return { ok: false, error };
  }
}
