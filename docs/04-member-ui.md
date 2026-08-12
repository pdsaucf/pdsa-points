# Member portal

Same static site, route `/me`. Members sign in and see their own progress toward
Honorary Member.

This is also the cheapest fix for the failure mode that drove the review decision: a
member who can see their own record notices a missing credit themselves, instead of it
staying invisible until nobody catches it.

## The sign-in problem, and the claim flow

Magic-link auth needs an email per member. **The imported 2025-26 roster has none**: the
workbook carries names only, so 355 members arrive with `email IS NULL`. Requiring
officers to source 355 email addresses before the portal works would stall it
indefinitely.

So sign-in is a claim, not a lookup:

```
  member enters email  ─▶  magic link  ─▶  signed in
                                             │
                    ┌────────────────────────┴────────────────────────┐
                    │                                                 │
        email matches a member row                    no match on email
        exactly (case-insensitive)                            │
                    │                                         ▼
                    ▼                             "Which of these is you?"
            linked automatically,                  roster search, pick one
            portal is live now                              │
                                                            ▼
                                              claim filed, officer approves
                                              (one click, in the review queue)
```

Once officers start collecting emails on new members, the top path is the normal one and
nobody waits. For the imported backlog, it costs one officer click per member, spread
over whenever each person first signs in.

```sql
create table member_claims (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  member_id   uuid not null references members,
  status      text not null default 'pending',   -- pending | approved | rejected
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users,
  reviewed_at timestamptz
);
create unique index one_live_claim_per_user
  on member_claims (user_id) where status <> 'rejected';
create unique index one_live_claim_per_member
  on member_claims (member_id) where status <> 'rejected';
```

The second index is the one that matters: two people cannot both hold a live claim on
Abigail Catto's record.

A claim is what stops someone signing in as themselves and reading another member's
record. Until it is approved, `profiles.member_id` stays null and the portal shows
"waiting for an officer to confirm this is you", not somebody's data.

## What a member sees

```
┌──────────────────────────────────────────────────────────────────────────┐
│ PDSA Points                              Abigail Catto      Sign out     │
│                                                                          │
│ Honorary Member 2025-2026                              10 of 11 met      │
│ ████████████████████████████████████████████████░░░░░                    │
│                                                                          │
│ ✓ GBMs                     9 of 9                                        │
│ ✓ Volunteering             29.5 of 25 hours                              │
│ ○ Clinical Workshops       4 of 5          one more to go                │
│ ✓ Non-Clinical Workshops   6 of 5                                        │
│ ✓ Socials                  7 of 6                                        │
│ ✓ Dental School Visits     5 of 5                                        │
│ ✓ Fundraising              5 of 5                                        │
│ ✓ Partial Proceeds         5 of 5                                        │
│ ✓ Tabling                  2 of 2                                        │
│ ✓ Editorial Points                                                       │
│     ✓ Speaking             1 of 1                                        │
│     ✓ Writing              1 of 1                                        │
│                                                                          │
│ 45 points total                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The list is generated from the published requirement set, so a category added in
September appears here in September with no code change. Nothing about the 2025-26
categories is baked into this screen.

### Their record

```
┌──────────────────────────────────────────────────────────────────────────┐
│ My records                                    [ Something's missing? ]   │
│                                                                          │
│ Mar 12   Zumba Night           Social                     ⏳ in review    │
│ Mar 05   Soap Carving          Clinical Workshop, Social  ✓ counted      │
│ Feb 26   Nothing Bundt Cakes   Partial Proceeds           ✗ not counted  │
│            "Receipt photo was for a different location"                  │
│ Feb 16   Spring GBM 4          GBM                        ✓ counted      │
└──────────────────────────────────────────────────────────────────────────┘
```

Three things here matter more than they look:

- **Pending submissions are visible.** "I checked in, did it work?" is answerable by the
  member, at 8pm, without emailing anyone.
- **Rejections show their reason.** The `review_note` an officer typed is the thing the
  member actually needs, and hiding it just generates an email asking for it.
- **Multi-category events show every category they earned.** Soap Carving counting twice
  is visible, so it looks correct rather than looking like a bug.

### "Something's missing?"

Opens a short form: pick the event from a list, add a note, submit. That files an
ordinary `attendance_records` row with `status = 'pending'` and
`source = 'member_request'`, flagged `member_requested`, landing in the same review
queue as everything else.

This deliberately reuses the existing machinery instead of adding a support inbox. An
officer approving a missing-credit request is doing the exact same action, in the exact
same screen, as approving a check-in.

## Security

Members are the narrowest role in the system. `profiles.role = 'member'` joins the
existing enum, and every policy is keyed on `profiles.member_id`:

| Table | Member can |
|---|---|
| `members` | read own row, edit preferred name and email only |
| `attendance_records` | read own rows; insert only via the missing-credit RPC |
| `attendance_evidence` | read own rows |
| `v_member_status`, requirement views | read own row only |
| `member_claims` | read own row |
| everything else | nothing |

Two specifics worth stating:

- **A member can never see another member's progress or the roster.** There is no
  leaderboard, and the progress board stays officer-only. The check-in autocomplete is
  the only place a name search exists, and it returns names only.
- **A member cannot approve anything**, including their own missing-credit request. The
  status column is set by RPC, never by a client write.

## Scope

One block, sequenced after the requirements engine, because the progress screen renders
whatever the published rule tree says and there is no point building it against
hardcoded categories.

Concretely: magic-link auth, the claim flow plus its officer approval, the progress
screen, the record list, the missing-credit request, and member-scoped RLS.
