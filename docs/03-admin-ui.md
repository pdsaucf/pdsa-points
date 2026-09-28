# Admin UI: flows and wireframes

Audience: a non-technical student secretary who currently ticks boxes in a
spreadsheet. Target feel: **spreadsheet-simple, no jargon**. The word
"schema" never appears in the UI; neither does "node".

## Navigation

```
points.pdsaucf.com/admin
┌──────────────────────────────────────────────────────────────────────────┐
│ PDSA Points [2026-2027 ▾]  Events  Review 12  Progress  Members          │
│                            Settings ▾                   [ Search ⌘K ]  B │
└──────────────────────────────────────────────────────────────────────────┘
Settings: Honorary requirements, Event settings, Storage, Access
```

The app opens on Events. The year selector is global and always visible, and every
screen is scoped to it, so "why do the numbers look wrong" is answerable at a glance.
Officers see Events, Progress and Members; Review and Settings are admin-only
([07-officer-roles.md](07-officer-roles.md)). Access manages who may sign in, and
**Preview as** opens the officer screen, the member portal or the events page as that
audience sees it.

There is no dashboard. `v_config_warnings` exists in the database, and no screen reads
it yet.

---

## 1. Review queue

**Every submission is reviewed by a human.** The queue's job is to make sure the
routine ones cost one click and the broken ones are impossible to miss, so it splits
into two zones by the triage flags, rather than presenting 47 identical rows.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Review        Event [ Spring GBM 5 ▾ ]                     47 pending    │
│                                                                          │
│ ⚠ Needs a decision, 4                                                    │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ "Abby Cato" typed in, no roster match                    [photo]   │   │
│ │   Closest matches:  Abigail Catto 92%,    Abby Catterson 71%         │ │
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
│ ✓ Routine, 43        roster match, inside window, photo attached         │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                      │
│ │ [photo]  │ │ [photo]  │ │ [photo]  │ │ [photo]  │   … 39 more          │
│ │ A. Catto │ │ D. Silva │ │ P. Mehta │ │ L. Brown │                      │
│ │ ✓    ✗   │ │ ✓    ✗   │ │ ✓    ✗   │ │ ✓    ✗   │                      │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                      │
│                                      [ Approve all 43 ]  [ Show all ]    │
│                                                                          │
│ Click a photo to enlarge, J/K move, A approve, R reject                  │
└──────────────────────────────────────────────────────────────────────────┘
```

Grid-first for the routine zone, because judging forty shirt photos is a visual task.
An officer scans the wall of photos, spots anything odd, and approves the batch.
Nothing is auto-approved: "Approve all 43" is still a person deciding, it's just one
decision instead of forty-three.

A member-entered number is never Routine, even when every other check passes. The card
shows the category and entered value, and an officer approves it individually. Approve
all excludes it, and `review_records()` refuses any multi-record approval batch that
contains a member-entered value. Entering 99 awards nothing while the record is pending;
99 is awarded only after the officer explicitly approves that record.

The flagged zone is where the failure modes you named get fixed, at the moment they're
visible:

| What went wrong | What the officer sees | One click does |
|---|---|---|
| Couldn't find their name, typed it | ranked fuzzy matches from the roster | links the record to the right member |
| Genuinely new member | same card | creates the member and links it |
| Same photo reused for two events | both photos side by side | reject, or approve with a note |
| Two roster rows for one person | flagged at submission, fixed on the Members screen | merge (see §4) |

**Decline** always asks for a one-line reason, stored in `review_note`. Six months later
"why doesn't Ana have credit for the March GBM" has an answer.

> Events also carry a `review_policy` column that could auto-approve. Every event is
> `manual_review`, and no screen can change it (invariant 6).

> **There is no Account claims tab.** There was one, and it existed because the member
> portal was an account: a member signed in with an address, and an officer confirmed
> which roster row was theirs. Members have no email addresses and the club is not
> collecting any, so the portal is a name box now and there is nothing to confirm. See
> [04-member-ui.md](04-member-ui.md).

---

## 2. Events

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Events   Search […]   Show [ Any status ▾ ]  Order [ Newest ▾ ] [+ New]  │
│ (All 36)(GBMs 14)(Volunteering 3)(Socials 11)(Tabling 4)(No category 1)  │
│ ──────────────────────────────────────────────────────────────────────── │
│ Mar 12  Zumba Night          Socials, 1              18, 0  ● open  ⋯    │
│ Mar 10  Tabling              Tabling, 1               7, 0  closed  ⋯    │
│ Mar 05  Soap Carving         Clinical Workshop, Social 69, 2  closed  ⋯  │
│ Feb 26  Nothing Bundt Cakes  Partial Proceeds, 1     31, 0  closed  ⋯    │
└──────────────────────────────────────────────────────────────────────────┘
```

