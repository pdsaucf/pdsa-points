-- The role predicates answer from one lookup instead of a chain of them.
--
-- fn_is_staff() called fn_is_officer(), which called fn_is_admin(), which
-- called fn_is_shared_admin() and then fn_current_role(); fn_is_officer()
-- then called fn_current_role() a second time. Each is a SECURITY DEFINER
-- function, never inlined, so one staff check for a signed-in officer was
-- three separate definer calls and three reads of auth tables.
--
-- 20260926100000 made a policy evaluate its check once per statement. The
-- requirement evaluator still runs several statements per member, and the
-- progress board evaluates every member, so the check still ran thousands of
-- times per page and was most of that page's cost.
--
-- fn_staff_role() is the shared-admin test and fn_current_role()'s bound
-- Google identity test in one statement. The three predicates keep their
-- names, signatures and answers: the shared session is admin, a bound and
-- unrevoked leadership profile is its own role, the owner with no end user
-- is admin, and everybody else is nothing.
begin;
set local search_path = public, extensions, pg_temp;

create function fn_staff_role() returns app_role
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select case
    when auth.uid() is null then null
    when exists (
      select 1 from auth.users u
      where u.id = auth.uid() and lower(u.email) = 'officers@pdsaucf.com'
    ) then 'admin'::app_role
    else (
      select p.role
      from profiles p join leadership_access a on a.user_id = p.user_id and a.role = p.role
      where p.user_id = auth.uid() and a.revoked_at is null
        and exists (
          select 1 from auth.identities i
          where i.user_id = p.user_id and i.provider = 'google'
            and i.provider_id = a.google_subject
            and i.identity_data -> 'email_verified' = 'true'::jsonb
            and lower(btrim(i.identity_data ->> 'email')) = a.email
        )
    )
  end
$$;
-- The same grants fn_current_role() and fn_is_shared_admin() carry.
revoke all on function fn_staff_role() from public, anon, authenticated;
grant execute on function fn_staff_role() to authenticated;

-- The owner clause is unchanged from 20260905100000: no end user, and neither
-- the current user nor the original SET ROLE is a client role.
create or replace function fn_is_admin() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$
  select coalesce(fn_staff_role() = 'admin', false)
      or (auth.uid() is null and current_user not in ('anon', 'authenticated')
          and current_setting('role') not in ('anon', 'authenticated'))
$$;

create or replace function fn_is_officer() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$
  select coalesce(fn_staff_role() in ('admin', 'officer'), false)
      or (auth.uid() is null and current_user not in ('anon', 'authenticated')
          and current_setting('role') not in ('anon', 'authenticated'))
$$;

create or replace function fn_is_staff() returns boolean
language sql stable set search_path = public, extensions, pg_temp
as $$
  select coalesce(fn_staff_role() in ('admin', 'officer'), false)
      or (auth.uid() is null and current_user not in ('anon', 'authenticated')
          and current_setting('role') not in ('anon', 'authenticated'))
$$;

commit;
