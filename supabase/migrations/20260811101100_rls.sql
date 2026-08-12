-- ===========================================================================
-- 11. ROW LEVEL SECURITY AND GRANTS
-- ===========================================================================
-- The table in docs/01-data-model.md section 8, made real.
--
-- Two things to hold in mind while reading this file.
--
-- 1. `anon` receives no table privileges at all. Not "select with a policy
--    that denies everything", but no grant. The anonymous check-in page
--    reaches the database exclusively through the four SECURITY DEFINER RPCs
--    at the bottom of this file. If a policy here were ever wrong, anon still
--    could not read a row, because it was never given permission to try.
--
-- 2. Every signed-in human shares one database role, `authenticated`. Admin,
--    officer, viewer and member are values of profiles.role, read through the
--    SECURITY DEFINER helpers from migration 09. That is also why the one
--    column-level rule in the design (a member may edit only their preferred
--    name and email) is a trigger rather than a column grant: column
--    privileges attach to database roles, and officers and members are the
--    same database role.
-- ===========================================================================

alter table academic_years               enable row level security;
alter table terms                        enable row level security;
alter table members                      enable row level security;
alter table member_merges                enable row level security;
alter table member_enrollments           enable row level security;
alter table profiles                     enable row level security;
alter table member_claims                enable row level security;
alter table categories                   enable row level security;
alter table events                       enable row level security;
alter table event_categories             enable row level security;
alter table event_evidence_requirements  enable row level security;
alter table attendance_records           enable row level security;
alter table attendance_evidence          enable row level security;
alter table requirement_sets             enable row level security;
alter table requirement_nodes            enable row level security;
alter table requirement_node_categories  enable row level security;
alter table purge_runs                   enable row level security;
alter table app_settings                 enable row level security;
alter table audit_log                    enable row level security;
alter table evidence_upload_grants       enable row level security;
alter table rpc_call_counters            enable row level security;
alter table checkin_client_nonces        enable row level security;

-- ---------------------------------------------------------------------------
-- Baseline privileges
-- ---------------------------------------------------------------------------

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Calendar: everyone signed in can read it, officers maintain it
-- ---------------------------------------------------------------------------

grant select on academic_years, terms to authenticated;
grant insert, update, delete on academic_years, terms to authenticated;

create policy years_read   on academic_years for select to authenticated using (true);
create policy years_write  on academic_years for all    to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

create policy terms_read   on terms for select to authenticated using (true);
create policy terms_write  on terms for all    to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------
-- A member sees their own row and no one else's. There is no leaderboard and
-- no member-visible roster: the progress board stays officer-only.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on members to authenticated;

create policy members_read_staff on members for select to authenticated
  using (fn_is_staff());

create policy members_read_own on members for select to authenticated
  using (id = fn_current_member_id());

create policy members_write_officer on members for insert to authenticated
  with check (fn_is_officer());

create policy members_update_officer on members for update to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

create policy members_update_own on members for update to authenticated
  using (id = fn_current_member_id()) with check (id = fn_current_member_id());

create policy members_delete_officer on members for delete to authenticated
  using (fn_is_officer());

-- A member may edit their preferred name and email, and nothing else. The
-- policy above already limits them to their own row; this limits the columns.
create or replace function fn_members_member_column_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if fn_current_role() = 'member' then
    if new.id             is distinct from old.id
       or new.first_name  is distinct from old.first_name
       or new.last_name   is distinct from old.last_name
       or new.ucf_nid     is distinct from old.ucf_nid
       or new.notes       is distinct from old.notes
       or new.merged_into_id is distinct from old.merged_into_id
       or new.archived_at is distinct from old.archived_at
    then
      raise exception 'You can only change your preferred name and email address.'
        using errcode = 'PDS07';
    end if;
  end if;
  return new;
end
$$;

create trigger members_member_column_guard
  before update on members
  for each row execute function fn_members_member_column_guard();

-- ---------------------------------------------------------------------------

grant select on member_merges to authenticated;
create policy merges_read on member_merges for select to authenticated
  using (fn_is_staff());

