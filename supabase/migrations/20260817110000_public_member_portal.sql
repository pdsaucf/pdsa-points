-- ===========================================================================
-- 21. THE MEMBER PORTAL, WITHOUT ACCOUNTS
-- ===========================================================================
-- The portal used to be an account. A member signed in with a magic link,
-- start_portal_session() worked out whether that account was linked to a roster
-- row, and if it was not they searched for themselves and filed a claim for an
-- officer to confirm (migration 18).
--
-- The club does not have email addresses for its members and does not want to
-- collect them, so all of that is gone. What a member does now is type their
-- name, and what they get back is their own progress. There is no sign-in, no
-- claim, and nothing for an officer to confirm.
--
-- WHAT THAT MEANS FOR PRIVACY, SAID PLAINLY RATHER THAN LEFT IMPLICIT. Anybody
-- who can open points.pdsaucf.com can read any member's category totals and
-- whether they are honorary, by typing their name. That is a deliberate
-- decision, and it is the same decision the leaderboard makes: the leaderboard
-- lists every member on the roster with their point total, which is the
-- spreadsheet this product replaces, which was a link anybody in the club could
-- open. So the functions below are readable by `anon` on purpose, and each one
-- is written to expose exactly the club-facing figures and nothing else:
--
--   no email address, no student id, no notes, no audit trail, no photos,
--   no pending or declined check-ins, no officer's decline reason
--
-- A member's own check-in history is deliberately NOT here either. Approved
-- credit is a total on the leaderboard; the individual records are the part an
-- officer needs and a stranger does not.
--
-- SECURITY DEFINER, and every one of these is a function rather than a grant on
-- a view, because a grant on v_member_status would hand anon the whole table
-- through PostgREST's filter syntax. A function returns a shaped answer to a
-- shaped question.
--
-- fn_member_requirement_status() is reached from inside these, which works
-- because fn_can_view_member() returns true when auth.uid() is null: an
-- anonymous PostgREST request has no JWT, and the SECURITY DEFINER call does
-- not invent one. Nothing here grants anon EXECUTE on the evaluator itself.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 21.1 The year everything below is about
-- ---------------------------------------------------------------------------
-- The portal never asks which year: a member looking at their points means this
-- one. academic_years is not readable by anon, so the year is resolved here,
-- and its label comes back with each answer so the page can name what it shows.

create or replace function fn_portal_year()
returns uuid
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select id from academic_years where is_current limit 1
$$;

comment on function fn_portal_year() is
  'The current academic year, for the public portal functions. One row at most: one_current_year enforces it.';

-- ---------------------------------------------------------------------------
-- 21.2 Finding yourself by name
-- ---------------------------------------------------------------------------
-- Two names in, at most ten rows out, and only members on THIS year's roster:
-- somebody who was here two years ago typing their name should be told they are
-- not on this year's list rather than shown a zero for a year they never joined.
--
-- Both spellings of a roster name are compared, the display name and first plus
-- last, so a member whose row carries a preferred name is found by either. The
-- comparison is fn_normalise_name(), the same one the duplicate view and the
-- import use, so "o halloran" finds "O'Halloran".
--
-- Several rows come back when the club genuinely has two members with one name.
-- The page asks which one, using the month they joined, because with no address
-- on file that is the only thing left that tells them apart.

create or replace function portal_find_members(p_first_name text, p_last_name text)
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
    select fn_normalise_name(btrim(coalesce(p_first_name, '')) || ' ' ||
                             btrim(coalesce(p_last_name, ''))) as name
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

comment on function portal_find_members(text, text) is
  'Public. The members of this years roster whose name matches, at most ten. Names, ids and join dates only: never an address, a student id or a total.';

-- ---------------------------------------------------------------------------
-- 21.3 One member's scorecard
-- ---------------------------------------------------------------------------
-- Every category with the member's total in it, the point total, whether they
-- are honorary, and the published rules evaluated requirement by requirement.
--
-- The verdicts come from fn_member_requirement_status(), which is the same
-- function v_member_status uses for is_honorary and the same one the officer's
-- member screen reads. Invariant 2: honorary status is computed in Postgres and
-- nowhere else, and that stays true when the caller is a stranger with a phone.
--
-- A member not on this year's roster is refused rather than answered with
-- zeroes, because a screen full of zeroes reads as "you have attended nothing"
-- when the truth is "you are not on this year's list, go and see an officer".

