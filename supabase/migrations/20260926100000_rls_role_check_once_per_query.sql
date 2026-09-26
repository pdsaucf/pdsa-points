-- Role checks in RLS policies run once per query, not once per row.
--
-- A bare fn_is_staff() in a policy is evaluated for every row the query
-- touches. Since migrations 20260905100000 and 20260907100000 each call is a
-- chain of SECURITY DEFINER lookups (auth.users, then profiles joined to
-- leadership_access and auth.identities), and definer functions are never
-- inlined or cached across rows. v_member_status walks every approved
-- attendance record once per requirement node per member, so the Members
-- screen paid that chain tens of thousands of times and ran past the
-- authenticated statement timeout.
--
-- Wrapped as a scalar subquery, `(select fn_is_staff())` becomes an InitPlan:
-- Postgres evaluates it once per statement and reuses the answer. The
-- functions read only the caller's identity, which cannot change inside a
-- statement, so every policy below admits and refuses exactly what it did
-- before. Only the cost changes.
begin;
set local search_path = public, extensions, pg_temp;

alter policy years_read on public.academic_years
  using ((select fn_is_staff()));
alter policy years_write on public.academic_years
  using ((select fn_is_admin())) with check ((select fn_is_admin()));

alter policy settings_admin on public.app_settings
  using ((select fn_is_admin())) with check ((select fn_is_admin()));
alter policy settings_read_staff on public.app_settings
  using ((select fn_is_staff()));

alter policy evidence_admin on public.attendance_evidence
  using ((select fn_is_admin())) with check ((select fn_is_admin()));

alter policy attendance_admin on public.attendance_records
  using ((select fn_is_admin())) with check ((select fn_is_admin()));
alter policy attendance_read_staff on public.attendance_records
  using ((select fn_is_staff()));

alter policy audit_log_read on public.audit_log
  using ((select fn_is_staff()));

alter policy categories_read on public.categories
  using ((select fn_is_staff()));
alter policy categories_write on public.categories
  using ((select fn_is_admin())) with check ((select fn_is_admin()));

alter policy event_categories_read on public.event_categories
  using ((select fn_is_staff()));
alter policy event_evidence_read on public.event_evidence_requirements
  using ((select fn_is_staff()));

alter policy events_delete on public.events
  using ((select fn_is_officer()));
alter policy events_read on public.events
  using ((select fn_is_staff()));

alter policy upload_grants_read on public.evidence_upload_grants
  using ((select fn_is_staff()));
alter policy dup_dismissals_read on public.member_duplicate_dismissals
  using ((select fn_is_staff()));

alter policy enrollments_admin on public.member_enrollments
  using ((select fn_is_admin())) with check ((select fn_is_admin()));
alter policy enrollments_read_staff on public.member_enrollments
  using ((select fn_is_staff()));

alter policy merges_read on public.member_merges
  using ((select fn_is_staff()));

alter policy members_admin on public.members
  using ((select fn_is_admin())) with check ((select fn_is_admin()));
alter policy members_read_staff on public.members
  using ((select fn_is_staff()));

alter policy profiles_read_admin on public.profiles
  using ((select fn_is_admin()));

alter policy purge_run_objects_read on public.purge_run_objects
  using ((select fn_is_staff()));
alter policy purge_runs_read on public.purge_runs
  using ((select fn_is_staff()));

alter policy req_node_cats_read on public.requirement_node_categories
  using ((select fn_is_staff()));
alter policy req_node_cats_write on public.requirement_node_categories
  using ((select fn_is_admin()) and exists (
    select 1 from requirement_nodes n
    join requirement_sets rs on rs.id = n.requirement_set_id
    where n.id = requirement_node_categories.node_id and rs.status = 'draft'))
  with check ((select fn_is_admin()) and exists (
    select 1 from requirement_nodes n
    join requirement_sets rs on rs.id = n.requirement_set_id
    where n.id = requirement_node_categories.node_id and rs.status = 'draft'));

alter policy req_nodes_read on public.requirement_nodes
  using ((select fn_is_staff()));
alter policy req_nodes_write on public.requirement_nodes
  using ((select fn_is_admin()) and exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_nodes.requirement_set_id and rs.status = 'draft'))
  with check ((select fn_is_admin()) and exists (
    select 1 from requirement_sets rs
    where rs.id = requirement_nodes.requirement_set_id and rs.status = 'draft'));

alter policy req_sets_delete on public.requirement_sets
  using ((select fn_is_admin()) and status = 'draft');
alter policy req_sets_insert on public.requirement_sets
  with check ((select fn_is_admin()) and status = 'draft');
alter policy req_sets_read on public.requirement_sets
  using ((select fn_is_staff()));
alter policy req_sets_update on public.requirement_sets
  using ((select fn_is_admin())) with check ((select fn_is_admin()) and status <> 'published');

alter policy terms_read on public.terms
  using ((select fn_is_staff()));
alter policy terms_write on public.terms
  using ((select fn_is_admin())) with check ((select fn_is_admin()));

alter policy evidence_delete_admin on storage.objects
  using (bucket_id = 'evidence' and (select fn_is_admin()));
alter policy evidence_read_admin on storage.objects
  using (bucket_id = 'evidence' and (select fn_is_admin()));

commit;