Note row 3: **two categories on one event**, visible and obvious. That single line is
what replaces hand-copying 69 names into two tabs.

**The tabs are built from the events, not from the category table.** A category
nothing this year is filed under gets no tab, because a tab that filters to an empty
list teaches an officer nothing. A retired category still gets one while last year's
events point at it, which is invariant 4 working: the history goes on resolving.

Search, Show and Order all run on the list already loaded. None of the three sends a
request, so a filter can never disagree with the row underneath it.

### 2.1. One event, in full

The title in a list row opens the event. Every other control on the row does one
narrow thing (print the code, change the fields); this is where the attendees are.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Back]  56 records   [QR] [Preview check-in] [Edit] [Duplicate] [Delete] │
│                                                                          │
│ Spring GBM 5                                                             │
│ Aug 11               ● Open    ⟨GBMs, 1⟩                                 │
│ Check-in has no close time                                               │
│                                                                          │
│ ┌────────┐┌────────┐┌────────┐┌─────────────┐┌───────────────┐           │
│ │ 43     ││ 11     ││ 1      ││ 8           ││ 12%           │           │
│ │Approved││Waiting ││Declined││ Not matched ││ Of the roster │           │
│ └────────┘└────────┘└────────┘└─────────────┘└───────────────┘           │
│ Scanned 54, Added by an officer 2, 2:00 PM to 2:40 PM                    │
│                                                                          │
│ Attendance  [Approve 11 waiting] [Add attendance] [Export CSV]           │
│ ──────────────────────────────────────────────────────────────────────── │
│ Aaron Ozan          Waiting   Scanned  2:40 PM  [Approve][Decline][Remove]│
│ "Abby Cato"         Waiting   Scanned  2:01 PM  [Review] [Decline][Remove]│
│  Member not matched                                                      │
│ Abby Catto          Approved  Scanned  2:07 PM           [Decline][Remove]│
└──────────────────────────────────────────────────────────────────────────┘
```

**The numbers are counts of rows, never a point total.** Approved, waiting, declined,
how many names nobody has matched, where the check-ins came from, and the first and
last one. Nothing on this screen sums a credit or decides whether anybody passed
anything: that is `v_member_status` and `fn_member_requirement_status`, and invariant
2 says so.

**A record with no member offers Review, not Approve.** `attendance_records` carries
`check (status <> 'approved' or member_id is not null)` and `review_records()` raises
PDS06, so approving one is refused by the database. Review opens the queue already
narrowed to this event, where the roster suggestions are.

**Approve and Decline go through `review_records()`.** Nothing here writes `status`,
for the same reason the queue does not: that function is what stamps the reviewer,
writes the audit row, and refuses the approvals that have to be refused.

**Pasted attendance goes through `add_officer_attendance_batch()`, in one transaction.**
The dialog accepts one name per line and uses the roster paste parser, including
surname-first names, pasted list markers, multiword surnames, line numbers, and repeated
lines. Its preview accounts for every nonblank line. Exact, unambiguous roster matches
are ready to add. Similar names and shared exact names require an explicit member choice
or an explicit `Not on roster` choice. Existing event records, invalid lines, and
repeated lines create nothing.

A preview choice belongs to the exact pasted text and normalized line. Editing,
inserting, deleting, or reordering lines clears it. Shared exact names show `Open
member` beside `Link member`, so the officer can inspect each record before choosing.
If a matching free-text attendance row predates roster enrollment, the line shows
`Needs review` and opens the event review queue. It never creates an approved duplicate.

The RPC accepts the resulting mixed batch and returns one outcome per line. Enrolled
members are inserted and their ids are handed to `review_records()`. Invariant 6 still
holds: the officer pressing Add is the person approving. Names not on the roster are
stored permanently as pending `officer_entry` records with `member_id = null`, their
cleaned display name in `claimed_name`, and `unmatched_name` in `flags`. They are not
members and they do not count yet. Two client calls would be wrong for two reasons:

- The insert commits, the approval fails, and records nobody was told about sit in the
  queue while the screen reports a failure.
- Whether the event wants a typed number is `event_categories.credit_mode`, which the
  screen reads when it opens. Change it from another laptop and the old client goes on
  filing `null` against a `from_submission` link. That is an approved record worth
  zero: nothing raises, nothing is violated, and the officer is told it worked. The
  function reads the event itself, under a lock, and refuses.

Each submission carries an opaque batch key. If the write commits but its response is
lost, `recover_officer_attendance_batch()` reads that officer's audit outcome for the
same event and key. Attendance snapshots can identify records that existed before the
call, but never prove that a new row belongs to the lost response.

**Approve N waiting counts only what it can send.** An unmatched record is waiting too,
and is exactly what the button cannot approve, so it is not in the number.

**Decline keeps the record, Remove deletes it.** `attendance_records` is one table
with a status precisely so un-approving is symmetric with approving and a rejection
keeps its reason. Remove is for a row that should never have existed.

**Remove goes through `remove_attendance_record()`, and writes the intent down before
anything is deleted.** Storage and Postgres are two systems with no transaction across
them, and no ordering the client can pick is safe. Object first is *photo destroyed,
record kept*: irreversible, and the record left behind still claims evidence. Record
first is *record gone, bytes left*, which looks recoverable and is not:
`purge_orphaned_uploads()` only considers grants with `consumed_at IS NULL`, and
`submit_checkin()` stamps `consumed_at` the moment a check-in is filed, so a real
submitted photo is invisible to it, and `purge_evidence()` cannot see it either once the
cascade has taken the `attendance_evidence` row.

So the RPC deletes the record and writes a `purge_runs` row naming its objects, in one
transaction, before the bucket is touched. The screen then does the same two-step
handoff every other purge does: delete the objects, call `finish_purge_run()`. A browser
that dies in between leaves an outstanding run, which the Storage screen already lists
and already knows how to finish, and the officer is told the photo is waiting on Storage
rather than being left to assume it went.

**Add attendance is the paper sign-in sheet.** The typed-value field stays visible when
the event collects a submitted number. The server locks and rereads that configuration,
and stores the same validated value on matched and unmatched rows.

**Delete is offered only on an event nobody checked in to.** `attendance_records.event_id`
is `on delete restrict`, so Postgres refuses the rest, and a button that comes back as
a refusal is not a button worth offering. If somebody checks in between this screen
loading and the button being pressed, the refusal re-reads the event, which is what
makes Delete go disabled instead of staying live over an event that can no longer be
deleted.

**Duplicate writes nothing.** It opens the New event form filled in from this one, on
today's date, so the copy is created by the ordinary Save path and gets its own
check-in token.

**The year selector closes this screen and the form.** Both belong to the year they
were opened in. An event left open under a different year lets an officer approve last
year's records while the top bar says otherwise, and a form saved after the switch
writes the event into the year they are no longer looking at, because
`academic_year_id` is read at Save. Both close, and a form that had been filled in says
so rather than vanishing.

**Preview check-in opens the same URL the QR code encodes**, in its own tab. Anything
else would be a second implementation of the page this screen exists to hand out. It
is the real check-in page, so a check-in made from it is a real check-in.

### Event editor

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Soap Carving                                         [ Save ] [ Cancel ] │
│ Date [2026-03-05]   Term [Spring 2026 ▾]                                │
│ Event starts [2026-03-05 18:00]  Event ends [2026-03-05 20:00]          │
│                                                                          │
│ Counts toward                                          [+ add category]  │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ Clinical Workshops   credit [ 1   ] fixed                        [x] │ │
│ │ Socials              credit [ 1   ] fixed                        [x] │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│   (credit [ ask the member ] is the other mode: they type the number)    │
│                                                                          │
│ Check-in form                                                            │
│   ☑ Require photo:  ◉ member shirt   ○ receipt   ○ other                 │
│   Window  [2026-03-05 17:00] → [2026-03-05 21:00]                        │
│                                                                          │
│ Approval    ○ Approve automatically    ◉ Send to review queue            │
│             (auto is unavailable while a photo is required)              │
│                                                                          │
│ QR code   ▣▣▣  points.pdsaucf.com/c/?e=7fK2pQ                            │
│           [ Print sheet ]  [ Download PNG ]  [ Rotate link ]             │
└──────────────────────────────────────────────────────────────────────────┘
```

