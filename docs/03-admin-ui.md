# Admin UI: flows and wireframes

Audience: a non-technical student secretary who currently ticks boxes in a
spreadsheet. Target feel: **spreadsheet-simple, six screens, no jargon**. The word
"schema" never appears in the UI; neither does "node".

## Navigation

```
points.pdsaucf.com/admin
┌──────────────────────────────────────────────────────────────────────────┐
│ PDSA Points   [2025-2026 ▾]        Dashboard  Review 12  Events          │
│                                    Requirements  Members  Progress   BL ▾│
└──────────────────────────────────────────────────────────────────────────┘
```

The year selector is global and always visible, and every screen is scoped to it, so
"why do the numbers look wrong" is answerable at a glance.

---

## 1 · Dashboard

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐             │
│  │ 12         │ │ 355        │ │ 45         │ │ 134        │             │
│  │ to review  │ │ members    │ │ honorary   │ │ events     │             │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘             │
│                                                                          │
│  ⚠ Needs attention                                                       │
│   • "Media Speaking" has no requirement in 2025-2026        [ Fix ]      │
│   • "Volleyball" (Mar 12) has no category assigned          [ Fix ]      │
│   • Check-in still open for "Spring GBM 4" (ended 6d ago)   [ Close ]    │
│                                                                          │
│  Recent activity                                                         │
│   14:02  Sara approved 23 check-ins for Spring GBM 5                     │
│   13:47  Ben created "Zumba Night" (Socials)                             │
└──────────────────────────────────────────────────────────────────────────┘
```

The "Needs attention" panel is `v_config_warnings`. This is the anti-drift mechanism
made visible. The dead `President Workshops` tab and the mislabelled `PDSA Post`
columns would both have shown up here on day one.

---

## 2 · Review queue

**Every submission is reviewed by a human.** The queue's job is to make sure the
routine ones cost one click and the broken ones are impossible to miss, so it splits
into two zones by the triage flags, rather than presenting 47 identical rows.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Review        Event [ Spring GBM 5 ▾ ]                     47 pending    │
│                                                                          │
│ ⚠ Needs a decision · 4                                                   │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ "Abby Cato" typed in, no roster match                    [photo]   │   │
│ │   Closest matches:  Abigail Catto 92%  ·  Abby Catterson 71%         │ │
│ │   [ It's Abigail Catto ]  [ Add as new member ]  [ Reject ]          │ │
│ ├──────────────────────────────────────────────────────────────────────┤ │
│ │ Marcus Okafor  ⚑ same photo he submitted for Spring GBM 4  [photo]   │ │
│ │   [ Compare ]  [ Approve anyway ]  [ Reject ]                        │ │
│ ├──────────────────────────────────────────────────────────────────────┤ │
│ │ Jordan Ruiz, no photo attached and this event requires one            ││
│ │   [ Approve anyway ]  [ Reject ]                                     │ │
│ ├──────────────────────────────────────────────────────────────────────┤ │
│ │ Tara Nguyen, not on the 2025-2026 roster            [photo]        │   │
│ │   [ Enroll & approve ]  [ Reject ]                                   │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│ ✓ Routine · 43        roster match · inside window · photo attached      │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                      │
│ │ [photo]  │ │ [photo]  │ │ [photo]  │ │ [photo]  │   … 39 more          │
│ │ A. Catto │ │ D. Silva │ │ P. Mehta │ │ L. Brown │                      │
│ │ ✓    ✗   │ │ ✓    ✗   │ │ ✓    ✗   │ │ ✓    ✗   │                      │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                      │
│                                      [ Approve all 43 ]  [ Show all ]    │
│                                                                          │
│ Click a photo to enlarge · J/K move · A approve · R reject               │
└──────────────────────────────────────────────────────────────────────────┘
```

Grid-first for the routine zone, because judging forty shirt photos is a visual task.
An officer scans the wall of photos, spots anything odd, and approves the batch.
Nothing is auto-approved: "Approve all 43" is still a person deciding, it's just one
decision instead of forty-three.

The flagged zone is where the failure modes you named get fixed, at the moment they're
visible:

| What went wrong | What the officer sees | One click does |
|---|---|---|
| Couldn't find their name, typed it | ranked fuzzy matches from the roster | links the record to the right member |
| Genuinely new member | same card | creates the member and links it |
| Same photo reused for two events | both photos side by side | reject, or approve with a note |
| Two roster rows for one person | flagged at submission, fixed on the Members screen | merge (see §5) |

**Reject** always asks for a one-line reason, stored in `review_note`. Six months later
"why doesn't Ana have credit for the March GBM" has an answer.

