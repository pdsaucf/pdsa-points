# PDSA Points System

Replacing PDSA UCF's Google Sheets point tracking with a static frontend on
GitHub Pages (points.pdsaucf.com) backed by Supabase.

This repository currently contains **P0: the database**. There is no frontend
yet. What exists is the schema, the requirements engine, the RPC surface, row
level security, and a test suite that proves all of it works.

## Before your first event

**The system ships with an empty roster.** Load one first:

```bash
python3 scripts/import_roster.py roster.csv --year 2026-2027 --out local/roster.sql
# then apply local/roster.sql to the database
```

If you do not, check-in still works, but **every attendee will arrive as an
unmatched name**. Each one lands in the review queue for an officer to link to a
person by hand, one at a time, after the event. At a 167-person GBM that is your
whole evening.

The dashboard warns you about this: `v_config_warnings` raises
`event_without_enrolled_members` for any published event that is open or
happening within a week while nobody is enrolled in its academic year. The
warning exists so you find out beforehand rather than afterwards.

Some unmatched submissions are normal and expected regardless, especially at a
recruiting event, and the limits are sized to admit a full room of them. See
[Check-in rate limits](#check-in-rate-limits-and-the-client-nonce) below.

Full instructions are in [Loading a roster](#loading-a-roster).

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
| `..._rpcs.sql` | the thirteen RPCs: four for the anonymous check-in page, five for the review queue and the purges, four for the requirements editor |
| `..._rls.sql` | policies and grants |
| `..._storage.sql` | the `evidence` bucket and its policies |
| `..._seed_2026_2027.sql` | the year, its terms, the categories, and the published rule tree |
| `..._duplicate_people.sql` | `v_possible_duplicate_members` and `dismiss_duplicate_pair()` |
| `..._member_upsert.sql` | `upsert_member_and_enroll()`, the one write behind roster Add and import |
| `..._role_assertions.sql` | `fn_assert_officer()` and `fn_assert_admin()` refuse a caller whose role cannot be determined |
| `..._member_import_batch.sql` | `upsert_members_and_enroll()`, which imports a roster in one request instead of 355 |
| `..._member_portal.sql` | `attendance_records.member_note`, `member_claims.review_note`, and the six RPCs the member portal signs in through: session bootstrap, the claim flow and its officer approval, and the missing-credit request. Also locks both member rows at the top of `merge_members()`, which approving a claim now depends on |

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
account claim, so an unclaimed account sees nothing. An account with no
`profiles` row at all has no role, and no role is refused: `fn_assert_officer()`
and `fn_assert_admin()` treat an indeterminate role as a no rather than as a
missing no. `test/privileges.test.mjs` holds both that and the grants, so a
migration that forgets to revoke `EXECUTE` from `PUBLIC` fails there.

RPC errors carry distinct SQLSTATE codes so a client can tell them apart
**without matching on message text**: `PDS01` bad token, `PDS02` check-in has not
opened yet, `PDS03` bad argument, `PDS04` evidence problem, `PDS05` already
checked in, `PDS06` cannot approve an unmatched record, `PDS07` wrong role,
`PDS08` unknown requirement set, `PDS09` rate limited, `PDS10` check-in has
closed, `PDS11` the requirement tree is not a tree, `PDS12` a requirement set
failed validation, `PDS13` this account already holds a claim or a link, `PDS14`
that member is already claimed by, or linked to, another account.

`PDS02` and `PDS10` are separate codes on purpose. They were one code, which
forced the page to read the message text to decide which of two screens to show,
so rewording a sentence would have silently shown the wrong one with no test
failing. The message text is copy and is meant to be rewritten freely; the code
is the contract. If a further distinction is ever needed, add a code rather than
a sentence.

`PDS13` and `PDS14` are the same rule applied again. A claim that cannot be
filed has failed for one of two reasons, and only one of them is the member's
mistake: their own claim is already waiting, or somebody else already holds one
on that person, which an officer has to look at.

### Check-in rate limits, and the client nonce

The largest event in the historical data had **167 attendees**, who all scan the
same QR code within a few minutes. A rate limit keyed on that shared token
cannot both admit them and deter abuse: whatever number admits the crowd is
useless against an attacker, and whatever number stops an attacker locks out the
crowd.

So `get_checkin_context` issues each page load an opaque, expiring
`client_nonce`, and the other three RPCs accept it. Limits are keyed per client
first and per event second. The nonce **authorizes nothing**: it is honoured
only if this database issued it for this event and it has not expired, anything
else falls back to the shared bucket, and minting is itself capped.

Every ceiling is a row in `app_settings`, so raising one is a settings edit and
not a migration. The reasoning behind each default, and the arithmetic it comes
from, is in the comment block above them in the ops-tables migration and in
[docs/01-data-model.md](docs/01-data-model.md) section 8. Two are worth knowing
about:

- The event-wide `search_members` ceiling is an **anti-runaway backstop, not a
  security control**, and is deliberately an order of magnitude above peak.
  Hardening it downward locks real attendees out of their own check-in and
  protects almost nothing, since the endpoint returns names only.
- **Unmatched submissions** get their own ceiling on top of the submission one,
  because a matched member can only ever create one live row per event (a unique
  index says so) while an unmatched one has no such bound. It is layered the same
  way: tight per client, generous per event. Do not lower the event number on the
  theory that unmatched submissions are rare, because on an empty roster or at a
  recruiting event they are the *majority* of the room.

Two regression tests hold this down, and they cover different paths:

- `test/burst.test.mjs`: 167 attendees **who are on the roster** each complete an
  autocomplete and a submission inside one simulated minute.
- `test/burst_unmatched.test.mjs`: 167 attendees at an event with an **empty
  roster**, every one going through "I don't see my name".

Every one of them must succeed in both.

### Abandoned uploads

Uploading a photo and submitting the check-in are separate steps, so a member can
do the first and not the second, leaving an object nothing points at.
`purge_evidence()` cannot see those (it scans `attendance_evidence`), so
`v_orphaned_uploads` finds them, `v_config_warnings` raises a banner, and
`purge_orphaned_uploads()` returns their paths for an operator to delete. Like
every other purge here, it is a button and not a timer.

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
