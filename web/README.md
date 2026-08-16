# web/ · the frontend

Two surfaces, one static directory, no build step.

- **`/c/`** the page a member reaches by scanning the QR code at an event. No login.
  This is **P1**.
- **`/admin/`** the officer screens, behind a magic-link sign-in: the review queue and
  account claims (**P2**), the requirements editor and categories (**P3**), and the
  progress board, member detail and roster (**P4**).

```
web/
  config.js                  Supabase URL and anon key. Public by design.

  c/index.html               the check-in page, served at /c/?e=<token>
  admin/index.html           the review queue, served at /admin/

  src/api.js                 fetch against PostgREST and Storage, with retries
  src/checkin.js             the check-in flow
  src/errors.js              every PDS* code, written from the member's side
  src/image.js               compression to the docs/02-storage.md spec
  src/format.js              dates, labels, units

  src/admin.js               sign-in, the role guard, the tabs
  src/auth.js                the session: magic link, refresh, sign out
  src/rest.js                authenticated PostgREST reads and writes
  src/review.js              the review queue
  src/claims.js              account claims
  src/requirements.js        the rule editor, with the live preview
  src/requirement-model.js   the rule tree as data, with no DOM in it
  src/categories.js          what the rules measure
  src/progress.js            the progress board, member by category
  src/member.js              one member: progress, checklist, record log
  src/roster.js              the roster, CSV import, duplicate people
  src/csv.js                 reading and writing CSV, both directions
  src/match.js               ranking the roster against a typed-in name
  src/flags.js               the triage vocabulary, in an officer's words
  src/officer-errors.js      every PDS* code, written from the officer's side
  src/ui.js                  the DOM helpers

  assets/css/checkin.css     the check-in stylesheet
  assets/css/admin.css       the admin stylesheet
  assets/fonts/public-sans/  Public Sans goes here (see the README in that folder)
  mock/                      a local stand-in for Supabase, for development
```

## Why there is still no framework, and no supabase-js

The check-in page avoided both because it runs on venue wifi with sixty phones on
it. The admin screens are on a laptop, so that argument does not apply, and the
question was asked again for **P2** rather than assumed.

The answer came out the same, for a different reason. No CDN is allowed, so
`@supabase/supabase-js` would have to be vendored: a bundled artifact committed
into a repository whose stated property is that nothing is compiled and what is in
the repo is exactly what runs. What it would have replaced is three HTTP calls and
one fragment parse, which is `src/auth.js`. The full reasoning is at the top of
that file, including what is now this codebase's job to maintain as a result.

## Setting it up before an event

1. Open the Supabase dashboard, **Project Settings, API**.
2. Copy **Project URL** into `SUPABASE_URL` in `config.js`.
3. Copy the **anon / public** key into `SUPABASE_ANON_KEY` in `config.js`.
4. Commit both. They are public values, and the page cannot work without them.

**The anon key belongs in the repository.** It identifies the project and grants
nothing on its own: every table is behind RLS, and this page never touches a
table. What an anonymous caller may do is decided entirely by the four
`SECURITY DEFINER` RPCs in `supabase/migrations/20260811101000_rpcs.sql`. The
`service_role` key is the opposite of that, and must never appear anywhere under
`web/`.

Until the placeholders are replaced, the page says so rather than failing with a
network error.

## Deploying

The whole directory is static. Nothing is compiled, bundled, minified or
transpiled, so what is in the repo is exactly what runs.

GitHub Pages publishes either the repository root or `/docs`, and this lives in
neither, so publish `web/` as the Pages artifact from a workflow. That file is
outside this directory and therefore outside the scope of this phase, but the
step needed is:

```yaml
- uses: actions/upload-pages-artifact@v3
  with:
    path: web
```

`/c/` is a real directory containing `index.html`, so the route works on GitHub
Pages with no rewrite rules, no 404 trick and no hash router.

## The URL, and the QR code

```
https://points.pdsaucf.com/c/?e=7fK2pQ
```

