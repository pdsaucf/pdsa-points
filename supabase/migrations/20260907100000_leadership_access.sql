-- Individual Google leadership access. Authentication alone grants no role.
begin;
set local search_path = public, extensions, pg_temp;

create table leadership_access (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email))),
  role app_role not null check (role in ('admin', 'officer')),
  user_id uuid unique references auth.users(id) on delete set null,
  google_subject text unique,
  bound_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table leadership_audit (
  id uuid primary key default gen_random_uuid(),
  access_id uuid references leadership_access(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  target_email text not null,
  action text not null,
  old_role app_role,
  new_role app_role,
  created_at timestamptz not null default now()
);
alter table leadership_access enable row level security;
alter table leadership_audit enable row level security;
-- All access-management writes are serialized RPCs, including profile writes.
revoke all on leadership_access, leadership_audit from public, anon, authenticated;
revoke insert, update, delete on profiles from authenticated;
drop policy profiles_admin on profiles;
create policy profiles_read_admin on profiles for select to authenticated using (fn_is_admin());

-- Profiles remain the role source. A legacy, manually populated profile alone
-- no longer confers access. The independently verified provider identity must
-- still match its original approval binding on every protected database call.
create or replace function fn_current_role() returns app_role
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
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
$$;

create function fn_leadership_audit(p_access leadership_access, p_action text,
                                    p_old_role app_role, p_new_role app_role)
returns void language sql security definer
set search_path = public, extensions, pg_temp
as $$
  insert into leadership_audit(access_id, actor_user_id, actor_email, target_email,
                               action, old_role, new_role)
  values (p_access.id, auth.uid(),
    case when fn_is_shared_admin() then 'officers@pdsaucf.com'
      else (select a.email from leadership_access a where a.user_id = auth.uid()) end,
    p_access.email, p_action, p_old_role, p_new_role)
$$;
revoke all on function fn_leadership_audit(leadership_access,text,app_role,app_role)
  from public, anon, authenticated;

-- The same lock covers authorizations, role changes, revocations and binding.
-- Assertions execute AFTER locking so a concurrent revocation is observed.
create function fn_leadership_keep_admin(p_access leadership_access, p_role app_role)
returns void language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if p_access.revoked_at is null and p_access.role = 'admin'
     and p_access.user_id is not null and p_access.google_subject is not null
     and (p_role is null or p_role <> 'admin')
     and not exists (
       select 1 from leadership_access a
       where a.id <> p_access.id and a.role = 'admin' and a.revoked_at is null
         and a.user_id is not null and a.google_subject is not null
         and exists (select 1 from profiles p where p.user_id=a.user_id and p.role='admin')
         and exists (
           select 1 from auth.identities i
           where i.user_id=a.user_id and i.provider='google' and i.provider_id=a.google_subject
             and i.identity_data -> 'email_verified' = 'true'::jsonb
             and lower(btrim(i.identity_data ->> 'email'))=a.email
         )
     ) then
    raise exception 'Keep at least one signed-in individual admin.' using errcode = 'PDS16';
  end if;
end
$$;
revoke all on function fn_leadership_keep_admin(leadership_access,app_role)
  from public, anon, authenticated;

create function leadership_session() returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  identity_row record;
  access_row leadership_access;
  self_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue.' using errcode = 'PDS07';
  end if;
  if fn_is_shared_admin() then
    return jsonb_build_object('role', 'admin', 'is_shared_admin', true,
                             'email', 'officers@pdsaucf.com');
  end if;
  perform pg_advisory_xact_lock(721934, 1);
  -- Read only the provider-owned identity record. User metadata is editable.
  for identity_row in
    select i.provider_id, lower(btrim(i.identity_data ->> 'email')) as email
    from auth.identities i
    where i.user_id = auth.uid() and i.provider = 'google'
      and i.identity_data -> 'email_verified' = 'true'::jsonb
    order by i.id
  loop
    self_email := identity_row.email;
    select * into access_row from leadership_access a
      where a.email = identity_row.email and a.revoked_at is null for update;
    if access_row.id is null then continue; end if;
    if access_row.google_subject is null and access_row.user_id is null
       and not exists (select 1 from leadership_access a where a.user_id = auth.uid()) then
      update leadership_access set user_id = auth.uid(),
        google_subject = identity_row.provider_id, bound_at = now(), updated_at = now()
        where id = access_row.id returning * into access_row;
      insert into profiles(user_id, role) values(auth.uid(), access_row.role)
        on conflict(user_id) do update set role = excluded.role;
      perform fn_leadership_audit(access_row, 'bind', null, access_row.role);
    end if;
  end loop;
  return jsonb_build_object('role', fn_current_role(), 'is_shared_admin', false,
                           'email', self_email);
end
$$;
revoke all on function leadership_session() from public, anon, authenticated;
grant execute on function leadership_session() to authenticated;

create function list_leadership_access() returns setof leadership_access
language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform fn_assert_admin();
  return query select * from leadership_access order by email;
end
$$;
revoke all on function list_leadership_access() from public, anon, authenticated;
grant execute on function list_leadership_access() to authenticated;

create function authorize_leadership_access(p_email text, p_role app_role) returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_email text := lower(btrim(p_email));
  access_row leadership_access;
  previous_role app_role;
begin
  perform pg_advisory_xact_lock(721934, 1);
  perform fn_assert_admin();
  if p_role is null or p_role not in ('admin', 'officer') then
    raise exception 'Choose Admin or Officer.' using errcode = 'PDS03';
  end if;
  if normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or normalized_email = 'officers@pdsaucf.com' then
    raise exception 'Enter an individual Google account email.' using errcode = 'PDS03';
  end if;
  select * into access_row from leadership_access where email = normalized_email for update;
  if access_row.id is not null then
    previous_role := case when access_row.revoked_at is null then access_row.role end;
    perform fn_leadership_keep_admin(access_row, p_role);
    update leadership_access set role = p_role, revoked_at = null, updated_at = now()
      where id = access_row.id returning * into access_row;
  else
    insert into leadership_access(email, role) values(normalized_email, p_role)
      returning * into access_row;
  end if;
  if access_row.user_id is not null then
    insert into profiles(user_id,role) values(access_row.user_id,p_role)
      on conflict(user_id) do update set role = excluded.role;
  end if;
  perform fn_leadership_audit(access_row, 'authorize', previous_role, p_role);
  return to_jsonb(access_row);
end
$$;
revoke all on function authorize_leadership_access(text,app_role) from public, anon, authenticated;
grant execute on function authorize_leadership_access(text,app_role) to authenticated;

create function set_leadership_role(p_access_id uuid, p_role app_role) returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  access_row leadership_access;
  previous_role app_role;
begin
  perform pg_advisory_xact_lock(721934, 1);
  perform fn_assert_admin();
  if p_role is null or p_role not in ('admin', 'officer') then
    raise exception 'Choose Admin or Officer.' using errcode = 'PDS03';
  end if;
  select * into access_row from leadership_access where id = p_access_id for update;
  if access_row.id is null or access_row.revoked_at is not null then
    raise exception 'Active leadership access not found.' using errcode = 'PDS03';
  end if;
  perform fn_leadership_keep_admin(access_row, p_role);
  previous_role := access_row.role;
  update leadership_access set role=p_role, updated_at=now()
    where id=p_access_id returning * into access_row;
  update profiles set role=p_role where user_id=access_row.user_id;
  perform fn_leadership_audit(access_row, 'change_role', previous_role, p_role);
  return to_jsonb(access_row);
end
$$;
revoke all on function set_leadership_role(uuid,app_role) from public, anon, authenticated;
grant execute on function set_leadership_role(uuid,app_role) to authenticated;

create function revoke_leadership_access(p_access_id uuid) returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare access_row leadership_access;
begin
  perform pg_advisory_xact_lock(721934, 1);
  perform fn_assert_admin();
  select * into access_row from leadership_access where id=p_access_id for update;
  if access_row.id is null then
    raise exception 'Leadership access not found.' using errcode = 'PDS03';
  end if;
  if access_row.revoked_at is not null then return to_jsonb(access_row); end if;
  perform fn_leadership_keep_admin(access_row, null);
  update leadership_access set revoked_at=now(), updated_at=now()
    where id=p_access_id returning * into access_row;
  delete from profiles where user_id=access_row.user_id;
  perform fn_leadership_audit(access_row, 'revoke', access_row.role, null);
  return to_jsonb(access_row);
end
$$;
revoke all on function revoke_leadership_access(uuid) from public, anon, authenticated;
grant execute on function revoke_leadership_access(uuid) to authenticated;

create function list_leadership_audit()
returns table(id uuid, access_id uuid, created_at timestamptz, action text,
              actor_email text, target_email text, old_role app_role, new_role app_role)
language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform fn_assert_admin();
  return query select a.id, a.access_id, a.created_at, a.action,
    a.actor_email, a.target_email, a.old_role, a.new_role
    from leadership_audit a order by a.created_at desc, a.id;
end
$$;
revoke all on function list_leadership_audit() from public, anon, authenticated;
grant execute on function list_leadership_audit() to authenticated;
commit;
