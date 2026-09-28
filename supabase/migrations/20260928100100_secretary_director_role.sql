-- Secretary Director: the Secretary's attendance, roster and photo work,
-- without the Secretary's settings. See docs/07-officer-roles.md.
--
--   admin               everything
--   secretary_director  officer, plus every attendance write, roster writes,
--                       photos and purging
--   officer             events, and reading the club
--
-- fn_is_secretary_director() means secretary_director or admin, the way
-- fn_is_officer() has always meant officer or admin. Requirements,
-- categories, settings, academic years, terms and leadership access stay on
-- fn_is_admin().
begin;
set local search_path = public, extensions, pg_temp;

create function fn_is_secretary_director() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$
  select coalesce(fn_staff_role() in ('admin', 'secretary_director'), false)
      or (auth.uid() is null and current_user not in ('anon', 'authenticated')
          and current_setting('role') not in ('anon', 'authenticated'))
$$;

create function fn_assert_secretary_director() returns void
language plpgsql stable set search_path = public, extensions, pg_temp
as $$
begin
  if not coalesce(fn_is_secretary_director(), false) then
    raise exception 'This action requires a Secretary Director account.' using errcode = 'PDS07';
  end if;
end
$$;

create or replace function fn_is_officer() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$
  select coalesce(fn_staff_role() in ('admin', 'secretary_director', 'officer'), false)
      or (auth.uid() is null and current_user not in ('anon', 'authenticated')
          and current_setting('role') not in ('anon', 'authenticated'))
$$;

create or replace function fn_is_staff() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$
  select coalesce(fn_staff_role() in ('admin', 'secretary_director', 'officer'), false)
      or (auth.uid() is null and current_user not in ('anon', 'authenticated')
          and current_setting('role') not in ('anon', 'authenticated'))
$$;

-- Attendance, evidence, roster and photo objects. Reads for officers come
-- from the separate *_read_staff policies, which are unchanged.
alter policy attendance_admin on public.attendance_records
  using ((select fn_is_secretary_director()))
  with check ((select fn_is_secretary_director()));
alter policy evidence_admin on public.attendance_evidence
  using ((select fn_is_secretary_director()))
  with check ((select fn_is_secretary_director()));
alter policy members_admin on public.members
  using ((select fn_is_secretary_director()))
  with check ((select fn_is_secretary_director()));
alter policy enrollments_admin on public.member_enrollments
  using ((select fn_is_secretary_director()))
  with check ((select fn_is_secretary_director()));
alter policy evidence_read_admin on storage.objects
  using (bucket_id = 'evidence' and (select fn_is_secretary_director()));
alter policy evidence_delete_admin on storage.objects
  using (bucket_id = 'evidence' and (select fn_is_secretary_director()));

-- The Storage screen's retention window is the one setting a Secretary
-- Director writes. Every other key stays on settings_admin.
create policy settings_retention_secretary_director on public.app_settings
  for update to authenticated
  using ((select fn_is_secretary_director()) and key = 'evidence_retention_months')
  with check ((select fn_is_secretary_director()) and key = 'evidence_retention_months');

-- Same technique as 20260905100000: fetch each exact signature, replace the
-- guard, re-execute. Abort on unexpected source rather than skip a guard.
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
    'purge_evidence(integer,uuid[])',
    'purge_orphaned_uploads()',
    'finish_purge_run(uuid,text[])'
  ] loop
    definition := pg_get_functiondef(to_regprocedure('public.' || signature));
    if definition is null or strpos(definition, 'perform fn_assert_admin();') = 0 then
      raise exception 'Expected admin assertion missing: %', signature;
    end if;
    execute replace(definition, 'perform fn_assert_admin();',
                    'perform fn_assert_secretary_director();');
  end loop;

  foreach signature in array array[
    'upsert_member_and_enroll(text,text,citext,citext,uuid,uuid)',
    'upsert_members_and_enroll(jsonb,uuid)',
    'link_retroactive_matches(uuid,uuid[])',
    'dismiss_duplicate_pair(uuid,uuid)'
  ] loop
    definition := pg_get_functiondef(to_regprocedure('public.' || signature));
    if definition is null or strpos(definition, 'fn_is_admin()') = 0 then
      raise exception 'Expected admin predicate missing: %', signature;
    end if;
    definition := replace(definition, 'fn_is_admin()', 'fn_is_secretary_director()');
    definition := replace(definition, 'requires an admin account.',
                          'requires a Secretary Director account.');
    execute definition;
  end loop;

  -- Leadership management stays admin only; it can now grant the new role.
  foreach signature in array array[
    'authorize_leadership_access(text,app_role)',
    'set_leadership_role(uuid,app_role)'
  ] loop
    definition := pg_get_functiondef(to_regprocedure('public.' || signature));
    if definition is null
       or strpos(definition, 'p_role not in (''admin'', ''officer'')') = 0
       or strpos(definition, '''Choose Admin or Officer.''') = 0 then
      raise exception 'Expected role list missing: %', signature;
    end if;
    definition := replace(definition, 'p_role not in (''admin'', ''officer'')',
                          'p_role not in (''admin'', ''secretary_director'', ''officer'')');
    definition := replace(definition, '''Choose Admin or Officer.''', '''Choose a role.''');
    execute definition;
  end loop;
end
$migration$;

alter table leadership_access drop constraint leadership_access_role_check;
alter table leadership_access add constraint leadership_access_role_check
  check (role in ('admin', 'secretary_director', 'officer'));

-- The same grants as fn_is_admin() and fn_assert_admin() (20260811101100).
revoke all on function fn_is_secretary_director() from public, anon, authenticated;
revoke all on function fn_assert_secretary_director() from public, anon, authenticated;
grant execute on function fn_is_secretary_director() to authenticated;
grant execute on function fn_assert_secretary_director() to authenticated;

commit;
