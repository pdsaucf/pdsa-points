// Test database harness.
//
// Boots an in-memory PGlite (real Postgres compiled to wasm, no Docker),
// installs the Supabase stand-ins, applies every migration in supabase/migrations
// in filename order, and hands back a small wrapper for running queries as a
// particular role and user.
//
// That boot and replay costs about 1.7s, so the migrated data directory is
// cached on disk and restored instead. See schema_cache.mjs for how the cache
// is keyed and invalidated. PDSA_TEST_DB_CACHE=off replays the migrations.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

import { cachedDataDir, discardCachedDataDir } from './schema_cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

// Every extension migration 01 asks for is available in PGlite, so the real
// migration file applies unmodified and nothing is substituted or weakened.
const EXTENSIONS = { citext, pg_trgm, pgcrypto };
const EXTENSION_NAMES = Object.keys(EXTENSIONS);

export async function migrationFiles() {
  const names = await readdir(MIGRATIONS);
  return names.filter((n) => n.endsWith('.sql')).sort();
}

// The slow path, and the definition of what a correct database is. Everything
// the cache does has to be equivalent to this.
async function bootAndMigrate() {
  const pg = await new PGlite({ extensions: EXTENSIONS });

  await pg.exec(await readFile(join(HERE, 'supabase_stub.sql'), 'utf8'));

  for (const name of await migrationFiles()) {
    const sql = await readFile(join(MIGRATIONS, name), 'utf8');
    try {
      await pg.exec(sql);
    } catch (err) {
      throw new Error(`migration ${name} failed: ${err.message}`);
    }
  }

  return pg;
}

// Builds the tar the cache stores. Whichever process wins the cache lock runs
// this once; every other process, including this one, then goes through
// loadDataDir. Round tripping through the cache even on the build path means a
// restore problem shows up as a loud failure everywhere rather than as one
// process quietly running a different database.
async function buildMigratedDump() {
  const pg = await bootAndMigrate();
  try {
    // Flush shared buffers so the tar is a complete data directory rather than
    // one that depends on WAL replay to be correct.
    await pg.exec('checkpoint');
    const file = await pg.dumpDataDir('none');
    return new Uint8Array(await file.arrayBuffer());
  } finally {
    await pg.close();
  }
}

export async function freshDb() {
  const tar = await cachedDataDir(buildMigratedDump, EXTENSION_NAMES);

  if (tar) {
    try {
      const pg = new PGlite({
        extensions: EXTENSIONS,
        loadDataDir: new Blob([tar]),
      });
      // PGlite defers startup, so a bad data directory would otherwise surface
      // as a failure inside the first test rather than here.
      await pg.waitReady;
      return wrap(pg);
    } catch (err) {
      // A data directory that will not load is thrown away, not worked around,
      // and the migrations are replayed so this run still tests the real schema.
      await discardCachedDataDir(EXTENSION_NAMES);
      process.emitWarning(`schema cache failed to restore, replaying migrations: ${err.message}`);
    }
  }

  return wrap(await bootAndMigrate());
}

function wrap(pg) {
  const api = {
    raw: pg,

    // Parameterised query. Returns rows.
    async q(sql, params = []) {
      const res = await pg.query(sql, params);
      return res.rows;
    },

    async one(sql, params = []) {
      const rows = await api.q(sql, params);
      if (rows.length !== 1) {
        throw new Error(`expected exactly 1 row, got ${rows.length}: ${sql}`);
      }
      return rows[0];
    },

    async val(sql, params = []) {
      const row = await api.one(sql, params);
      return Object.values(row)[0];
    },

    // Multi-statement script, no parameters.
    async exec(sql) {
      return pg.exec(sql);
    },

    // Become a database role, optionally with a signed-in user id, the way
    // PostgREST does on every request.
    async as(role, userId = null) {
      await pg.exec('reset role');
      await pg.query('select set_config($1, $2, false)', [
        'request.jwt.claim.sub',
        userId ?? '',
      ]);
      await pg.exec(`set role ${role}`);
    },

    // Back to the owner: full rights, RLS bypassed, no auth.uid().
    async asOwner() {
      await pg.exec('reset role');
      await pg.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', '']);
    },

    // Runs fn as the given role and always restores owner rights afterwards.
    async withRole(role, userId, fn) {
      await api.as(role, userId);
      try {
        return await fn();
      } finally {
        await api.asOwner();
      }
    },

    // Asserts that a statement fails, and returns the error for inspection.
    async expectError(sql, params = []) {
      try {
        await api.q(sql, params);
      } catch (err) {
        return err;
      }
      throw new Error(`expected an error but the statement succeeded: ${sql}`);
    },

    // The same, for a multi-statement script. A prepared statement cannot
    // hold more than one command, so these have to go through exec.
    async expectExecError(sql) {
      try {
        await pg.exec(sql);
      } catch (err) {
        return err;
      }
      throw new Error('expected an error but the script succeeded');
    },

    async close() {
      await pg.close();
    },
  };

  return api;
}
