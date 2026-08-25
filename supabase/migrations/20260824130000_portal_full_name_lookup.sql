-- The public portal asks one question, the member's complete name. Keep that
-- value intact through PostgREST so surnames with spaces and prefixes do not
-- depend on a client-side guess about where first name ends.

drop function if exists portal_find_members(text, text);

create function portal_find_members(p_name text)
returns table (
  member_id    uuid,
  display_name text,
  joined_on    date
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with asked as (
    select fn_normalise_name(p_name) as name
  )
  select m.id, m.display_name, me.joined_on
  from members m
  join member_enrollments me
    on me.member_id = m.id
   and me.academic_year_id = fn_portal_year()
  cross join asked a
  where a.name is not null
    and m.archived_at is null
    and m.merged_into_id is null
    and (fn_normalise_name(m.display_name) = a.name
         or fn_normalise_name(m.first_name || ' ' || m.last_name) = a.name)
  order by me.joined_on, m.display_name
  limit 10
$$;

comment on function portal_find_members(text) is
  'Public. The members of this years roster whose complete name matches, at most ten. Names, ids and join dates only: never an address, a student id or a total.';

revoke all on function portal_find_members(text) from public, anon, authenticated, service_role;
grant execute on function portal_find_members(text) to anon, authenticated, service_role;