`e` is `events.checkin_token`: short, random, url safe, and rotatable if a
printed QR code leaks. The whole string is what gets encoded into the QR, which
is why it is a one letter parameter on a two character path.

## Running it locally

There is no live Supabase project in development, so `mock/` stands in for one.

```bash
cd web
npm run mock                 # http://localhost:8787
npm run verify               # the check-in checks
npm run verify:admin         # the review queue checks
npm run verify:requirements  # the rule editor checks
npm run verify:board         # the board, member, roster and merge checks
npm run check                # em dash gate, then all four suites
```

`verify:board` is the one suite that mounts the shipped page rather than only
the modules. `mock/dom.mjs` parses `admin/index.html`, `admin.js`'s own
`start()` runs against it, and what is asserted is the rendered DOM, so an id
that stops matching between the markup and a module fails there rather than in
front of an officer. It is a deliberate subset of a DOM: no layout, no CSS, and
a selector it cannot parse throws instead of quietly matching nothing.

`npm run mock` prints one URL per scenario. Each check-in token is a different
event:

| token | what it exercises |
|---|---|
| `gbm` | the plain path: pick your name, check in |
| `vol` | an event that collects a number, labelled from the category |
| `shirt` | an event that requires a photo |
| `drop` | requires a photo, and drops the submit connection once after the upload succeeded |
| `busy` | answers `PDS09` twice before accepting |
| `dupe` | answers `PDS05`, already checked in |
| `closed` | check-in has closed |
| `early` | check-in has not opened yet |
| `empty` | an empty roster, which is the state the system ships in |
| `oddstatus` | a `PDS01` arriving as an HTTP 500, which PostgREST may well do |
| anything else | `PDS01`, unknown or rotated token |

The mock serves `web/` as static files, so the page under test is the page that
ships. The single exception is `config.js`, where the two constants are rewritten
to point at the mock. Those two values are precisely what differs between local
and production anyway.

`http://localhost:8787/__mock/audit` shows every call either page made, every
record filed, any nonce violations, and the officer-side audit trail.

### The review queue, locally

There is no email in development, so the mock keeps the link it would have sent
and hands it over on request:

```
http://localhost:8787/admin/
http://localhost:8787/__mock/magic-link?email=sara@pdsaucf.com
```

Type the address into the sign-in form, then open the link that second URL
returns. Four accounts exist, and the differences between them are the point:

| address | role | what it can do |
|---|---|---|
| `sara@pdsaucf.com` | officer | the whole queue |
| `ben@pdsaucf.com` | admin | the queue, and publishing a requirement set |
| `advisor@ucf.edu` | viewer | reads the queue, decides nothing, and sees no account claims |
| `priya@knights.ucf.edu` | member | refused, and told where their own points are |
| anything else | none | no link is sent, and the form says the same thing either way |

The fixtures put 43 routine check-ins and one of every triage flag into the
queue, so no branch of the card renderer is unexercised.

## Things that are load bearing

### The client nonce

`get_checkin_context` mints a `client_nonce`. It has to be passed to
`search_members`, `create_evidence_upload` **and** `submit_checkin`.

Dropping it breaks nothing visible. The database silently falls back to the
rate-limit bucket that everybody at the event shares, because they all scanned
the same QR code, and one browser retrying in a loop then spends the whole
crowd's allowance. It works in every test and fails at a 167-person GBM.

Because that failure is invisible, it is asserted two ways in `mock/verify.mjs`:
against the source of `src/checkin.js`, and against a mock server that refuses
any guarded call arriving without a nonce it issued. Do not relax either one.

### Retries are not one policy

A dropped connection and a `PDS09` need different patience, so `src/api.js`
keeps two budgets. Transport failures back off over about ten seconds. Rate
limits back off over about seventy, because the limiter counts per calendar
minute and a full bucket clears when the minute rolls over rather than easing
off gradually. Giving up in ten seconds would show an error to somebody whose
only problem is that they arrived inside a full window.

