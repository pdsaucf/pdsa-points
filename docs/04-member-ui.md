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
- no individual check-ins, so nothing pending and nothing declined
- no officer's decline reason
- nothing about anybody who is not on this year's roster

Approved credit is a total. The individual records behind it are the part an officer needs
and a stranger does not, so they are on the officer's member screen and not here.

## The four functions the page is made of

Every one is a `SECURITY DEFINER` function that any caller may execute, including one
holding nothing but the anon key. They are defined in
`..._public_member_portal.sql` (migration 21).

| What the page needs | Function |
|---|---|
| the name box | `portal_find_members(first_name, last_name)` |
| one member's points | `portal_scorecard(member_id)` |
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

## Security

`anon` holds EXECUTE on the four functions above and on nothing else: not the evaluator
they call, not `fn_portal_year()`, and not one table, view or sequence.
`test/privileges.test.mjs` compares the anon surface against a written-out list, so
widening it again is a deliberate edit to that list rather than something that happens
quietly.

The one refusal these functions make is a member who is not on this year's roster:
`portal_scorecard()` raises `PDS03` rather than answering with zeroes, because a screen of
zeroes reads as "you have attended nothing" when the truth is "you are not on this year's
list, go and see an officer".

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
