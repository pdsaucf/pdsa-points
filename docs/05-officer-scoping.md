# Officer scoping and "view as": the decision and the design

Not covered by docs/00-04. Signed off the same way those were, before any implementation.

## The problem

Every officer-facing RLS policy today reads `fn_is_officer()`, which means "officer or
admin," full stop. An officer who manages Tabling can currently edit GBM thresholds,
approve Dean Visits check-ins, and rename the Volunteering category. That was fine while
the club ran on one spreadsheet everyone could see; it is not what should happen once
this system is the real record; and it is not what the club's actual structure implies:
each officer owns a specific slice of the point system, plus the President and Secretary
who reasonably need to see and fix everything.

## Real assignments, from PDSA's current officer structure

Confirmed 2026-08-16. This is data to seed, not a special case in code (invariant 1):

| Officer | Categories |
|---|---|
| DECO (Dental Education Coordinator) | Clinical Workshops |
| VP | Non-Clinical Workshops |
| Media | Tabling, Journal Club, Media Speaking, PDSA Post, Media Writing |
| Treasurer | Fundraising, Partial Proceeds |
| VCO (Volunteer Coordinator Officer) | Volunteering |
| President | everything (see below) |
| Secretary | everything (see below) |

Two things worth flagging about this table before the mechanism:

