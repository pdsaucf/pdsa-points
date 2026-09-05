# Officer roles: what a Secretary may do and an Officer may not

Status: proposed, not built. Supersedes nothing. It reopens exactly one decision from
[06-officer-passcode.md](06-officer-passcode.md), the single shared account, and keeps the
rest of that document intact.

## What was asked

The Secretary keeps the admin screen as it is now: honorary requirements, and managing
members' attendance. Officers and directors get less: create events, see the roster count,
and see who attended each event, with no ability to add, edit or delete an attendance
record.

## The part that is not negotiable

**A hidden button is not a permission.** The admin page ships as readable JavaScript from a
public URL, and every screen in it talks to PostgREST with the caller's own JWT. An officer
who opens the console can call `remove_attendance_record()` whether or not the page drew a
Remove button, and nothing in the browser can stop them.

This is the same argument [06-officer-passcode.md](06-officer-passcode.md) already makes one
level down, about why the passcode cannot be compared in JavaScript. It applies unchanged
here. **Every rule below is enforced in Postgres, by RLS policies and by the assertions the
RPCs already call. The UI hiding is cosmetic, it exists so officers are not shown doors that
will not open, and it is never the thing that holds.**

Reviewers: a change that only hides a control has not implemented anything.

## The schema is already shaped for this

Nothing here invents a permission system. `fn_is_admin()`, `fn_is_officer()`,
`fn_is_staff()` and `fn_assert_officer()` are called throughout the policies and the RPCs
already. Migration 24 collapsed all three predicates into the same expression:

```sql
select fn_is_shared_admin()
    or (auth.uid() is null and current_user not in ('anon', 'authenticated'))
```

So today they are three names for one answer. The work is to make them answer differently
again, which is mostly a lookup, plus a deliberate pass over each policy deciding which
side of the line it sits on.

Migration 24 also dropped `profiles` and its per-user role. That table comes back, or
something like it: one row per officer, carrying a role.

## The roles

The existing `app_role` enum already has what this needs. No new role type.

| Person | Role | Reasoning |
| --- | --- | --- |
| Secretary | `admin` | Everything, exactly as the shared account can do today. |
| Officer, Director | `officer` | Events, and reading the club. |

`viewer` and `member` stay in the enum, unused, as they are now.

## Where the line falls

Officer means officer or admin, as it always has, so every officer row below is also an
admin row.

**Officer may:**

- Create, edit and duplicate events, including categories, the photo requirement, the
  check-in window and the QR token. `save_event_config()`, `events_write`,
  `event_categories_write`, `event_evidence_write`.
- Read the roster and the enrollment counts.
- Read every attendance record on an event, and the review queue, without acting on it.
- Read the audit log, merge history, purge history and upload grants, which are all
  already `select` policies.

**Admin only:**

- Every attendance write. `review_records()`, `add_officer_attendance()`,
  `remove_attendance_record()`, `recover_officer_attendance_batch()`, `resolve_unmatched()`,
  and the `attendance_admin` and `evidence_admin` policies.
- Honorary requirements, in full. `validate_requirement_set()`,
  `preview_requirement_set()`, `clone_requirement_set()`, and the `req_sets_*`,
  `req_nodes_write` and `req_node_cats_write` policies.
- Categories. An officer picks a category when building an event, and does not get to
  invent, rename or retire one, because a category is what requirements are written
  against. Read for staff, write for admin.
- Roster writes. `upsert_member_and_enroll()`, `merge_members()`, the import.
- Photo purging. `purge_evidence()`, `purge_orphaned_uploads()`, `finish_purge_run()`.
  Deleting photos is not something a permission boundary should leave to the wider board.
- Settings, including the events auto-publish toggle. The Monday drop is a fairness rule
  and the Secretary owns it.

### Two decisions to make on purpose

**Publishing an event.** `set_event_published()` is proposed as officer, on the grounds
that an officer who may create an event may announce it. The opposite reading is that
publication is the fairness-sensitive half and belongs with the Secretary alongside the
toggle. Pick one before building, not during.

**Seeing photos.** Evidence photos are attached to attendance records an officer may read
but not act on. Reading proposed for staff, deleting for admin only.

## The trap in `app_settings`

`settings_admin` is a single `for all` policy today. Restricting the whole of it to admin
breaks the officer's events screen, and not obviously.

`fn_setting_bool()` is not `SECURITY DEFINER`, so it reads `app_settings` as whoever
called it. It is called by `fn_event_is_visible()`, which is called by the `is_visible`
computed column that the admin events list selects on every load. An officer with no
`select` on `app_settings` gets no rows, the setting silently falls back to its default,
and the events list quietly misreports which events members can see.

**So `app_settings` splits: `select` for staff, writes for admin.** The same caution
applies to anything else reading a setting through a non-definer function.

## Signing in

The role has to attach to a person, which the single shared account cannot do. Three
options were weighed; see the session that produced this document for the full comparison.

**Chosen: Google sign-in, one account per officer**, with a `profiles` row carrying the
role, and a Secretary-only screen for managing that list.

Why, in short. Officers already have Knights accounts. Revoking somebody is deleting a
row, not rotating a secret for the whole board. And it returns something
[06-officer-passcode.md](06-officer-passcode.md) explicitly lists as lost under the shared
account: **the audit trail records an action, not a person.** `reviewed_by` and
`performed_by` become real again, which matters most for precisely the surface officers
are being kept out of.

What it costs, stated plainly: a Google Cloud OAuth client and consent screen, a redirect
that works from a static site on GitHub Pages, a first admin seeded by SQL because
somebody has to be able to grant the second one, and an honest screen for a stranger who
signs in with a valid Google account and holds no role.

**Rejected: two shared passcodes**, one per role. It is a few hours rather than a week and
it keeps the discreet single box, so it stays available as a stopgap. It is not the
destination, because it draws a permission boundary that one leaked passcode erases with
nobody able to tell. 06 already notes that a passcode spreads, gets texted, and outlives
the officer it was given to. Today that is an inconvenience. Once officers are deliberately
restricted, it is a hole with no signal.

**Rejected: per-officer passcodes.** GoTrue's password grant needs an account to compare
against, so the officer would type a name or an address next to the passcode. Two fields is
no longer the discreet screen 06 asked for, and at that point Google is better in every
other way.

## Order of work

The database half is load-bearing and is identical under any sign-in scheme. Build it
first, and the choice above stays swappable.

1. `profiles` and the role lookup, with `fn_is_admin()`, `fn_is_officer()` and
   `fn_is_staff()` reading it again, and the shared session kept working as `admin` so
   nothing breaks mid-migration.
2. The policy and RPC pass, one at a time, against the table above.
3. Tests. `test/privileges.test.mjs` is where this belongs, and it should assert refusals
   for an officer, not just successes for an admin. A test that only proves the Secretary
   can still work would pass with the whole boundary missing.
4. Google sign-in and the Secretary's officer-management screen.
5. The UI hiding, last, once there is something real underneath it to reflect.

## What this does not touch

Check-in and the member portal are anonymous `SECURITY DEFINER` RPCs and are outside all
of this. `/c`, `/me` and `/events` behave identically before and after.
