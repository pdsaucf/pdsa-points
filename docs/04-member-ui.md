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
 their points   "Which one is you?"      "Not on this years roster.
                (told apart by the        Ask an officer."
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
(migration 23) hands back every published event of the year, by category, with attended,
waiting, declined, upcoming or nothing next to each one, for the member looked up. It
still carries none of an officer's context: no decline reason, no flags, no reviewer, no
photo, no other member. That boundary is tested the same way the rest of this file is.

## The five functions the page is made of

Every one is a `SECURITY DEFINER` function that any caller may execute, including one
holding nothing but the anon key. Four are defined in `..._public_member_portal.sql`
(migration 21); `portal_attendance()` is `..._member_event_history.sql` (migration 23).

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
│ ┌──────────────────────────────┐ │
│ │ What is an Honorary Member?  │ │
│ │ Honorary Members are those   │ │
│ │ who go above and beyond to   │ │
│ │ be an active and valuable    │ │
│ │ member to PDSA. To reach     │ │
│ │ Honorary Member status,      │ │
│ │ certain requirements must be │ │
│ │ met.                         │ │
│ │                              │ │
│ │ GBMs                     9   │ │
│ │ Volunteering            25   │ │
│ │ Socials                  6   │ │
│ │ Speaking                 1   │ │
│ │   Journal Club,              │ │
│ │   Media Speaking             │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

Both lists are generated from the published requirement set, so a category added in
September appears in September with no code change. Nothing about this year's categories
is baked into the page, and `mock/verify-portal.mjs` renames a requirement mid-run and
requires the screen to follow it.

The box at the bottom is what the page says before anybody has typed anything, which is
the common case for somebody who followed a link from a group chat.

## Your events

Below the scorecard, one collapsible section per category, drawn from
`portal_attendance()` once the points have already loaded. The figures are the answer;
this is the detail behind them, so it is fetched after and fails silently if it does not
come back, the same as the requirements box does.

```
┌──────────────────────────────────┐
│ ▾ GBMs                        9  │
│    Fall GBM 1        Sep 4     9 │
│    Fall GBM 2        Sep 18      │
│ ▸ Volunteering                30 │
│ ▸ Clinical Workshops           6 │
└──────────────────────────────────┘
```

Every published event of the year is a row, grouped under the category it counts for. An
event linked to two categories, like Soap Carving, is a row under both. What is in the
last column:

| Status | Shown as |
|---|---|
| approved | the credit earned, the spreadsheet's `1` |
| pending | `Waiting` |
| rejected | `Declined` |
| no record, not yet held | `Upcoming` |
| no record, already held | blank, the spreadsheet's blank cell |

A section the member has any record in opens; one they have never touched stays shut with
its total on the summary line. A club year is on the order of a hundred events across
thirteen categories, and drawn flat that is a page nobody scrolls to the bottom of. Their
own history is never behind an interaction they have to discover; the events they have
not been to are.

Where more than one `attendance_records` row exists for the same event (a rejection
followed by a fresh check-in, which `one_live_record_per_member_event` permits because a
rejected row sits outside that index), the live row wins. A member who was turned down,
fixed the problem and checked in again reads where they stand now, not the state that was
superseded.

Nothing here is denormalised. The title, the date and the credit are read from `events`,
`event_categories` and `v_attendance_credit` on every call, keyed off `member_id`, so
renaming an event, moving its date, or merging a duplicate member into another all show up
with nothing to run. `test/public_portal.test.mjs` proves this by doing exactly those
three things and reading the answer back, rather than assuming a live join implies it.

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

## The root, and the officer door

`points.pdsaucf.com/` forwards here. The bare address is what a member types and what
gets pasted into a group chat, so the root is the portal; a URL that still carries `?e=`
is forwarded to `/c/` with the query intact, since a token only means check-in.

The emblem at the top of this page is a link to `/admin/`. Officers are told to tap the
logo, which is less to explain than a path to type, and most of them are opening the site
on a phone. Nothing on screen labels it: a member has no use for it, and the page has no
room for a control that is not theirs. This hides the door, it does not lock it. The
passcode and the role guard behind `/admin/` are the gate, and they are unchanged by
anyone finding the link (docs/06-officer-passcode.md).

`mock/verify-portal.mjs` holds the door to three things: it opens `/admin/`, it is named
for a screen reader, and it draws no text on screen.

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

## What is left of the old design

The claim machinery in migration 18 (`start_portal_session()`, `search_roster_for_claim()`,
`file_member_claim()`, `review_member_claim()`, `list_pending_claims()`,
`request_missing_credit()`) is still in the database and is called by nothing. It was left
in place rather than dropped: dropping it is a migration that can be written any time, and
`member_claims` still holds the claims that were filed. The officer-facing Account claims
tab and the member-facing claim screens are gone from the client.

`members.email` is likewise still a column, holding whatever was imported into it. Nothing
reads it and nothing writes it.