Event start and end are entered in America/New_York and stored as instants. Both may
be blank, but one cannot be saved without the other and the end must be later. They are
the actual event schedule, not the check-in window, and duration never affects credit
or Honorary status. Location, attire and sign-up are free text shown on the public
events page ([05-events-page.md](05-events-page.md)).

---

## 3. Honorary requirements

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Honorary requirements, 2025-2026  Status: Published   [ Edit as draft ]  │
│                                                   [ Copy from 2024-2025 ]│
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ ⠿ GBMs                     at least [  9 ] from ⟨GBMs⟩         63 ✓ ⋯│ │
│ │ ⠿ Volunteering             at least [ 25 ] from ⟨Volunteering⟩  66 ✓ ⋯│ │
│ │ ⠿ Clinical Workshops       at least [  5 ] from ⟨Clinical…⟩     56 ✓ ⋯│ │
│ │ ⠿ Socials                  at least [  6 ] from ⟨Socials⟩       61 ✓ ⋯│ │
│ │ ⠿ Tabling                  at least [  2 ] from ⟨Tabling⟩       58 ✓ ⋯│ │
│ │ ⠿ Speaking     at least [ 1 ] from ⟨Journal Club⟩ ⟨Media Speaking⟩ ⋯│ │
│ │ ⠿ Writing      at least [ 1 ] from ⟨PDSA Post⟩ ⟨Media Writing⟩     ⋯│ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ [ Add requirement ]                         [ Discard draft ] [ Publish ]│
│                                                                          │
│ Preview with today's data:  45 of 355 members would qualify  ( was 45 )  │
│                                                                          │
│ Event categories                                                         │
│ New event category [ Journal Club                         ] [ Add ]       │
│ [ GBMs                                      ↑  ↓  Retire ]               │
│ [ Volunteering                              ↑  ↓  Retire ]               │
└──────────────────────────────────────────────────────────────────────────┘
```

Everything an officer needs is on one screen, and it reads as sentences. Nobody is
told they are editing a node graph.

**A category is a name.** The lower half of this workspace is a list of names in an
order, with Retire on each. It carried a "Measured in" picker (Events, Hours, Points) and a "Counts
toward points" checkbox until migration 22; the picker only ever changed the word beside
a number, and the checkbox was false for Volunteering hours alone. There is one unit and
it is points, so a requirement reads "at least 9 from GBMs" and the chips say what is
being counted.

**The list is flat.** The editor makes no groups and nothing nests. A requirement
already spans categories, so "Editorial Points, being Speaking and Writing" is two
ordinary rows measuring two categories each, and the level of nesting that shape
seemed to need bought nothing except a tree an officer had to hold in their head.
Every top-level requirement must pass. The structural root is not shown as a second
rule above the list. Sets written before this can still hold a group: those rows carry
**Ungroup**, which lifts what is inside them to the top level and then deletes the empty
group. Groups are never deleted with requirements still in them, because `parent_id`
cascades.

Four details that matter:

- **"at least 1 from ⟨Journal Club⟩ ⟨Media Speaking⟩"** is how the multi-category
  threshold surfaces. Adding a fourth source is one chip.
- **A category is made from inside a rule.** The picker on every requirement ends in
  "New event category", and the one it creates is attached to that requirement. It is
  the same row the lower half of this workspace manages, not a second kind of thing.
- **The live preview** ("45 of 355 would qualify, was 45") is the safety rail. Nobody
  changes a threshold blind, because the consequence is on screen before publishing.
- **Publish is explicit, and Discard draft is the way back.** Edits save as they are
  made, so undoing them means throwing the draft away: the published set is a
  separate row, and members go on being judged by it. Publishing bumps the version
  and freezes the previous one, so last year's results never silently re-compute.

---

## 4. Members

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Members  355   Search […]   [ Add ] [ Paste names ] [ Import CSV ] [ Export ]│
│ ──────────────────────────────────────────────────────────────────────── │
│ Abigail Catto        45 pts   ★   joined Aug 2025    [ Open ] [ Remove ] │
│ Aaron Ozan            6 pts       joined Aug 2025    [ Open ] [ Remove ] │
└──────────────────────────────────────────────────────────────────────────┘
```