grant select, insert, update, delete on member_enrollments to authenticated;
create policy enrollments_read_staff on member_enrollments for select to authenticated
  using (fn_is_staff());
create policy enrollments_read_own on member_enrollments for select to authenticated
  using (member_id = fn_current_member_id());
create policy enrollments_write on member_enrollments for all to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on profiles to authenticated;
create policy profiles_read_own on profiles for select to authenticated
  using (user_id = auth.uid());
create policy profiles_read_staff on profiles for select to authenticated
  using (fn_is_staff());
create policy profiles_write_admin on profiles for all to authenticated
  using (fn_is_admin()) with check (fn_is_admin());

grant select, insert, update on member_claims to authenticated;
create policy claims_read_own on member_claims for select to authenticated
  using (user_id = auth.uid());
create policy claims_read_staff on member_claims for select to authenticated
  using (fn_is_officer());
create policy claims_insert_own on member_claims for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');
create policy claims_review on member_claims for update to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

-- ---------------------------------------------------------------------------
-- Categories and events: readable by everyone signed in, written by officers
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on categories to authenticated;
create policy categories_read  on categories for select to authenticated using (true);
create policy categories_write on categories for all    to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

grant select, insert, update, delete on events, event_categories, event_evidence_requirements
  to authenticated;

create policy events_read  on events for select to authenticated using (true);
create policy events_write on events for all    to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

create policy event_categories_read  on event_categories for select to authenticated using (true);
create policy event_categories_write on event_categories for all    to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

create policy event_evidence_read  on event_evidence_requirements for select to authenticated using (true);
create policy event_evidence_write on event_evidence_requirements for all    to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------
-- A member reads their own rows, including pending and rejected ones with
-- their review notes, and can insert nothing. Filing a missing-credit request
-- goes through an RPC, so the status column is never set by a client write.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on attendance_records to authenticated;

create policy attendance_read_staff on attendance_records for select to authenticated
  using (fn_is_staff());
create policy attendance_read_own on attendance_records for select to authenticated
  using (member_id = fn_current_member_id());
create policy attendance_write_officer on attendance_records for all to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

grant select, insert, update, delete on attendance_evidence to authenticated;

create policy evidence_read_staff on attendance_evidence for select to authenticated
  using (fn_is_staff());
create policy evidence_read_own on attendance_evidence for select to authenticated
  using (exists (
    select 1 from attendance_records a
    where a.id = attendance_evidence.attendance_record_id
      and a.member_id = fn_current_member_id()
  ));
create policy evidence_write_officer on attendance_evidence for all to authenticated
  using (fn_is_officer()) with check (fn_is_officer());

-- ---------------------------------------------------------------------------
-- Requirements
-- ---------------------------------------------------------------------------
-- Everyone signed in can read the rules they are being judged by. Officers
-- may build and edit a draft. Only an admin may publish one, or touch a set
-- that is already published, which is what makes published sets immutable in
-- practice: the WITH CHECK below fails the moment an officer tries to set
-- status to anything but draft.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on requirement_sets, requirement_nodes, requirement_node_categories
  to authenticated;

create policy req_sets_read on requirement_sets for select to authenticated using (true);
create policy req_sets_write on requirement_sets for all to authenticated
  using      (fn_is_admin() or (fn_is_officer() and status = 'draft'))
  with check (fn_is_admin() or (fn_is_officer() and status = 'draft'));

create policy req_nodes_read on requirement_nodes for select to authenticated using (true);
create policy req_nodes_write on requirement_nodes for all to authenticated
  using (fn_is_admin() or (fn_is_officer() and exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_nodes.requirement_set_id and rs.status = 'draft')))
  with check (fn_is_admin() or (fn_is_officer() and exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_nodes.requirement_set_id and rs.status = 'draft')));

