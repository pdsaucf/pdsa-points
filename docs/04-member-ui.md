# Member portal

Same static site, route `/me`. A member types their name and sees their own progress
toward Honorary Member, and a leaderboard of the whole club.

This is the cheapest fix for the failure mode that drove the review decision: a member
who can see their own record notices a missing credit themselves, instead of it staying
invisible until nobody catches it.

## There is no sign-in

**Members do not have email addresses, and the club is not collecting any.** The imported
roster carries names only. The first version of this portal was built around magic-link
auth and a claim flow: a member signed in, and either their address matched a roster row
or an officer confirmed which row was theirs. That whole apparatus existed to answer one
question, "which roster row is this person", from an address.

The question is now asked directly:

```
   member types First name + Last name
                    │
     ┌──────────────┼───────────────────────────┐
     │              │                           │
  one match     two matches               no match
     │              │                           │
     ▼              ▼                           ▼
 their points   "Which one is you?"      "Name not found"
                (told apart by the        Search leaderboard or contact PDSA
                 month they joined)
```

What that means, stated rather than left implicit: **anybody who can open the site can
read any member's category totals and whether they are honorary, by typing their name.**
That is a deliberate decision and it is the same one the leaderboard makes. The
spreadsheet this product replaces was a link anybody in the club could open, and the
totals on it were the whole social function of the point system.

What is deliberately NOT public:

- no email address, no student id, no notes
- no officer's decline reason, no flags, no reviewer, no reviewed timestamp
- no photo or other evidence
- nothing about anybody who is not on this year's roster

**A member's own event-by-event attendance for the current year is public**, once they
have typed their name. Migration 21 originally withheld this: "the individual records are
the part an officer needs and a stranger does not." The club asked for that reversed. The
spreadsheet this product replaces showed a member every event of the year and whether
they made it, and a point total alone cannot answer that. So `portal_attendance()`
hands back every published event once with categories and approved credit grouped into
that row, plus optional verified actual start and end instants. Attended, waiting,
declined, upcoming or nothing remains the member's status for each event. It
still carries none of an officer's context: no decline reason, no flags, no reviewer, no
photo, no other member. That boundary is tested the same way the rest of this file is.

## The five functions the page is made of

Every one is a `SECURITY DEFINER` function that any caller may execute, including one
holding nothing but the anon key. Four are defined in `..._public_member_portal.sql`
(migration 21). `portal_attendance()` originated in `..._member_event_history.sql`
(migration 23), and its current one-row-per-event contract is defined in
`..._event_times_and_portal_attendance.sql` (migration 25).

| What the page needs | Function |
|---|---|
| the name box | `portal_find_members(first_name, last_name)` |
| one member's points | `portal_scorecard(member_id)` |
| that member's event history | `portal_attendance(member_id)` |
| the leaderboard, with breakdowns | `portal_leaderboard()` |
| "What is an Honorary Member?" | `portal_requirements()` |

Functions rather than a grant on `v_member_status`, because a grant on the view would
hand `anon` the whole table through PostgREST's filter syntax. A function returns a shaped
answer to a shaped question, and `test/public_portal.test.mjs` reads the keys of those
answers rather than trusting the SELECT list.

Name matching is `fn_normalise_name()`, the same comparison the duplicate view and the
CSV import use, so `o halloran` finds `O'Halloran`. Both spellings of a roster name are
compared, the display name and first plus last, so a member whose row carries a preferred
name is found by either.

**The verdict is still Postgres's.** `portal_scorecard()` evaluates the published rules
through `fn_member_requirement_status()`, which is the same function `v_member_status`
uses for `is_honorary` and the same one the officer's member screen reads. Invariant 2
holds when the caller is a stranger with a phone.

## What a member sees

```
┌──────────────────────────────────┐
│  [ My points ]  [ Leaderboard ]  │
│                                  │
│  Abigail Catto      10 of 11 met │
│  ✓ GBMs                9 of 9    │
│  ✓ Volunteering     29.5 of 25   │
│  ○ Clinical Workshops  4 of 5    │
│  ✓ Socials             7 of 6    │
│  ✓ Tabling             2 of 2    │
│  ✓ Speaking            1 of 1    │
│  ✓ Writing             1 of 1    │
│                                  │
│  45 points          [ Not you? ] │
│                                  │
│  What is an Honorary Member?     │
│  Honorary Members are those who  │
│  go above and beyond as active   │
│  and engaged members of PDSA.    │
│                                  │
│  ┌────────────────────────────┐ │
│  │ Requirements               │ │
│  │ GBMs                    9  │ │
│  │ Volunteering           25  │ │
│  │ Socials                 6  │ │
│  │ Speaking                1  │ │
│  │   Journal Club,            │ │
│  │   Media Speaking           │ │
│  └────────────────────────────┘ │
│  ─────────────────────────────  │
│  About Honorary Membership       │
│  Why become an Honorary Member?  │
│  ...                             │
│  Do I have to become an Honorary │
│  Member? ...                     │
│  What does being an Honorary     │
│  Member represent? ...           │
└──────────────────────────────────┘
```

Both lists are generated from the published requirement set, so a category added in
September appears in September with no code change. Nothing about this year's categories
is baked into the page, and `mock/verify-portal.mjs` renames a requirement mid-run and
requires the screen to follow it.

The requirements sit in their own panel, the same shape as any other panel on this
screen, because they are the one part of this section that is genuinely structured data.
The introduction above it and the three questions below it are prose, so neither gets a
border: a rule and a heading ("About Honorary Membership") separate the two instead of
another box. One long bordered card reads as a single wall of text; a plain introduction,
a compact panel, and an open FAQ read as three things, which is what they are.