**President and Secretary are not scoped officers, they are admins.** You said it
yourself: "i wanna have access to all so ig make some sort of mega admin role, and sec
should be this too." `role = 'admin'` already means exactly that: unscoped, sees and
edits everything, including other officers' scopes (docs/03-admin-ui.md's existing admin
model). So the design below does **not** give President and Secretary
`officer_category_scopes` rows for GBMs, Dental School Visits, Journal Club, PDSA Post,
etc. as you listed them; it sets their `profiles.role` to `admin`. Their listed
categories become moot, because admin already covers them. If you'd rather they be
scoped `officer` rows instead (visible in the new scopes screen as "manages: GBMs, Dental
School Visits, Speaking, Writing, ..." the way every other officer will be), say so and
I'll seed it that way instead; it changes nothing structurally, just which two people
show up in the admin list versus the officer list.

**"Speaking" and "Writing" are not categories.** They are `requirement_nodes` that each
measure two real categories (`docs/03-admin-ui.md` section 4): Speaking measures Journal
Club and Media Speaking; Writing measures PDSA Post and Media Writing. Scoping is a join
on `categories`, so I mapped your "Speaking - president and media" / "Writing - media and
sec" to their underlying categories. Because President and Secretary become admin
(unscoped), the only real scoped assignment that survives is **Media owning all four**:
Journal Club, Media Speaking, PDSA Post, Media Writing. That turns out to matter, see
"Editing a node with children in scope" below.

**Volunteering is currently `unit = 'hours'`.** You mentioned it's event-count this year.
`unit_type` already includes `'event_count'` (`supabase/migrations/20260811100400_categories.sql`),
so that's a one-row edit to `categories.unit` and the matching `requirement_nodes.min_value`,
not a schema change. It's unrelated to scoping; flagging it here so it isn't lost, not
proposing to bundle it into this migration.

## Data model

```sql
create table officer_category_scopes (
  profile_user_id uuid not null references profiles (user_id) on delete cascade,
  category_id     uuid not null references categories        on delete cascade,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users,
  primary key (profile_user_id, category_id)
);

create index officer_category_scopes_category on officer_category_scopes (category_id);
```

A join table, matching every other many-to-many in this schema (`event_categories`,
`requirement_node_categories`). `on delete cascade` on both sides: an archived category
still exists (invariant 4 says categories archive, never delete) so this only fires if a
profile itself is deleted. No `unit`, `title`, or "role name" column: an officer's scope
*is* their job description in this system. The admin screen labels a row by which
categories are checked, not by a free-text "DECO" string anywhere in the schema, so a
title change (this year's DECO becomes next year's "Clinical Coordinator") is a rename in
the UI where the officer's name already lives, never a data migration.

RLS on the table itself: `select` for `fn_is_staff()` (an officer needs to see their own
scope to know what they can touch; a viewer sees the whole club read-only anyway), all
writes `fn_is_admin()` only. A scoped officer never edits their own scope, the same way
nobody edits their own role today.

### What "no scope rows" means for an officer

This is the load-bearing decision in this whole doc, and it is a **behavior change**:
today every officer sees and edits everything. After this ships, **an officer with zero
`officer_category_scopes` rows manages nothing.** Empty is not "grandfather them in," it
is "not yet assigned." That is the only reading consistent with what you actually asked
for (DECO manages Clinical Workshops, full stop, not Clinical Workshops plus whatever the
migration happened to leave them with).

Consequence: this cannot ship as a bare migration that just adds the table. It has to
ship **with every real officer's scope seeded in the same migration**, from the table
above, so nobody's screen goes blank the morning this deploys. The build task seeds:
DECO -> Clinical Workshops, VP -> Non-Clinical Workshops, Media -> the four editorial
categories plus Tabling, Treasurer -> Fundraising and Partial Proceeds, VCO ->
Volunteering, and promotes President and Secretary to `admin`. Any officer profile that
does not map to one of these seven (a test/fixture account, or a role that has since
turned over) is left with no scope rows on purpose, exactly like a brand new officer
today: they see the screen, see nothing to act on, and an admin assigns them from the new
scopes screen. That is the intended state for "not yet configured," not a bug.

Viewer and member roles are unaffected: a viewer already reads everything and writes
nothing, and stays that way regardless of scoping.

## Enforcement: RLS, not a hidden button

Invariant: hiding a button in `web/src/*.js` is not access control. Every policy below is
enforced at the database, so a scoped-out officer calling the REST API or an RPC directly
gets refused there, the same as an anonymous caller gets refused on `attendance_records`
today.

### The helper

```sql
create or replace function fn_officer_category_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(category_id), '{}')
  from officer_category_scopes
  where profile_user_id = auth.uid()
$$;

create or replace function fn_scoped_to_category(p_category_id uuid)
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_is_admin() or p_category_id = any(fn_officer_category_ids())
$$;
```

`fn_is_admin() or ...` is baked into the single predicate every policy calls, so no
policy has to remember to OR in the admin bypass itself, the same pattern `fn_is_officer()`
already is ("officer means officer or admin," per its own comment).

### Where this actually changes a policy

Every `fn_is_officer()`-gated policy on a table that carries or joins to a category gets
a second clause. This is mechanical but not small; it is the real size of this phase.

| Table | Today | Becomes |
|---|---|---|
| `categories` | `fn_is_officer()` write | `fn_scoped_to_category(id)` |
| `event_categories` | `fn_is_officer()` write | `fn_scoped_to_category(category_id)` |
| `events` | `fn_is_officer()` write | see "Events span categories" below |
| `attendance_records` (review) | `fn_is_officer()` write, via `review_records()` | `fn_scoped_to_category()` on at least one of the event's categories, see below |
| `requirement_nodes` / `requirement_node_categories` | `fn_is_officer()` + draft-status write | add `fn_scoped_to_category()`, see "Requirements" below |

`purge_evidence`, `app_settings`, `audit_log`, `purge_runs`, member merges, roster import:
**unchanged, admin/officer as today.** None of these are category-scoped in the phasing
task, and nothing about storage ops or the roster is specific to one category. Narrowing
those would be a separate, unrequested restriction; flag if you want it, otherwise this
phase leaves them alone.

### Events span categories: inclusive to see, per-row to edit

Invariant 5 (an event is defined once, categories attach via `event_categories`) means an
event like "Soap Carving" can carry both Clinical Workshops and Socials at once
(docs/03-admin-ui.md's own example). If DECO owns only Clinical Workshops, do they see
that event at all?

**Yes, inclusively.** An officer sees and can open any event that has at least one
category they're scoped to; they need to manage their portion. But inside the event
editor, **only the category rows they're scoped to are editable**; a row for a category
outside their scope renders read-only, the same visual pattern the doc already uses for
"an event, its category rows, and a credit value each." This mirrors the requirements
editor's own per-row edit story below, so an officer learns the rule once.

### Review queue: approval is whole-record, so scope is inclusive there too

`attendance_records` does not have a category column; an event's categories decide what
an approval grants, and approving is one action on one record, not one action per
category (there is no such thing as "approve the Clinical half of this check-in"). So the
rule here is simpler than the event editor's: **an officer who is scoped to at least one
of an event's categories can review every record for that event**, full approve/reject,
same as today's `review_records()`. Splitting approval per category is not something the
data model supports without a much bigger change than this phase asks for, and nothing in
the current seed needs it (no event today splits its categories across two different
non-admin officers).

### Requirements: editing a node needs every category it measures

Section 4's engine already treats a threshold as "measures these categories" via
`requirement_node_categories`. The rule: **an officer may edit a node only if they are
scoped to every category it measures.** A plain threshold like "Clinical Workshops >= 5"
measures one category, so this is just `fn_scoped_to_category()` on that one row. A
compound node like Speaking ("Journal Club, Media Speaking >= 1") needs the officer
scoped to *both*.

This is exactly the split-ownership trap the phasing task asked me to watch for, and the
real seed above happens to avoid it: Media owns all four editorial categories, so Media
can fully edit both Speaking and Writing. If a future re-scoping ever splits Journal Club
to one officer and Media Speaking to another, that node becomes admin-only to edit until
someone is scoped to both, which is the correct, conservative answer (nobody with partial
ownership can silently change a number that isn't fully theirs), and the requirements
screen should say so plainly ("Needs an officer scoped to Journal Club and Media
Speaking") rather than just hiding the edit control.

`req_nodes_write` and `req_node_cats_write` (migration 11) keep their existing
`status = 'draft'` condition unchanged; scoping adds to admin/officer, not instead of it.
Group nodes (no `min_value`, only children) are structural, not measured: reordering or
renaming a group stays admin/officer, since a group's scope is really "the union of its
children's scope" and enforcing that recursively is real complexity for something nobody
asked for. Flag if group-level scoping matters to you; the recommendation is to leave
groups admin-only for now.

## "View as": a real preview, server-enforced

The requirement, restated: admin picks a member, an officer, or the anonymous check-in
flow, and sees exactly what that identity's real RLS produces, never a client-side
filter that can drift from what the database actually enforces.

### The mechanism, and a course correction from what you picked

You picked "mint a short-lived Supabase auth session for the target identity." I looked
into building that, and it does not fit this project's architecture without adding a
piece of infrastructure the phasing table never asked for: minting a real GoTrue session
for *another* user requires the Supabase Admin API, which requires the `service_role`
key. That key is explicitly never allowed in `web/` (`web/config.js`'s own comment: "NEVER
put the service_role key in this file, or in any file under web/"), because this is a
static frontend with no server. Using it safely means standing up a Supabase Edge
Function to hold that key and call the admin API on the browser's behalf, i.e. a new
backend component this project has deliberately not needed through P0-P6.

**Recommendation instead: session-variable impersonation inside Postgres, no new
infrastructure.** `fn_current_role()` and `fn_current_member_id()` (migration 09) are the
*only* two functions in the entire schema that read `auth.uid()` directly; every RLS
policy, and every `fn_is_admin()` / `fn_is_officer()` / `fn_is_staff()` call, is built on
top of those two. So the whole impersonation surface is two functions, not "every
policy":

```sql
create or replace function fn_current_role()
returns app_role
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    -- Only honoured when it was this session's own admin-gated RPC that set
    -- it; see start_preview() below. A caller cannot set this GUC directly:
    -- it requires SECURITY DEFINER privilege the same way every other
    -- protected write in this schema does.
    (select role from profiles where user_id =
       nullif(current_setting('app.preview_user_id', true), '')::uuid),
    (select role from profiles where user_id = auth.uid())
  )
$$;
```

(`fn_current_member_id()` gets the equivalent change.) `current_setting(..., true)` with
`set_config(..., true)` (the `true` third argument, transaction-local) is how PostgREST
itself passes the caller's JWT claims into every request already; this is the same
mechanism, not a new one. A `start_preview(target_kind, target_id)` SECURITY DEFINER RPC,
admin-only, sets `app.preview_user_id` for the remainder of the transaction/request and
returns the plain data the target identity would see; a `PGRST-Role`-style header is not
needed because the preview is read-only and scoped to one request at a time (below).

This gets you exactly what you asked for: **real RLS, evaluated by the real policies, for
the real target's real identity**, zero drift risk, because there is only one
implementation of every policy and preview runs through it. It costs nothing new to
deploy (still just Postgres), at the cost of not literally being "signed in as them" in
the browser's eyes, which the read-only, single-request framing below makes unnecessary
anyway. I'd like your sign-off on this substitution specifically, since it's a real
change from what you picked; say so if you'd rather we take on an Edge Function to get a
literal session instead.

### Shape of the preview

- **Member preview**: admin searches any member (roster, not just claimed accounts),
  picks one. Every subsequent read in the preview pane runs with `app.preview_user_id`
  set to that member's own linked account if they have one, or, for a member with no
  account yet, a lighter path that runs the same member-scoped RLS predicates
  (`member_id = fn_current_member_id()`) directly against the chosen `member_id` without
  requiring a real `profiles` row to exist. The portal screen (docs/04-member-ui.md)
  renders against this like any other session.
- **Officer preview**: admin picks a specific officer account. `app.preview_user_id` is
  that officer's `user_id`; their real `officer_category_scopes` rows govern everything,
  so this doubles as the way an admin checks "did I scope Media correctly" before telling
  them it's live.
- **Anonymous / check-in preview**: this one needs no impersonation at all. The check-in
  RPCs (`get_checkin_context`, `search_members`, `submit_checkin`) already run for
  `anon` with zero session, so "view as anonymous" is just opening the real `/c/<token>`
  page in the preview pane with no admin session attached to it, same as a member's phone
  would. Simplest of the three, mentioned so it isn't mistaken for needing the same
  machinery as the other two.

### Read-only, and how that's actually enforced

`start_preview()` grants nothing: it is a `SECURITY DEFINER` function that only ever sets
a session variable and returns data. The real barrier is that nothing in the preview pane
is wired to any write action; the panel is rendered from the same read paths (`select`,
the evaluator RPCs) with every button that mutates state absent. That is "hidden button"
territory *for the preview surface specifically*, which is acceptable here because the
underlying write policies are entirely untouched: even if a bug in the preview UI tried
to call `review_records()` while `app.preview_user_id` was set to a member account, that
RPC's own `fn_assert_officer()` check reads the impersonated role and refuses it exactly
as it would refuse a real member, because it goes through the same `fn_current_role()`.
Impersonating a lower-privileged identity can only ever narrow what's possible in that
request, never widen it, which is what makes this safe to build without a separate
read-only enforcement layer.

### The banner

Every screen rendered while `app.preview_user_id` is set carries a persistent banner:
**"Viewing as: <name or role>"**, with one control, **"Back to your account,"** that ends
the preview and returns to the admin's own session. No ambiguity about which session is
real: the admin was never actually signed out, `app.preview_user_id` lives for the
duration of the preview pane's requests only and is never persisted to `localStorage` or
the URL, so refreshing outside the preview flow, or closing the tab, leaves nothing
lingering.

## Admin UI additions

Two additions to the existing six-tab shell (docs/03-admin-ui.md's navigation), both
admin-only:

- **Officer scopes**, likely a sub-panel of the existing Members or a new tab: one row
  per officer account, checkboxes for which categories they manage, matching the
  category-checkbox pattern the Requirements screen already uses for
  "at least 1 from ⟨Journal Club⟩ ⟨Media Speaking⟩." No new visual language to learn.
- **View as**, a launcher (a button in the top bar, near the year selector) that opens a
  small picker: search a member, pick an officer from a list, or "anonymous check-in."
  Selecting one opens the preview pane with the banner above.

## Invariants, checked

- **Invariant 1** (nothing hardcoded about categories/thresholds): held. Scoping is a
  join table an admin edits from the UI; the seed above is data loaded once, the same way
  the category list itself is seeded, not a code path that names "DECO."
- **Invariant 2** (Honorary computed in Postgres, never client JS): held, untouched.
  Scoping restricts who can *edit* the rules that feed the evaluator; the evaluator
  itself (`fn_member_requirement_status`) is not touched by this phase.
- **Invariant 3** (anonymous check-in touches no table, only SECURITY DEFINER RPCs, never
  sets `status`): held. The anonymous preview is the real `/c/` page with no session; the
  check-in RPCs are not touched by this phase at all.
- **Invariant 4** (categories archive, never delete): held. `officer_category_scopes`
  references `categories` `on delete cascade`, but categories are never deleted by
  anything in this schema; the cascade exists only in case a category row is someday
  removed by hand outside the app, and even then it just drops the scope assignment, not
  the category.
- **Invariant 5** (an event is defined once, categories attach via `event_categories`):
  held, and is exactly why "events span categories" above needed its own inclusive-visibility
  rule rather than trying to give an event a single owning category.
- **Invariant 6** (no auto-approval, every record approved by a person): held. Scoping
  changes *which* person may approve a given record, never whether one has to.
- **Invariant 7** (photos never deleted on a timer): unaffected; storage ops stay
  admin/officer as today, per the "unchanged" row above.

## Open questions for sign-off

1. **President and Secretary as `admin`, not scoped `officer` rows.** Confirm, or say you
   want them as officers with the categories you listed instead.
2. **The view-as mechanism substitution**: session-variable impersonation inside Postgres
   instead of minting a real Supabase Auth session, to avoid a new Edge Function +
   `service_role` surface. Confirm, or say you want the Edge Function built instead.
3. **Zero scope rows means zero access**, not grandfathered full access. Confirm this is
   the intended behavior change, since it is the one thing that could look like a bug
   ("why can't Treasurer see the roster anymore") the morning this ships if anyone reads
   it as a demotion rather than the intended restriction.
4. **Review queue and event visibility are inclusive** (scoped to any one of an event's
   categories is enough to see and approve the whole thing); **requirements editing is
   conjunctive** (must be scoped to every category a node measures). Confirm both rules
   read right, since they're asymmetric on purpose and worth double-checking against how
   the club actually wants this to feel.
5. Group nodes in the requirements tree stay admin/officer-only to restructure, not
   scoped. Confirm, or ask for recursive group scoping (real added complexity).

Once you've signed off, the implementer builds this the same way P6 did: one migration
(join table, seed, RLS policy changes, the two `fn_current_role`/`fn_current_member_id`
edits, `start_preview()`), the two admin UI additions, and tests covering the scoped and
unscoped cases for events, review, and requirements editing, plus the preview mechanism's
read-only guarantee. Reviewed the same way, by an adversarial pass and a QA pass driving
the UI, before it commits separately from P6.