create policy req_node_cats_read on requirement_node_categories for select to authenticated using (true);
create policy req_node_cats_write on requirement_node_categories for all to authenticated
  using (fn_is_admin() or (fn_is_officer() and exists (
    select 1 from requirement_nodes n
    join requirement_sets rs on rs.id = n.requirement_set_id
    where n.id = requirement_node_categories.node_id and rs.status = 'draft')))
  with check (fn_is_admin() or (fn_is_officer() and exists (
    select 1 from requirement_nodes n
    join requirement_sets rs on rs.id = n.requirement_set_id
    where n.id = requirement_node_categories.node_id and rs.status = 'draft')));

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------

grant select on purge_runs, audit_log to authenticated;
create policy purge_runs_read on purge_runs for select to authenticated using (fn_is_officer());
create policy audit_log_read  on audit_log  for select to authenticated using (fn_is_officer());

grant select, insert, update, delete on app_settings to authenticated;
create policy settings_read  on app_settings for select to authenticated using (fn_is_staff());
create policy settings_write on app_settings for all    to authenticated
  using (fn_is_admin()) with check (fn_is_admin());

-- Officers can read upload grants, because v_orphaned_uploads is a
-- security_invoker view over this table and the storage screen has to be able
-- to show what is being held. Nothing below officer can see it, and nobody can
-- write it outside the SECURITY DEFINER RPCs that own it.
grant select on evidence_upload_grants to authenticated;
create policy upload_grants_read on evidence_upload_grants for select to authenticated
  using (fn_is_officer());

-- checkin_client_nonces and rpc_call_counters are RLS-enabled with no policies
-- and no grants at all. They are limiter bookkeeping, they authorize nothing,
-- and nothing outside the SECURITY DEFINER functions that own them can see or
-- touch them.

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

-- The anonymous check-in surface. This is everything anon can do.
grant execute on function get_checkin_context(text)                                to anon, authenticated;
grant execute on function search_members(text, text, text)                         to anon, authenticated;
grant execute on function create_evidence_upload(text, uuid, evidence_kind_t, text) to anon, authenticated;
grant execute on function submit_checkin(text, uuid, text, text, numeric, jsonb, text) to anon, authenticated;

-- Consulted by the storage insert policy, which anon must be able to satisfy
-- when uploading a photo it was granted a path for.
grant execute on function fn_upload_grant_is_live(text, text) to anon, authenticated;

-- Deliberately NOT granted to anon or authenticated: fn_checkin_nonce_bucket,
-- fn_rate_limit_check and fn_rate_limit_checkin. They are called from inside
-- the SECURITY DEFINER RPCs above, which run as the owner, so no caller needs
-- to reach them directly and none should be able to.

-- Officer operations.
grant execute on function review_records(uuid[], text, text)   to authenticated;
grant execute on function resolve_unmatched(uuid, uuid, jsonb) to authenticated;
grant execute on function merge_members(uuid, uuid)            to authenticated;
grant execute on function purge_evidence(int)                  to authenticated;
grant execute on function purge_orphaned_uploads()             to authenticated;

-- Reading progress. The evaluator carries its own authorization check, so a
-- member calling it directly for somebody else's id is refused rather than
-- quietly handed zeroes.
grant execute on function fn_member_requirement_status(uuid, uuid) to authenticated;
grant execute on function fn_published_requirement_set(uuid)       to authenticated;
grant execute on function fn_current_role()                        to authenticated;
grant execute on function fn_current_member_id()                   to authenticated;
grant execute on function fn_is_admin()                            to authenticated;
grant execute on function fn_is_officer()                          to authenticated;
grant execute on function fn_is_staff()                            to authenticated;
grant execute on function fn_can_view_member(uuid)                 to authenticated;
grant execute on function fn_assert_can_view_member(uuid)          to authenticated;
grant execute on function fn_setting_int(text, int)                to authenticated;
grant execute on function fn_setting_numeric(text, numeric)        to authenticated;
grant execute on function fn_normalise_name(text)                  to authenticated;

-- The views. Each is security_invoker, so these grants hand out the view, not
-- an exemption from the policies above.
grant select on v_attendance_credit, v_member_category_totals,
                v_member_status, v_config_warnings, v_orphaned_uploads
  to authenticated;