create or replace function portal_scorecard(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_year   uuid := fn_portal_year();
  v_set    uuid;
  v_member record;
  v_status record;
begin
  if v_year is null then
    raise exception 'No academic year is set up yet.' using errcode = 'PDS03';
  end if;

  select m.id, m.display_name, me.joined_on
    into v_member
  from members m
  join member_enrollments me
    on me.member_id = m.id
   and me.academic_year_id = v_year
  where m.id = p_member_id
    and m.archived_at is null
    and m.merged_into_id is null;

  if v_member.id is null then
    raise exception 'Nobody by that name is on this years roster.' using errcode = 'PDS03';
  end if;

  select s.point_total, s.is_honorary, s.requirement_set_id
    into v_status
  from v_member_status s
  where s.member_id = v_member.id
    and s.academic_year_id = v_year;

  v_set := v_status.requirement_set_id;

  return jsonb_build_object(
    'year', (select jsonb_build_object('id', y.id, 'label', y.label)
             from academic_years y where y.id = v_year),
    'member', jsonb_build_object('id', v_member.id,
                                 'display_name', v_member.display_name,
                                 'joined_on', v_member.joined_on),
    'point_total', coalesce(v_status.point_total, 0),
    'is_honorary', coalesce(v_status.is_honorary, false),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'name', c.name,
               'unit', c.unit,
               'unit_label', c.unit_label,
               'counts_toward_point_total', c.counts_toward_point_total,
               'total', coalesce(t.total, 0)
             ) order by c.sort_order, c.name)
      from categories c
      left join v_member_category_totals t
        on t.category_id = c.id
       and t.member_id = v_member.id
       and t.academic_year_id = v_year
      where c.archived_at is null
    ), '[]'::jsonb),
    'requirements', case
      when v_set is null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(jsonb_build_object(
                 'node_id', f.node_id,
                 'parent_id', f.parent_id,
                 'type', f.type,
                 'label', f.label,
                 'value', f.value,
                 'target', f.target,
                 'passed', f.passed,
                 'sort_order', n.sort_order,
                 'category_ids', coalesce((
                   select jsonb_agg(rnc.category_id)
                   from requirement_node_categories rnc
                   where rnc.node_id = f.node_id
                 ), '[]'::jsonb)
               ) order by n.sort_order, f.label)
        from fn_member_requirement_status(v_member.id, v_set) f
        join requirement_nodes n on n.id = f.node_id
      ), '[]'::jsonb)
    end,
    'root_node_id', (select rs.root_node_id from requirement_sets rs where rs.id = v_set)
  );
end
$$;

comment on function portal_scorecard(uuid) is
  'Public. One members category totals, point total, honorary verdict and the published requirements evaluated for them. No address, no student id, no individual check-ins.';

-- ---------------------------------------------------------------------------
-- 21.4 The leaderboard
-- ---------------------------------------------------------------------------
-- Every member on this year's roster, their point total, their honorary star,
-- and the per-category breakdown behind the total in the same payload. The
-- breakdown ships with the list rather than per member on demand: a club is a
-- few hundred people and ten categories, and a request per row opened would be
-- hundreds of round trips for numbers already in hand.
--
-- The rank is computed here, with ties sharing a rank, because a leaderboard
-- that numbers two equal totals 4 and 5 is a leaderboard arguing with itself.