> Events also carry a `review_policy` column that can auto-approve, left in the schema
> for a category like Tabling where the stakes are low. It ships **off everywhere**, as
> an advanced toggle in the event editor. Default behaviour is review everything.

### Account claims

A second, much smaller tab in the same screen. When a member signs in to the portal with
an email that doesn't match their roster row, they pick themselves from the roster and
an officer confirms it:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Account claims · 3                                                       │
│  abigail.catto@gmail.com   says they are   Abigail Catto                 │
│    Roster email: none on file · 45 records · joined Aug 2025             │
│                                     [ Confirm ]  [ Not them ]            │
└──────────────────────────────────────────────────────────────────────────┘
```

Most members never generate one of these: if the email they sign in with matches their
roster email, they are linked automatically. Claims exist for the 355 imported members
who arrived with no email on file. See [04-member-ui.md](04-member-ui.md).

---

## 3 · Events

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Events   [+ New event]        Search […]   Term [ Spring 2026 ▾ ]        │
│ ──────────────────────────────────────────────────────────────────────── │
│ Mar 12  Zumba Night          Socials                     18  ● open  ⋯   │
│ Mar 10  Tabling              Tabling                      7  closed  ⋯   │
│ Mar 05  Soap Carving         Clinical Workshop, Social   69  closed  ⋯   │
│ Feb 26  Nothing Bundt Cakes  Partial Proceeds            31  closed  ⋯   │
└──────────────────────────────────────────────────────────────────────────┘
```

Note row 3: **two categories on one event**, visible and obvious. That single line is
what replaces hand-copying 69 names into two tabs.

### Event editor

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Soap Carving                                         [ Save ] [ Cancel ] │
│ Date [2026-03-05]   Term [Spring 2026 ▾]   Location [ HPA-1 205 ]        │
│                                                                          │
│ Counts toward                                          [+ add category]  │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ Clinical Workshops   credit [ 1   ] fixed                        [x] │ │
│ │ Socials              credit [ 1   ] fixed                        [x] │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│   (a Volunteering category would instead offer: "ask the member")        │
│                                                                          │
│ Check-in form                                                            │
│   ☑ Require photo:  ◉ member shirt   ○ receipt   ○ other                 │
│   ☐ Ask for hours                                                        │
│   Window  [2026-03-05 17:00] → [2026-03-05 21:00]                        │
│                                                                          │
│ Approval    ○ Approve automatically    ◉ Send to review queue            │
│             (auto is unavailable while a photo is required)              │
│                                                                          │
│ QR code   ▣▣▣  points.pdsaucf.com/c/7fK2pQ                               │
│           [ Print sheet ]  [ Download PNG ]  [ Rotate link ]             │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4 · Requirements (the engine, in plain English)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Requirements · 2025-2026           Status: Published   [ Edit as draft ] │
│                                                   [ Copy from 2024-2025 ]│
│ To be an Honorary Member, a member must meet  ( ◉ all  ○ at least [ ] )  │
│ of the following:                                                        │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ ⠿ GBMs                     at least [  9 ] events              63 ✓ ⋯│ │
│ │ ⠿ Volunteering             at least [ 25 ] hours               66 ✓ ⋯│ │
│ │ ⠿ Clinical Workshops       at least [  5 ] events              56 ✓ ⋯│ │
│ │ ⠿ Socials                  at least [  6 ] events              61 ✓ ⋯│ │
│ │ ⠿ Tabling                  at least [  2 ] events              58 ✓ ⋯│ │
│ │ ⠿ Editorial Points, meet ( ◉ all ○ at least [ ] ) of:            ⋯│    │
│ │     ⠿ Speaking   at least [ 1 ] from  ⟨Journal Club⟩ ⟨Media Speaking⟩│ │
│ │     ⠿ Writing    at least [ 1 ] from  ⟨PDSA Post⟩ ⟨Media Writing⟩    │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ [+ Add requirement]  [+ Add group]                                       │
│                                                                          │
│ Preview with today's data:  45 of 355 members would qualify  ( was 45 )  │
│                                     [ Save draft ]  [ Publish changes ]  │
└──────────────────────────────────────────────────────────────────────────┘
```

Everything an officer needs is on one screen, and it reads as sentences. The tree
structure is expressed purely as indentation and a drag handle. Nobody is told they
are editing a node graph.

Three details that matter:

- **"at least 1 from ⟨Journal Club⟩ ⟨Media Speaking⟩"** is how the multi-category
  threshold surfaces. Adding a fourth editorial source is dragging in a chip.
- **The live preview** ("45 of 355 would qualify, was 45") is the safety rail. Nobody
  changes a threshold blind, because the consequence is on screen before publishing.
- **Publish is explicit.** Drafts change nothing; publishing bumps the version and
  freezes the previous one, so last year's results never silently re-compute.

---

## 5 · Members

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Members  355         Search […]      [+ Add ]  [ Import CSV ]  [ Export ]│
│ ──────────────────────────────────────────────────────────────────────── │
│ Abigail Catto      abigail@…    45 pts   10/11 reqs   ● active       ⋯   │
│ Aaron Ozan         aaron@…       6 pts    0/11 reqs   ● active       ⋯   │
└──────────────────────────────────────────────────────────────────────────┘
```