The three questions are fixed copy, not published rules: why the distinction is worth
having, that it is optional, and what it represents. They answer questions members
already ask officers, so the page answers them once instead.

This is what the page says before anybody has typed anything, which is the common case
for somebody who followed a link from a group chat.

## Attendance record

The successful result starts with the member name, academic year, server-computed
Honorary Status, number of published requirements met, total points, Download PDF, and
Not you?. The status value is `Earned` or `Not yet`, directly from the server verdict.
The Honorary Status label always carries the same small star used by the leaderboard;
an honorary member's name carries it as well. The visible status words remain the
accessible signal. Every published requirement follows with its current value, target,
and explicit Met or Not met status. None of those rules are calculated in the client.
The summary count is the number of non-group requirement rows whose server verdict is
Met out of all non-group requirement rows. It never substitutes a root group's N-of-M
value and never determines Honorary status.

The scorecard draws as soon as `portal_scorecard()` returns. Attendance loads
independently through `portal_attendance()`, with a visible retry if that request fails.
The attendance response also embeds a fresh public scorecard evaluated in the same
database statement snapshot as its event rows. Once it arrives, that atomic scorecard
becomes the final displayed and exported summary. Member and year ids must agree across
the envelope and embedded scorecard before Download PDF is enabled.

The `About Honorary Membership` Q&A shown below the initial lookup also follows the
successful attendance record. It is one shared section in the page, not a duplicated
copy, so its fixed answers cannot drift between states. The introductory `What is an
Honorary Member?` copy and general published Requirements stay on the initial screen;
successful results already carry the member-specific Requirement progress.

```
┌────────────────────────────────────────┐
│ [Approved 8] [Waiting 1] [Declined 1] │
│ Fall GBM 1  Sep 4  6:00 to 7:30 PM    │
│ 1 hr 30 min  GBMs: 1        Approved  │
│ Give Kids A Smile  Sep 2               │
│ Time not recorded  Volunteering: 5     │
└────────────────────────────────────────┘
```

Approved records are the default. Waiting and declined records remain available through
status filters and are never presented as completed attendance. Each event renders once,
newest first, with title, date, actual Eastern start and end times, duration, grouped
category credit, and attendance status. Desktop uses a semantic table and mobile uses
stacked cards. An event linked to two categories remains one row with both credits.

When either actual instant is missing, the row says `Time not recorded`. The check-in
window is never used to infer a schedule or duration. Event duration is informational
and does not enter points, requirement progress, or Honorary status. Event Location no
longer exists and appears nowhere in the response or page.

Where more than one `attendance_records` row exists for the same event, the live row
wins. A member who was declined, corrected the problem, and checked in again sees their
current status.

The current-year PDF is generated locally in the browser from the atomic attendance
response already loaded. It is never uploaded or stored. It includes the summary, requirement progress,
and approved events only, with one row per event. Recorded duration totals only events
with both actual instants and separately counts approved events with missing times. The
PDF embeds the locally bundled Public Sans TTF and a locally bundled Noto Sans fallback,
so accented and supported non-Latin text remains extractable without a CDN or runtime
external font request.

## The leaderboard

```
┌──────────────────────────────────┐
│  Leaderboard   2026-2027 · 64    │
│                                  │
│   1  Amir Petrov         ★   26  │
│   1  Daniel Nguyen       ★   26  │
│   6  Hannah Cheng        ★   23  │
│  12  Leah Ortiz              19  │
│        GBMs               12     │
│        Volunteering       45     │
│        Socials             9     │
│        Tabling             3     │
└──────────────────────────────────┘
```

One row per member: rank, name, the honorary star, the point total. Tapping a row opens
that member's per-category breakdown underneath it, one at a time.

The breakdown ships with the list rather than being fetched per row opened: a club is a
few hundred people and ten categories, and a request per tap would be hundreds of round
trips for numbers already in hand.

Ties share a rank, computed by `rank() over (order by point_total desc)`. A leaderboard
that numbers two equal totals 4 and 5 is a leaderboard arguing with itself.

## The root

`points.pdsaucf.com/` forwards here. The bare address is what a member types and what
gets pasted into a group chat, so the root is the portal; a URL that still carries `?e=`
is forwarded to `/c/` with the query intact, since a token only means check-in.

The emblem at the top of this page is a plain image, not a link. Officers reach
`/admin/` by its own address; the passcode and its shared authenticated session are the
gate, unchanged either way (docs/06-officer-passcode.md).

## Security

`anon` holds EXECUTE on the five functions above and on nothing else: not the evaluator
they call, not `fn_portal_year()`, and not one table, view or sequence.
`test/privileges.test.mjs` compares the anon surface against a written-out list, so
widening it again is a deliberate edit to that list rather than something that happens
quietly.

The one refusal these functions make is a member who is not on this year's roster:
`portal_scorecard()` and `portal_attendance()` both raise `PDS03` rather than answering
with zeroes, because a screen of zeroes reads as "you have attended nothing" when the
truth is "you are not on this year's list, go and see an officer".

Nothing on this page writes anything. There is no missing-credit form and no way for a
member to file a record: invariant 6 says every attendance record is approved by a person,
and the way a member raises a missing credit now is to tell an officer, who has the member
screen and the review queue for exactly that.

## Retired account design

Migration 24 removes the unused claim RPCs, `member_claims`, `profiles`, and the
application role enum. The public portal is anonymous and read-only, while `/admin/`
uses the one fixed shared GoTrue session.

`members.email` is likewise still a column, holding whatever was imported into it. Nothing
reads it and nothing writes it.
