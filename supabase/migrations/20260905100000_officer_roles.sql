-- Officer roles, stages 1 and 2. Shared-passcode sessions remain administrators.
-- No client or sign-in changes. See docs/07-officer-roles.md.
begin;
set local search_path = public, extensions, pg_temp;

-- Migration 24 dropped the historical enum as well as profiles.
create type app_role as enum ('admin', 'officer', 'viewer', 'member');
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role app_role not null,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;
revoke all on profiles from public, anon;
grant select, insert, update, delete on profiles to authenticated;

-- Only the lookup is a definer: policy evaluation must not recurse through
-- profiles RLS. No supplied user id, JWT metadata, or user-editable role source.
create function fn_current_role() returns app_role
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$ select role from public.profiles where user_id = auth.uid() $$;
revoke all on function fn_current_role() from public, anon, authenticated;
grant execute on function fn_current_role() to authenticated;

-- Preserve owner maintenance and public portal evaluation without treating a
-- JWT-less SET ROLE authenticated call inside a definer RPC as the owner.
-- current_setting('role') retains the original SET ROLE across definer calls.
create or replace function fn_is_admin() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$
  select fn_is_shared_admin()
      or coalesce(fn_current_role() = 'admin', false)
      or (auth.uid() is null and current_user not in ('anon', 'authenticated')
          and current_setting('role') not in ('anon', 'authenticated'))
$$;
create or replace function fn_is_officer() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$ select fn_is_admin() or coalesce(fn_current_role() = 'officer', false) $$;
create or replace function fn_is_staff() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$ select fn_is_officer() $$;
create or replace function fn_can_view_member(p_member_id uuid) returns boolean
language sql stable set search_path = public, extensions, pg_temp
-- Public portal definers evaluate member totals with no signed-in user.
as $$
  select fn_is_staff()
      or (auth.uid() is null and current_user not in ('anon', 'authenticated'))
$$;

create policy profiles_read_own on profiles for select to authenticated
  using (user_id = auth.uid());
create policy profiles_admin on profiles for all to authenticated
  using (fn_is_admin()) with check (fn_is_admin());

-- Every effective policy is classified explicitly. Existing draft-tree
-- conditions, storage upload grants, and RPC-only event write grants survive.
alter policy years_read on public.academic_years
  using (fn_is_staff());
alter policy years_write on public.academic_years
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy settings_admin on public.app_settings
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy evidence_admin on public.attendance_evidence
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy attendance_admin on public.attendance_records
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy audit_log_read on public.audit_log
  using (fn_is_staff());
alter policy categories_read on public.categories
  using (fn_is_staff());
alter policy categories_write on public.categories
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy event_categories_read on public.event_categories
  using (fn_is_staff());
alter policy event_evidence_read on public.event_evidence_requirements
  using (fn_is_staff());
alter policy events_delete on public.events
  using (fn_is_officer());
alter policy events_read on public.events
  using (fn_is_staff());
alter policy upload_grants_read on public.evidence_upload_grants
  using (fn_is_staff());
alter policy dup_dismissals_read on public.member_duplicate_dismissals
  using (fn_is_staff());
alter policy enrollments_admin on public.member_enrollments
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy merges_read on public.member_merges
  using (fn_is_staff());
alter policy members_admin on public.members
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy purge_run_objects_read on public.purge_run_objects
  using (fn_is_staff());
alter policy purge_runs_read on public.purge_runs
  using (fn_is_staff());
alter policy req_node_cats_read on public.requirement_node_categories
  using (fn_is_staff());
alter policy req_node_cats_write on public.requirement_node_categories
  using ((fn_is_admin() AND (EXISTS ( SELECT 1
   FROM (requirement_nodes n
     JOIN requirement_sets rs ON ((rs.id = n.requirement_set_id)))
  WHERE ((n.id = requirement_node_categories.node_id) AND (rs.status = 'draft'::text))))))
  with check ((fn_is_admin() AND (EXISTS ( SELECT 1
   FROM (requirement_nodes n
     JOIN requirement_sets rs ON ((rs.id = n.requirement_set_id)))
  WHERE ((n.id = requirement_node_categories.node_id) AND (rs.status = 'draft'::text))))));
alter policy req_nodes_read on public.requirement_nodes
  using (fn_is_staff());
