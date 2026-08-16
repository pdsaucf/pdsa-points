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

### The functions the flow is made of

Every step above is a `SECURITY DEFINER` RPC, because every step does something the
caller's own policies forbid. They are defined in `..._member_portal.sql` and
enumerated in [01-data-model.md](01-data-model.md) section 8.

| Step | Function |
|---|---|
| signed in, first request of the session | `start_portal_session()` |
| "which of these is you" | `search_roster_for_claim(q)` |
| the member picks one | `file_member_claim(member_id, note)` |
| the officer's queue | `list_pending_claims()` |
| the officer's one click | `review_member_claim(claim_id, decision, note)` |
| "Something's missing?" | `request_missing_credit(event_id, note, value)` |

`start_portal_session()` is the one that carries the branch in the diagram. A signed-in
account has no `profiles` row until something creates one, and nothing else in the
schema does, so this creates it with role `member` (**not** the `viewer` column default,
which is read-only staff and can see the whole club) and links it when the address
matches. It never changes a role that already exists, never moves a `member_id` that is
already set, and never links a member another profile holds, so calling it on every page
load is a read in every case except the first.

An officer whose account never got a `profiles` row comes out of it a member. That is
deliberate: `fn_current_role()` was already null for them, so they had no officer rights
to lose, and an admin now updates the role rather than inserting it.

Two notes carried by a claim, not one. `member_claims.note` is the member's own words and
is shown back to them; `review_note` is why an officer declined. Same split, and same
reason, as `member_note` against `review_note` on an attendance record.

**The roster moves while a claim waits.** That gap is the design, not a defect: one
officer click per member, whenever each person first signs in. But the days in between
are exactly when roster cleanup happens, so `review_member_claim()` revalidates the
member at approval instead of trusting the check made when the claim was filed.

- **Merged**: followed to the survivor, the same bounded walk
  `upsert_member_and_enroll()` does. A merge means the row moved, not that the person
  stopped existing, and `merge_members()` took every attendance record with it. Linking
  to the tombstone would hand somebody an empty portal. The claim keeps naming the row
  the member actually picked; the resolved id is reported in the audit row instead.
- **Archived**: refused. `search_roster_for_claim()` already declines to offer archived
  rows, so approving one would leave the two halves of one rule disagreeing.

A claim can also be POSTed straight to `member_claims`, since `claims_insert_own`
permits it, skipping `file_member_claim()` and its checks. That is why those checks are
made again at approval, which is the step that actually grants the read, and why the
500-character limit on `note` is a check constraint on the column as well as a readable
refusal in the function. A cap enforced in one of two write paths is not a cap.

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

Opens a short form: pick the event from a list, add a note, submit. That calls
`request_missing_credit()`, which files an ordinary `attendance_records` row with
`status = 'pending'` and `source = 'member_request'`, flagged `member_requested`, the
note in `member_note`, landing in the same review queue as everything else.

It refuses an event the member is not enrolled for, an unpublished one, and a second
request for an event they already have a live record on. A member who is asking about an
event from a year they were not on the roster for has made a mistake at the point of
asking, and saying so beats filing a record that will be declined later.

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
  leaderboard, and the progress board stays officer-only. Two name searches exist and
  no more: the check-in autocomplete (`search_members()`) and the claim screen
  (`search_roster_for_claim()`). Both return names and ids and nothing else, both cap
  at ten rows and three letters, and both are rate limited. The claim search is open
  only to an account that is not yet linked, and it hides anybody already linked or
  already claimed, so it is strictly narrower than the anonymous one the check-in page
  already exposes.
- **A member cannot approve anything**, including their own missing-credit request. The
  status column is set by RPC, never by a client write.

## Scope

One block, sequenced after the requirements engine, because the progress screen renders
whatever the published rule tree says and there is no point building it against
hardcoded categories.

Concretely: magic-link auth, the claim flow plus its officer approval, the progress
screen, the record list, the missing-credit request, and member-scoped RLS.
