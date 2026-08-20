-- ===========================================================================
-- 24. ONE SHARED ADMIN SESSION
-- ===========================================================================
--
-- The admin page has one passcode and one fixed GoTrue user. There is no
-- second application-account layer. The JWT must belong to that fixed email;
-- another leftover or accidentally-created Auth user is not an administrator.
--
-- The public member portal replaced the earlier signed-in member portal in
-- migration 21. Its profiles, roles, claims and claim RPCs are therefore both
-- unused and actively harmful: a missing profiles row can reject the shared
-- admin user after GoTrue has already accepted the passcode.
-- ===========================================================================

-- Retire the superseded member-account API before removing its tables.
drop function if exists start_portal_session();
drop function if exists search_roster_for_claim(text);
drop function if exists file_member_claim(uuid, text);
drop function if exists review_member_claim(uuid, text, text);
drop function if exists list_pending_claims();
drop function if exists request_missing_credit(uuid, text, numeric);

delete from app_settings
where key in ('claim_search_max_per_min', 'missing_credit_max_per_min');

-- Authentication still needs one GoTrue row because Supabase stores the
-- passcode hash there. This helper is the whole authorization boundary: no
-- profiles table, role enum, claims table, or per-user application account.
-- SECURITY DEFINER is required because authenticated clients cannot read the
-- auth schema directly.
create or replace function fn_is_shared_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, extensions, pg_temp
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = auth.uid()
      and lower(u.email) = 'officers@pdsaucf.com'
  )
$$;

revoke all on function fn_is_shared_admin() from public;
grant execute on function fn_is_shared_admin() to authenticated;

-- Member-scoped policies and the member-only column guard belonged to that
-- retired account flow. The admin session gets the ordinary full-table policy
-- below; anonymous member pages still have no table grants and use only their
-- shaped SECURITY DEFINER portal RPCs.
drop trigger if exists members_member_column_guard on members;
drop function if exists fn_members_member_column_guard();

drop policy if exists members_read_staff on members;
drop policy if exists members_read_own on members;
drop policy if exists members_write_officer on members;
drop policy if exists members_update_officer on members;
drop policy if exists members_update_own on members;
drop policy if exists members_delete_officer on members;
create policy members_admin on members for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists years_write on academic_years;
create policy years_write on academic_years for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists terms_write on terms;
create policy terms_write on terms for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists merges_read on member_merges;
create policy merges_read on member_merges for select to authenticated
  using (fn_is_shared_admin());

drop policy if exists enrollments_read_staff on member_enrollments;
drop policy if exists enrollments_read_own on member_enrollments;
drop policy if exists enrollments_write on member_enrollments;
create policy enrollments_admin on member_enrollments for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists categories_write on categories;
create policy categories_write on categories for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists events_write on events;
create policy events_write on events for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists event_categories_write on event_categories;
create policy event_categories_write on event_categories for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists event_evidence_write on event_evidence_requirements;
create policy event_evidence_write on event_evidence_requirements for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists attendance_read_staff on attendance_records;
drop policy if exists attendance_read_own on attendance_records;
drop policy if exists attendance_write_officer on attendance_records;
create policy attendance_admin on attendance_records for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists evidence_read_staff on attendance_evidence;
drop policy if exists evidence_read_own on attendance_evidence;
drop policy if exists evidence_write_officer on attendance_evidence;
create policy evidence_admin on attendance_evidence for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

-- Published requirement trees remain immutable. The single admin session may
-- edit set metadata and may edit tree rows only while their set is a draft.
drop policy if exists req_sets_write on requirement_sets;
create policy req_sets_insert on requirement_sets for insert to authenticated
  with check (fn_is_shared_admin() and status = 'draft');
create policy req_sets_update on requirement_sets for update to authenticated
  using (fn_is_shared_admin())
  with check (fn_is_shared_admin() and status <> 'published');
create policy req_sets_delete on requirement_sets for delete to authenticated
  using (fn_is_shared_admin() and status = 'draft');

drop policy if exists req_nodes_write on requirement_nodes;
create policy req_nodes_write on requirement_nodes for all to authenticated
  using (fn_is_shared_admin() and exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_nodes.requirement_set_id and rs.status = 'draft'
  ))
  with check (fn_is_shared_admin() and exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_nodes.requirement_set_id and rs.status = 'draft'
  ));

drop policy if exists req_node_cats_write on requirement_node_categories;
create policy req_node_cats_write on requirement_node_categories for all to authenticated
  using (fn_is_shared_admin() and exists (
    select 1 from requirement_nodes n
    join requirement_sets rs on rs.id = n.requirement_set_id
    where n.id = requirement_node_categories.node_id and rs.status = 'draft'
  ))
  with check (fn_is_shared_admin() and exists (
    select 1 from requirement_nodes n
    join requirement_sets rs on rs.id = n.requirement_set_id
    where n.id = requirement_node_categories.node_id and rs.status = 'draft'
  ));