**A member has no email address.** The column is still in the database holding what was
imported into it years ago, and nothing reads or writes it: no column here, no field on
Add, no cell in the CSV, and nothing asked at check-in. A name is the whole identity, and
`upsert_member_and_enroll()` matches on it (migration 20).

**Open** is on every row as well as on the name, because a name that happens to be
clickable is not an affordance anybody finds.

### Paste names

The way a club list actually arrives is a block of names in a message, and typing them one
at a time through Add is the reason a spreadsheet outlives every attempt to replace it. So
the paste box takes them as they come: one per line, bullets and numbering stripped,
`Bell, Marcus` read as `Marcus Bell`, a surname of several words kept whole.

Afterwards it reports what it did, and the parts add up to the number in the heading:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 24 names pasted                                                          │
│ 2026-2027                                                                │
│  19 added              Marcus Bell, Grace Okonkwo, Aisha Rahman, …       │
│   2 returning          Ada Levy, Sam Cole                                │
│   1 already on the roster   Abigail Catto                                │
│   1 repeated           Marcus Bell                                       │
│   1 skipped            Bob (needs a first and last name)                 │
│                                            [ Done ]                      │
└──────────────────────────────────────────────────────────────────────────┘
```

A line with one word cannot be written, because guessing which half is missing would put a
made-up surname on a real person, so those lines are reported rather than dropped.

CSV import previews every row and shows fuzzy matches against existing members
("**Abby Catto** looks like **Abigail Catto**: same person, or new member?") before
committing anything. Roster cleanliness is the one thing today's setup gets right; it
must not regress.

### Duplicate people

A banner appears whenever the roster contains likely duplicates, using trigram similarity
on name, plus exact matches on email or NID for the rows that still carry either. This is
the other half of the "duplicates happen" problem: the review queue stops one person
checking in twice for one event, and this stops one person existing twice on the roster.
With no address on a new row, it is also the only thing that can tell two people who
genuinely share a name apart, which is why merging and dismissing both live here.

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

### Retroactive matches

Somebody who attended before they joined used the Couldn't find their name path at
check-in (§ Review queue, above), so their earlier attendance sits unmatched, waiting on
`resolve_unmatched()` one record at a time. Adding them through single-member Add,
Paste names, or CSV import is the moment an officer already knows who they are, so it
is also the moment those records are offered back:
`fn_retroactive_match_candidates(member_id)` returns every unresolved
check-in that might be theirs, restricted to years they're actually enrolled in. A
claimed name that resembles theirs is reported as a resemblance, never as a certainty. (A
claimed address that matched the member's own used to be reported as an identity, and
still is for records filed before check-in stopped asking for one.) Nothing is linked until an officer confirms which ones are really theirs,
through `link_retroactive_matches()`, and confirming does not approve: the records stay
in the review queue exactly like every other pending record. A linked outcome offers
`Review` as the next action. Points enter the existing views only after approval through
`review_records()`.

Confirming a batch is not all-or-nothing. `link_retroactive_matches()` answers back one
outcome per record an officer confirmed, not a total, because "9 of the 10 you picked
worked" is not something an officer can act on without knowing which one didn't. A record
another officer rejected in the review queue after the candidate list loaded and before
Confirm was pressed comes back distinctly (not turned into credit, and not silently
skipped either), so a stale screen never reads as a success.

Asking about an archived member's earlier check-ins is refused outright: archiving already
said this is not somebody the club is tracking. Asking about a member who has since been
merged into somebody else follows the merge to the survivor, since that's where
`merge_members()` already moved the rest of their history.

### Member detail

Per-category progress bars, the Honorary checklist with pass/fail per requirement, and
a full record log, with every row showing event, date, credit, source
(*scanned / entered by officer / imported*) and who approved it. This is the screen
that answers a member emailing "I think I'm missing a GBM".

Officers can add a record here manually (`source = 'officer_entry'`), which is how the
current spreadsheet workflow actually operates and must keep working.

---

## 5. Progress board (replaces the Total + Honorary tabs)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Progress, 2025-2026    [ Honorary only ▾ ] [ Search ]    [ Export CSV ]  │
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
  scan QR ──▶  /c/?e=7fK2pQ
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
        │   ▸ I don't see my name        │ ──▶ full name, goes to review
        │                                │     to be matched
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

## 6. Photo storage and clearing

Purging is an action a person takes, not a job that runs. This lives under Settings.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Photo storage                                                            │
│                                                                          │
│ 2,431 photos, 512 MB                                                     │
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
- **Only an admin can run it**; every run is attributed in `purge_runs` and shown in
  the history above.
- **Per-event checkboxes** mean you can hold onto one event's evidence for an ongoing
  dispute, while clearing the rest.
- The retention window is a setting, not a constant. Twelve months is the default.

---

## Decisions, all settled

- **Review everything.** Auto-approve is off; the queue is triaged instead, so the
  routine records cost one click and the broken ones surface with a fix attached.
- **12-month retention, cleared by hand** from the storage screen. Nothing deletes
  itself.
- **Members get a portal.** No sign-in: a member types their name and sees their
  progress toward Honorary and this year's attendance. See
  [04-member-ui.md](04-member-ui.md).
- **Stay on Supabase Storage.** Google Drive archival is designed and documented but not
  built; the schema already carries `provider` and `drive_file_id` so adding it later
  needs no migration. The tripwire is the 75% storage warning.

## House rules

No em dashes, no middle-dot separators, Public Sans self-hosted, and the UI copy style.
All are requirements, written out in [CLAUDE.md](../CLAUDE.md).