alter policy req_nodes_write on public.requirement_nodes
  using ((fn_is_admin() AND (EXISTS ( SELECT 1
   FROM requirement_sets rs
  WHERE ((rs.id = requirement_nodes.requirement_set_id) AND (rs.status = 'draft'::text))))))
  with check ((fn_is_admin() AND (EXISTS ( SELECT 1
   FROM requirement_sets rs
  WHERE ((rs.id = requirement_nodes.requirement_set_id) AND (rs.status = 'draft'::text))))));
alter policy req_sets_delete on public.requirement_sets
  using ((fn_is_admin() AND (status = 'draft'::text)));
alter policy req_sets_insert on public.requirement_sets
  with check ((fn_is_admin() AND (status = 'draft'::text)));
alter policy req_sets_read on public.requirement_sets
  using (fn_is_staff());
alter policy req_sets_update on public.requirement_sets
  using (fn_is_admin())
  with check ((fn_is_admin() AND (status <> 'published'::text)));
alter policy terms_read on public.terms
  using (fn_is_staff());
alter policy terms_write on public.terms
  using (fn_is_admin())
  with check (fn_is_admin());
alter policy evidence_delete_admin on storage.objects
  using (((bucket_id = 'evidence'::text) AND fn_is_admin()));
alter policy evidence_read_admin on storage.objects
  using (((bucket_id = 'evidence'::text) AND fn_is_admin()));

-- ALL write policies also permit reads for admins; these separate SELECT
-- policies give officers the required roster, attendance and settings reads.
create policy members_read_staff on members for select to authenticated using (fn_is_staff());
create policy enrollments_read_staff on member_enrollments for select to authenticated using (fn_is_staff());
create policy attendance_read_staff on attendance_records for select to authenticated using (fn_is_staff());
create policy settings_read_staff on app_settings for select to authenticated using (fn_is_staff());

-- Tighten only these audited RPC entry assertions. Fetching each exact
-- signature preserves defaults, volatility, SECURITY DEFINER, body and ACLs.
-- Abort on unexpected source rather than silently skipping a renamed guard.
do $migration$
declare
  signature text;
  definition text;
begin
  foreach signature in array array[
    'review_records(uuid[],text,text)',
    'add_officer_attendance(uuid,uuid[],numeric)',
    'add_officer_attendance_batch(uuid,jsonb,numeric)',
    'remove_attendance_record(uuid)',
    'recover_officer_attendance_batch(uuid,text)',
    'resolve_unmatched(uuid,uuid,jsonb)',
    'merge_members(uuid,uuid)',
    'validate_requirement_set(uuid)',
    'preview_requirement_set(uuid)',
    'clone_requirement_set(uuid)',
    'purge_evidence(integer,uuid[])',
    'purge_orphaned_uploads()',
    'finish_purge_run(uuid,text[])'
  ] loop
    definition := pg_get_functiondef(to_regprocedure('public.' || signature));
    if definition is null or strpos(definition, 'perform fn_assert_officer();') = 0 then
      raise exception 'Expected officer assertion missing: %', signature;
    end if;
    execute replace(definition, 'perform fn_assert_officer();', 'perform fn_assert_admin();');
  end loop;

  foreach signature in array array[
    'upsert_member_and_enroll(text,text,citext,citext,uuid,uuid)',
    'upsert_members_and_enroll(jsonb,uuid)',
    'link_retroactive_matches(uuid,uuid[])',
    'dismiss_duplicate_pair(uuid,uuid)'
  ] loop
    definition := pg_get_functiondef(to_regprocedure('public.' || signature));
    if definition is null or strpos(definition, 'fn_is_officer()') = 0 then
      raise exception 'Expected officer predicate missing: %', signature;
    end if;
    definition := replace(definition, 'fn_is_officer()', 'fn_is_admin()');
    definition := replace(definition, 'requires an officer account.', 'requires an admin account.');
    execute definition;
  end loop;
end
$migration$;

-- set_event_published and save_event_config remain officer actions.
-- publish_requirement_set already asserts admin. Read-only RPCs keep staff
-- access, including duplicate candidates and aggregate storage/purge counts.
-- Evidence bytes require storage SELECT, now admin only; the bucket is private.
-- Anonymous check-in/portal RPCs and ungranted internal helpers are untouched.
commit;