drop policy if exists purge_runs_read on purge_runs;
create policy purge_runs_read on purge_runs for select to authenticated
  using (fn_is_shared_admin());

drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select to authenticated
  using (fn_is_shared_admin());

drop policy if exists settings_read on app_settings;
drop policy if exists settings_write on app_settings;
create policy settings_admin on app_settings for all to authenticated
  using (fn_is_shared_admin()) with check (fn_is_shared_admin());

drop policy if exists upload_grants_read on evidence_upload_grants;
create policy upload_grants_read on evidence_upload_grants for select to authenticated
  using (fn_is_shared_admin());

drop policy if exists dup_dismissals_read on member_duplicate_dismissals;
create policy dup_dismissals_read on member_duplicate_dismissals
  for select to authenticated using (fn_is_shared_admin());

drop policy if exists purge_run_objects_read on purge_run_objects;
create policy purge_run_objects_read on purge_run_objects
  for select to authenticated using (fn_is_shared_admin());

-- Keep these names as compatibility helpers for existing RPC bodies. They no
-- longer inspect an application account or distinguish roles. Anonymous users
-- cannot execute the admin RPCs, and only the fixed shared session passes.
-- The owner-without-a-JWT case keeps database maintenance and the deliberately
-- public SECURITY DEFINER portal functions working. An authenticated request
-- always has auth.uid(), so a different Auth user cannot take that path even
-- when the called RPC itself runs as its owner.
create or replace function fn_is_admin()
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_is_shared_admin()
      or (auth.uid() is null and current_user not in ('anon', 'authenticated'))
$$;

create or replace function fn_is_officer()
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_is_shared_admin()
      or (auth.uid() is null and current_user not in ('anon', 'authenticated'))
$$;

create or replace function fn_is_staff()
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_is_shared_admin()
      or (auth.uid() is null and current_user not in ('anon', 'authenticated'))
$$;

create or replace function fn_can_view_member(p_member_id uuid)
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_is_shared_admin()
      or (auth.uid() is null and current_user not in ('anon', 'authenticated'))
$$;

-- The account tables are now unused. Audit columns continue to reference
-- auth.users directly, so action history still identifies the shared session.
-- Storage policies live outside public and must release their dependencies on
-- the old member lookup before that helper can be removed.
drop policy if exists evidence_read_staff on storage.objects;
drop policy if exists evidence_read_own on storage.objects;
drop policy if exists evidence_delete_officer on storage.objects;

drop table member_claims;
drop table profiles;

drop function fn_current_member_id();
drop function fn_current_role();
drop type app_role;

-- Historical rows must survive the retirement of an Auth identity. These
-- columns are all nullable, so deleting a stale login should remove only the
-- attribution, not the event, review, merge, setting, purge, or audit record.
-- The original constraints omitted an ON DELETE action and therefore made the
-- Supabase Users dashboard fail with "Database error deleting user".
alter table member_merges
  drop constraint if exists member_merges_performed_by_fkey,
  add constraint member_merges_performed_by_fkey
    foreign key (performed_by) references auth.users on delete set null;

alter table events
  drop constraint if exists events_created_by_fkey,
  add constraint events_created_by_fkey
    foreign key (created_by) references auth.users on delete set null;

alter table attendance_records
  drop constraint if exists attendance_records_reviewed_by_fkey,
  add constraint attendance_records_reviewed_by_fkey
    foreign key (reviewed_by) references auth.users on delete set null;

alter table purge_runs
  drop constraint if exists purge_runs_performed_by_fkey,
  add constraint purge_runs_performed_by_fkey
    foreign key (performed_by) references auth.users on delete set null;

alter table app_settings
  drop constraint if exists app_settings_updated_by_fkey,
  add constraint app_settings_updated_by_fkey
    foreign key (updated_by) references auth.users on delete set null;

alter table audit_log
  drop constraint if exists audit_log_actor_user_id_fkey,
  add constraint audit_log_actor_user_id_fkey
    foreign key (actor_user_id) references auth.users on delete set null;

alter table member_duplicate_dismissals
  drop constraint if exists member_duplicate_dismissals_dismissed_by_fkey,
  add constraint member_duplicate_dismissals_dismissed_by_fkey
    foreign key (dismissed_by) references auth.users on delete set null;

-- The test harness provides the same storage schema, so these remain covered
-- locally as well as in Supabase.
create policy evidence_read_admin on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and fn_is_shared_admin());
create policy evidence_delete_admin on storage.objects for delete to authenticated
  using (bucket_id = 'evidence' and fn_is_shared_admin());

-- Existing invoker functions call these compatibility helpers under the
-- authenticated role, so their migration 11 EXECUTE grants remain in place.
-- Event inserts evaluate this column default as the caller.
alter function fn_new_checkin_token() security definer;
grant execute on function fn_new_checkin_token() to authenticated;