CSV import previews every row and shows fuzzy matches against existing members
("**Abby Catto** looks like **Abigail Catto**: same person, or new member?") before
committing anything. Roster cleanliness is the one thing today's setup gets right; it
must not regress.

### Duplicate people

A banner appears whenever the roster contains likely duplicates, using trigram similarity on
name, plus exact matches on email or NID. This is the other half of the "duplicates
happen" problem: the review queue stops one person checking in twice for one event, and
this stops one person existing twice on the roster.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 2 possible duplicates                                                    │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ Abby Catto       6 records   joined Jan 2026   abby.catto@ucf.edu    │ │
│ │ Abigail Catto    45 records   joined Aug 2025   abigail@knights…     │ │
│ │          [ Same person → merge into Abigail Catto ]  [ Not a dupe ]  │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

Merging moves every record onto the survivor, drops collisions where both rows have a
record for the same event, and leaves a tombstone so old links still resolve. It's
recorded in `member_merges` with who did it. **Not a dupe** is remembered, so the same
pair never nags twice.

### Member detail

Per-category progress bars, the Honorary checklist with pass/fail per requirement, and
a full record log, with every row showing event, date, credit, source
(*scanned / entered by officer / imported*) and who approved it. This is the screen
that answers a member emailing "I think I'm missing a GBM".

Officers can add a record here manually (`source = 'officer_entry'`), which is how the
current spreadsheet workflow actually operates and must keep working.

---

## 6 · Progress board (replaces the Total + Honorary tabs)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Progress · 2025-2026    [ Honorary only ▾ ] [ Search ]    [ Export CSV ] │
│ ──────────────────────────────────────────────────────────────────────── │
│ Member          Pts  GBM  Vol  Clin  NonC  Soc  Vis  Fun  PP  Tab  E  ★  │
│                      /9   /25  /5    /5    /6   /5   /5   /5  /2   /2    │
│ Abigail Catto   45   9✓  29.5✓ 4      6✓    7✓   5✓   5✓   5✓  2✓   2✓ ✗ │
│ Aaron Ozan       6   1    0     2     1     1    0    1    0   0    0  ✗ │
└──────────────────────────────────────────────────────────────────────────┘
```

Sticky first column, cells showing `value` against the threshold, ✓ when met, ★ for
Honorary. Same information as the old two tabs, computed in Postgres, never stale, and
one click to CSV for whoever still wants a spreadsheet.

---

## Member-facing check-in (the QR flow)

```
  scan QR ──▶  /c/7fK2pQ
                 │
                 ├── token unknown / rotated ─▶ "This code is no longer valid"
                 ├── outside window ──────────▶ "Check-in for this event is closed"
                 ▼
        ┌────────────────────────────────┐
        │  Spring GBM 5                  │      3 chars minimum before any
        │  Thursday, March 12            │      result appears; max 10 results;
        │                                │      no emails ever returned
        │  Your name                     │
        │  [ cat…              ]         │
        │   ▸ Abigail Catto              │
        │   ▸ Catherine Diaz             │
        │   ─────────────────────────    │
        │   ▸ I don't see my name        │ ──▶ full name + email,
        │                                │     goes to review to be matched
        │  Photo in your PDSA shirt      │
        │  [ 📷 Take photo ]             │  ← compressed to ~200 KB before upload
        │                                │
        │        [   Check in   ]        │
        └────────────────────────────────┘
                 ▼
        "Thanks, Abigail. Submitted for review."
