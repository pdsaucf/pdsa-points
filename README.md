# PDSA Points System

Replacing PDSA UCF's Google Sheets point tracking with a static frontend on
GitHub Pages (points.pdsaucf.com) backed by Supabase.

This repository currently contains **P0: the database**. There is no frontend
yet. What exists is the schema, the requirements engine, the RPC surface, row
level security, and a test suite that proves all of it works.

Design docs, signed off before implementation:

- [docs/00-spreadsheet-findings.md](docs/00-spreadsheet-findings.md)
- [docs/01-data-model.md](docs/01-data-model.md)
- [docs/02-storage.md](docs/02-storage.md)
- [docs/03-admin-ui.md](docs/03-admin-ui.md)
- [docs/04-member-ui.md](docs/04-member-ui.md)

House rules and architectural invariants are in [CLAUDE.md](CLAUDE.md). They
are requirements, not preferences.

## Layout

```
supabase/migrations/   the schema, in numbered files by concern
scripts/               roster import, house-rule check
test/                  node test runner over PGlite, no Docker
docs/                  the signed-off design
```

## The migrations

Apply them in filename order. They are numbered by concern rather than by
feature, so each one can be read on its own.

| File | What it does |
|---|---|
| `..._drop_starter_tables.sql` | **Destructive.** Drops the placeholder `members` / `events` / `attendance` tables the project was created with. Read it before applying. |
| `..._extensions_and_roles.sql` | `pgcrypto`, `citext`, `pg_trgm`, and the `anon` / `authenticated` / `service_role` roles |
| `..._calendar.sql` | `academic_years`, `terms` |
| `..._people.sql` | `members`, `profiles`, `member_enrollments`, `member_claims`, `member_merges` |
| `..._categories.sql` | `categories` |
| `..._events.sql` | `events`, `event_categories`, `event_evidence_requirements` |
| `..._attendance.sql` | `attendance_records`, `attendance_evidence` |
| `..._requirements.sql` | `requirement_sets`, `requirement_nodes`, `requirement_node_categories` |
| `..._ops_tables.sql` | `purge_runs`, `app_settings`, `audit_log`, upload grants, rate limiting |
| `..._views_and_functions.sql` | role helpers, the evaluator, `v_member_status`, `v_config_warnings` |
| `..._rpcs.sql` | the eight RPCs |
| `..._rls.sql` | policies and grants |
| `..._storage.sql` | the `evidence` bucket and its policies |
| `..._seed_2026_2027.sql` | the year, its terms, the categories, and the published rule tree |

The first migration is destructive and deliberately separate so it is
impossible to apply by accident along with everything else.

Two places in the seed are marked for an officer to check before the first
event: **the academic year and term dates**, and **the thresholds**, which are
carried over from 2025-2026 and are expected to be reviewed.

## What the system knows, and where

Nothing about categories, thresholds or the honorary rule lives in code. They
are rows.

- A **category** is a row in `categories`. Its `unit` changes labelling only.
  Its `counts_toward_point_total` flag decides whether its credit is a point.
  Volunteering is the one category measured in hours and the one that is not a
  point, and those are two independent flags rather than one rule about units.
- A **rule** is a tree in `requirement_nodes`. A `threshold` node passes when
  the sum of credit over one or more categories reaches `min_value`. A `group`
  node passes when at least `min_children_passing` of its children pass, or
  all of them when that is null.
- **Honorary status** is the root node's verdict, computed by
  `fn_member_requirement_status()` in Postgres and read through
  `v_member_status`. It is never computed in the browser.

Turning "all ten categories" into "any eight of ten" is one integer update to
one row. There is a test that does exactly that and asserts the honorary list
changes and then changes back.

## Running the tests

```bash
npm install
npm test          # the full suite
npm run check     # the em dash check, then the suite
```

The suite runs against [PGlite](https://pglite.dev), which is real PostgreSQL
compiled to WebAssembly. No Docker, no local Postgres, no Supabase project. It
boots a fresh database per test file, applies every migration unmodified, and
tears it down.

Supabase adds a handful of objects that the migrations legitimately depend on:
`auth.users`, `auth.uid()`, the `storage` schema, and the three database roles.
`test/helpers/supabase_stub.sql` supplies stand-ins for exactly those and
nothing else, and it is never applied to a real database.

**No extension was substituted or weakened.** `citext`, `pg_trgm` and
`pgcrypto` are all available in PGlite, so the migrations run there exactly as
they will on Supabase.

The fixture in `test/helpers/fixture.mjs` is ten fictional members and
eighteen events, hand-built so that every expected number in it was worked out
by hand and written down as a constant. There is no real student data anywhere
in this repository.

## Loading a roster

The system starts with no members. Before the first event of the year, load a
roster, otherwise the first GBM produces a review queue full of "add as a new
member" decisions.

```bash
# See what would happen, without writing anything
python3 scripts/import_roster.py roster.csv --year 2026-2027 --dry-run

# Generate the SQL
mkdir -p local
python3 scripts/import_roster.py roster.csv --year 2026-2027 --out local/roster.sql
```

Then apply `local/roster.sql` to the database, through the Supabase SQL editor
or `psql`.

The CSV needs a header row with `first_name` and `last_name`. `email` is
optional, extra columns are ignored, and header names are matched loosely, so
`First Name` and `first-name` both work. The script refuses to run on
malformed input and names the row that is wrong rather than guessing.

Duplicates are handled twice over: within the file, and against members who are
already in the database. A match is by email when there is one, and by
normalised full name otherwise, which is the same rule
`fn_normalise_name()` uses in the database. The generated SQL is idempotent, so
applying it twice is harmless, and re-running it after adding people to the CSV
only inserts the new ones.

### Privacy

**A real roster is student PII and does not belong in this repository.** Both
the CSV and the SQL generated from it are gitignored (`*.csv`, `local/`,
`roster_*.sql`, `seed_*.sql`). Keep them local, apply them, and do not commit
them. The only CSV in the repository is `test/fixtures/sample_roster.csv`,
which is fictional.

## The security model in one paragraph

`anon` has no privileges on any table. Not a policy that denies everything: no
grant at all. The anonymous check-in page reaches the database only through
four `SECURITY DEFINER` RPCs (`get_checkin_context`, `search_members`,
`create_evidence_upload`, `submit_checkin`), none of which takes a status or a
source argument, so an anonymous caller structurally cannot approve anything.
Everyone signed in shares the `authenticated` database role; admin, officer,
viewer and member are values of `profiles.role`, read through `SECURITY
DEFINER` helpers so that policies on `profiles` do not recurse. Members are
keyed on `profiles.member_id`, which stays null until an officer approves an
account claim, so an unclaimed account sees nothing.

RPC errors carry distinct SQLSTATE codes so a client can tell them apart
without matching on message text: `PDS01` bad token, `PDS02` check-in not open,
`PDS03` bad argument, `PDS04` evidence problem, `PDS05` already checked in,
`PDS06` cannot approve an unmatched record, `PDS07` wrong role, `PDS08` unknown
requirement set, `PDS09` rate limited.

## Photo storage

One private `evidence` bucket. The browser compresses, asks
`create_evidence_upload()` for a one-shot grant, and PUTs straight to Storage.
Retention is 12 months and clearing is a button, never a timer: `purge_evidence()`
only ever touches photos whose record has actually been reviewed and whose
event is past the window, and it writes a `purge_runs` row attributing the run.
See [docs/02-storage.md](docs/02-storage.md) for the arithmetic behind that.

## House rules

No em dashes, anywhere, including SQL comments and this file:

```bash
npm run lint:no-em-dash
```
