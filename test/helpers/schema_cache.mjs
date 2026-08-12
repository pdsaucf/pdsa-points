// Cache of the post-migration PGlite data directory.
//
// Booting PGlite and replaying all 14 migrations costs about 1.7s, and it used
// to happen once per test file, each in its own Node process. That was roughly
// 92% of the suite's runtime; the actual test work is about 1.5s in total.
//
// So the migrated data directory is built once, captured with dumpDataDir(),
// and written to a gitignored file. Every later boot restores it through the
// PGlite loadDataDir option instead of replaying anything.
//
// The stale-schema question is the one that matters, so the cache is keyed by
// content rather than by time: the file name is a hash of supabase_stub.sql,
// every file under supabase/migrations, the PGlite version, the extension set,
// and the two harness modules that do the building. Change any of those and the
// key changes, so the old tar is simply never opened again. There is no
// freshness heuristic that could get it wrong.
//
// Set PDSA_TEST_DB_CACHE=off to bypass the cache and replay migrations, which
// is the reference behaviour the cache is expected to match.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const MIGRATIONS = join(REPO, 'supabase', 'migrations');
const STUB = join(HERE, 'supabase_stub.sql');
const CACHE_DIR = join(REPO, '.pglite', 'schema-cache');

// How long a process waits for whichever process holds the lock to finish
// building. On timeout it gives up and replays the migrations itself, so a
// crashed or wedged builder costs time and never correctness.
const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 50;

// Cache files older than this are removed once a newer one has been built.
// The delay keeps a concurrently running suite from losing the tar it is
// reading.
const PRUNE_AFTER_MS = 10 * 60 * 1000;

export function cacheEnabled() {
  return process.env.PDSA_TEST_DB_CACHE !== 'off';
}

// Every file that feeds the migrated state, deepest-first order made stable by
// sorting. Not filtered to .sql: adding a file of any name to the migrations
// directory changes the key, which is the safe direction to err in.
async function schemaSources() {
  const out = [];

  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const label = prefix + entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, label + '/');
      } else {
        out.push({ label, path });
      }
    }
  }

  out.push({ label: 'helpers/supabase_stub.sql', path: STUB });
  // The harness code that builds the dump is part of what the dump means, so a
  // change to either module invalidates the cache without anyone remembering
  // to bump a version constant.
  out.push({ label: 'helpers/db.mjs', path: join(HERE, 'db.mjs') });
  out.push({ label: 'helpers/schema_cache.mjs', path: join(HERE, 'schema_cache.mjs') });
  await walk(MIGRATIONS, 'migrations/');

  return out;
}

// A data directory belongs to the PGlite release that wrote it, so the version
// is part of the key. Read through Node's own resolution rather than a hardcoded
// node_modules path, which would break in a git worktree that hoists to the
// parent checkout. The package does not export package.json, so resolve the
// entry point and walk up to it.
async function pgliteVersion() {
  const entry = createRequire(import.meta.url).resolve('@electric-sql/pglite');
  let dir = dirname(entry);
  for (;;) {
    try {
      return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version;
    } catch {
      const up = dirname(dir);
      if (up === dir || parse(dir).root === dir) {
        throw new Error('could not locate the @electric-sql/pglite package.json');
      }
      dir = up;
    }
  }
}

// Hex digest identifying the exact inputs that produced a cached data
// directory. Exported so a test can assert that editing a migration moves it.
export async function schemaFingerprint(extensionNames) {
  const h = createHash('sha256');
  h.update(`pglite:${await pgliteVersion()}\n`);
  h.update(`extensions:${[...extensionNames].sort().join(',')}\n`);

  for (const { label, path } of await schemaSources()) {
    const bytes = await readFile(path);
    h.update(`${label}:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}\n`);
  }

  return h.digest('hex').slice(0, 32);
}

async function tryRead(path) {
  try {
    return await readFile(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Best effort. A cache directory that cannot be tidied is not a test failure.
async function prune(keep) {
  try {
    const now = Date.now();
    for (const name of await readdir(CACHE_DIR)) {
      if (name === keep || !name.endsWith('.tar')) continue;
      const path = join(CACHE_DIR, name);
      const info = await stat(path);
      if (now - info.mtimeMs > PRUNE_AFTER_MS) await rm(path, { force: true });
    }
  } catch {
    // ignored
  }
}

async function waitForFile(path, lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    const bytes = await tryRead(path);
    if (bytes) return bytes;
    // Lock gone without a cache file means the builder failed. Stop waiting.
    try {
      await stat(lockDir);
    } catch {
      return null;
    }
  }
  return null;
}

// Returns the cached tar bytes, building them with `build` if needed, or null
// when the cache is disabled or unavailable. A null answer means the caller
// should replay the migrations, which is always correct.
export async function cachedDataDir(build, extensionNames) {
  if (!cacheEnabled()) return null;

  const key = await schemaFingerprint(extensionNames);
  const name = `${key}.tar`;
  const path = join(CACHE_DIR, name);

  const hit = await tryRead(path);
  if (hit) return hit;

  await mkdir(CACHE_DIR, { recursive: true });

  const lockDir = join(CACHE_DIR, `${key}.lock`);
  try {
    await mkdir(lockDir);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Someone else is building this exact key. Wait for their result rather
    // than boot a second wasm Postgres alongside theirs.
    return (await waitForFile(path, lockDir)) ?? (await tryRead(path));
  }

  try {
    const bytes = await build();
    // Rename into place so no reader can ever observe a half written tar.
    const tmp = join(CACHE_DIR, `${key}.${process.pid}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    await prune(name);
    return bytes;
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

// Drops a cache entry that failed to restore. Called from the fallback path in
// db.mjs so a corrupt tar is not retried by the next process.
export async function discardCachedDataDir(extensionNames) {
  try {
    const key = await schemaFingerprint(extensionNames);
    await rm(join(CACHE_DIR, `${key}.tar`), { force: true });
  } catch {
    // ignored
  }
}