### A photo is never taken twice

Uploading and submitting are two steps, and the second can fail after the first
succeeded. The compressed bytes stay in memory and the upload grant is written
to `sessionStorage`, so a failed submit, an automatic retry and a full page
reload all reuse the photo already sitting in the bucket. Only a `PDS04` on
submit, which means the grant really is gone, asks for a new one.

### POST, not PUT, to Storage

The bucket policies in `supabase/migrations/20260811101200_storage.sql` grant
`anon` an INSERT on `storage.objects` and nothing else. On the Storage API,
`POST /object/{bucket}/{path}` is the insert and `PUT` is an update, so a PUT
would be refused by RLS. A repeated POST after a lost response answers `409
Duplicate`, which `api.js` reads as "already there" rather than making somebody
retake a photo that is in the bucket.

### An unmatched check-in is a dead end unless the screen prevents it

`attendance_records` carries `check (status <> 'approved' or member_id is not
null)`, so a check-in with a typed-in name **cannot** be approved, and
`review_records()` raises `PDS06` if you try. The review queue therefore does not
offer Approve on those cards at all, and the `A` shortcut says what to do instead
of sending a call that is certain to be refused. Once a name is linked, the same
card turns into an approvable one with Approve focused, so the second decision is
one keystroke rather than a page reload.

That the Approve button is absent, and that the shortcut sends nothing, are both
asserted in `mock/verify-admin.mjs`. They are what stands between an officer and
a refusal they can do nothing about.

### The client never writes `status`

RLS would in fact allow it: `attendance_write_officer` is `FOR ALL`. Approve and
reject go through `review_records()` anyway, and linking goes through
`resolve_unmatched()`, because those functions are also what stamp the reviewer,
write the `audit_log` row, and refuse the approvals that have to be refused. The
absence of a direct write is asserted against the source, since nothing else
would notice it coming back.

### The board never does its own arithmetic

`point_total` and `is_honorary` are read from `v_member_status`, and each cell
from `v_member_category_totals`. Nothing under `src/` sums a category or decides
who is honorary, which is invariant 2 and the reason the engine is in Postgres.

The trap is that a board which added up its own columns would look completely
normal. It would also be wrong for every member with volunteering hours, because
the point total excludes them (`counts_toward_point_total` is false on that
category) while the column still shows them. So `verify-board.mjs` asserts that
the visible cells deliberately do NOT sum to the visible point total, on more
than twenty members. A client doing its own arithmetic could not produce both
numbers.

### A refused PATCH is a 200

PostgREST answers an UPDATE whose policy matches no row with `200` and an empty
array, not an error. Every write in `src/rest.js` therefore asks for
`return=representation` and every caller counts the rows that came back.

The live case is the requirements editor: `req_sets_write` admits an officer for
drafts only, so an officer's edit to a published set comes back as a 200 with
nothing in it, and without the count the screen would report a save that never
happened.

Account claims used to be the example here. They are not any more: `Confirm` and
`Decline` both go through `review_member_claim()`, which returns what it did,
and `src/claims.js` writes no table at all.

## House rules

- **No em dashes anywhere.** `grep -rn $'\xe2\x80\x94' web/` must return nothing.
  `npm run lint:no-em-dash` runs it.
- **Public Sans, self hosted**, `font-display: swap`, no CDN and no Google Fonts
  link. The woff2 file is not in the repo yet: see
  `assets/fonts/public-sans/README.md`. Both pages fall back to
  `ui-sans-serif, system-ui, sans-serif` until it is added.
- **Nothing anonymous touches a table.** Only the four RPCs, and the one Storage
  path a grant reserved. The admin screens are the opposite case and read tables
  directly, behind a login and behind RLS.
- **No jargon on screen.** Not "schema", not "node", not a raw triage flag name.
  `src/flags.js` is where the database's vocabulary is translated into an
  officer's, and the check in `mock/verify-admin.mjs` holds the line.