create or replace function portal_leaderboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_year uuid := fn_portal_year();
begin
  if v_year is null then
    raise exception 'No academic year is set up yet.' using errcode = 'PDS03';
  end if;

  return jsonb_build_object(
    'year', (select jsonb_build_object('id', y.id, 'label', y.label)
             from academic_years y where y.id = v_year),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'name', c.name,
               'unit', c.unit,
               'unit_label', c.unit_label,
               'counts_toward_point_total', c.counts_toward_point_total
             ) order by c.sort_order, c.name)
      from categories c
      where c.archived_at is null
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'member_id', ranked.member_id,
               'display_name', ranked.display_name,
               'point_total', ranked.point_total,
               'is_honorary', ranked.is_honorary,
               'rank', ranked.rank,
               'totals', ranked.totals
             ) order by ranked.rank, ranked.display_name)
      from (
        select m.id as member_id,
               m.display_name,
               coalesce(s.point_total, 0) as point_total,
               coalesce(s.is_honorary, false) as is_honorary,
               rank() over (order by coalesce(s.point_total, 0) desc) as rank,
               coalesce((
                 select jsonb_object_agg(t.category_id, t.total)
                 from v_member_category_totals t
                 where t.member_id = m.id
                   and t.academic_year_id = v_year
               ), '{}'::jsonb) as totals
        from member_enrollments me
        join members m on m.id = me.member_id
        left join v_member_status s
          on s.member_id = m.id
         and s.academic_year_id = v_year
        where me.academic_year_id = v_year
          and m.archived_at is null
          and m.merged_into_id is null
      ) ranked
    ), '[]'::jsonb)
  );
end
$$;

comment on function portal_leaderboard() is
  'Public. Every member on this years roster with their point total, honorary star, rank and per-category breakdown. The club-facing figures only.';

-- ---------------------------------------------------------------------------
-- 21.5 What an Honorary Member is
-- ---------------------------------------------------------------------------
-- The published rules, drawn on the portal for somebody who has not looked
-- themselves up yet. It is the same tree the requirements editor writes and the
-- same one the scorecard evaluates, so the answer to "what do I have to do"
-- cannot drift from the answer to "have I done it".
--
-- Nothing about a member is in here, so it is the one portal function that
-- needs no argument at all.

create or replace function portal_requirements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_year uuid := fn_portal_year();
  v_set  uuid;
begin
  if v_year is null then
    raise exception 'No academic year is set up yet.' using errcode = 'PDS03';
  end if;
  v_set := fn_published_requirement_set(v_year);

  return jsonb_build_object(
    'year', (select jsonb_build_object('id', y.id, 'label', y.label)
             from academic_years y where y.id = v_year),
    'set', case
      when v_set is null then null
      else (select jsonb_build_object('id', rs.id, 'name', rs.name, 'version', rs.version,
                                      'root_node_id', rs.root_node_id)
            from requirement_sets rs where rs.id = v_set)
    end,
    'nodes', case
      when v_set is null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(jsonb_build_object(
                 'node_id', n.id,
                 'parent_id', n.parent_id,
                 'type', n.type,
                 'label', n.label,
                 'sort_order', n.sort_order,
                 'min_value', n.min_value,
                 'min_children_passing', n.min_children_passing,
                 'categories', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'id', c.id, 'name', c.name,
                            'unit', c.unit, 'unit_label', c.unit_label
                          ) order by c.sort_order, c.name)
                   from requirement_node_categories rnc
                   join categories c on c.id = rnc.category_id
                   where rnc.node_id = n.id
                 ), '[]'::jsonb)
               ) order by n.sort_order, n.label)
        from requirement_nodes n
        where n.requirement_set_id = v_set
      ), '[]'::jsonb)
    end
  );
end
$$;

comment on function portal_requirements() is
  'Public. The published requirement tree for this year, with the categories each requirement measures. What the portal shows before anybody looks themselves up.';

-- ---------------------------------------------------------------------------
-- 21.6 Privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC, and migration 11's
-- blanket revoke ran over the functions that existed then, so each of these is
-- revoked and then granted deliberately. anon is granted the four portal
-- functions and fn_portal_year() is not one of them: it is an internal helper,
-- and a year id is already in every answer.

revoke all on function fn_portal_year() from public, anon, authenticated;
revoke all on function portal_find_members(text, text) from public, anon, authenticated;
revoke all on function portal_scorecard(uuid) from public, anon, authenticated;
revoke all on function portal_leaderboard() from public, anon, authenticated;
revoke all on function portal_requirements() from public, anon, authenticated;

grant execute on function fn_portal_year() to service_role;
grant execute on function portal_find_members(text, text) to anon, authenticated, service_role;
grant execute on function portal_scorecard(uuid) to anon, authenticated, service_role;
grant execute on function portal_leaderboard() to anon, authenticated, service_role;
grant execute on function portal_requirements() to anon, authenticated, service_role;