```

Three taps, no login, and **no free-text name on the normal path**. You pick yourself
from the roster, so a misspelling can't quietly create a phantom person who never gets
their point. The escape hatch exists for people who genuinely aren't findable (new this
semester, goes by a nickname, changed their last name); those land in the flagged zone
of the review queue and an officer links them in one click.

Search is trigram-based and matches against preferred names too, so "abby", "catto"
and "catto, abigail" all find Abigail Catto before anyone needs the escape hatch.

Submitting twice is caught by the unique index and answers "you're already checked in"
rather than throwing an error.

---

## 7 · Photo storage & clearing

Purging is an action a person takes, not a job that runs. This lives under Settings,
and surfaces on the dashboard once there's something worth doing.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Photo storage                                                            │
│                                                                          │
│ 2,431 photos · 512 MB                                                    │
│ ████████████████████░░░░░░░░░░░░░░░░░░░░  512 MB of 1 GB                 │
│                                                                          │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ Ready to clear                                                       │ │
│ │ 318 photos from 11 events before March 2025.                         │ │
│ │ All of them have been reviewed. Frees about 64 MB.                   │ │
│ │                                              [ Review and clear… ]   │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│ Keep photos for [ 12 months ▾ ] after the event                          │
│ Photos are never deleted automatically. Someone has to clear them.       │
│                                                                          │
│ Previously cleared                                                       │
│   2026-01-14   Ben Le    412 photos    88 MB                             │
└──────────────────────────────────────────────────────────────────────────┘
```

**Review and clear…** opens a confirmation grouped by event, not a list of 318 files:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Clear photos from 11 events?                                             │
│  ☑ Fall GBM 1        Sep 4, 2024     48 photos                           │
│  ☑ Fall GBM 2        Sep 18, 2024    52 photos                           │
│  ☑ Menchie's         Oct 2, 2024     27 photos                           │
│  …                                                                       │
│                                                                          │
│ Attendance records, points and Honorary status are all kept.             │
│ Only the photos are deleted. This can't be undone.                       │
│                                            [ Cancel ]  [ Clear 318 ]     │
└──────────────────────────────────────────────────────────────────────────┘
```

Rules behind it:

- **Only reviewed photos are ever eligible.** A pending submission can't be purged out
  from under the queue, however old it is.
- **Officers and directors can run it**; every run is attributed in `purge_runs` and
  shown in the history above.
- **Per-event checkboxes** mean you can hold onto one event's evidence for an ongoing
  dispute, while clearing the rest.
- The retention window is a setting, not a constant. Twelve months is the default.

---

## Build phasing

| Phase | Contents | Rough size |
|---|---|---|
| **P0** Foundations | Migrations, RLS, roles, seed, import of 2025-26 | 1 block |
| **P1** Check-in | RPCs, QR page, member search, compression + upload | 1 block |
| **P2** Review queue | Triage flags, flagged/routine split, unmatched-name resolution, grid + lightbox, bulk approve/reject, audit | 1 block |
| **P3** Requirements engine | Node model, evaluator, editor UI, live preview | **2 blocks**, the real cost centre |
| **P4** Board + roster | Progress board, member detail, CSV import/export UI, duplicate detection + merge | 1 block |
| **P5** Member portal | Magic-link auth, account claims + officer approval, progress screen, record list, missing-credit requests, member RLS | 1 block |
| **P6** Ops | Storage screen + purge flow, keep-alive ping, backups | 1 block |

**Roster loading is not in P4.** The system starts with no members, so a bulk roster
path has to exist before the first event or that event's check-ins arrive as ~155
"add as new member" decisions. P0 therefore ships `scripts/import_roster.py`, a CSV
loader officers run once; the polished import UI stays in P4.

P3 is deliberately sized larger than the rest: a configurable rule tree with a
published/draft lifecycle and a live "who would qualify" preview is genuinely more work
than the ledger around it. Sequencing it after P2 means there's a working system
producing real data to preview against while it's built.

---

## Decisions, all settled

- **Review everything.** Auto-approve is off; the queue is triaged instead, so the
  routine records cost one click and the broken ones surface with a fix attached.
- **12-month retention, cleared by hand** from the storage screen. Nothing deletes
  itself.
- **Members get a portal.** Magic-link sign-in, their own progress toward Honorary,
  their own record list including pending and rejected items. See
  [04-member-ui.md](04-member-ui.md).
- **Stay on Supabase Storage.** Google Drive archival is designed and documented but not
  built; the schema already carries `provider` and `drive_file_id` so adding it later
  needs no migration. The tripwire is the 75% storage warning.

## House rules for the build

Two conventions apply to every screen, string and stylesheet, including the member
portal and the check-in page:

- **No em dashes anywhere in the product.** Not in UI copy, button labels, empty states,
  error messages, email templates, or seed data. Use a colon, a comma, parentheses, or a
  second sentence.
- **Inter throughout**, self-hosted from the repo as woff2 with `font-display: swap`.
  No Google Fonts link and no CDN: the site is static on GitHub Pages and should carry
  no external font dependency. `ui-sans-serif, system-ui, sans-serif` is the fallback
  stack behind it.

These are enforced in [CLAUDE.md](../CLAUDE.md) so the implementer and reviewers hold
the line.
