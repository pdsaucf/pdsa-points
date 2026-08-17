-- ===========================================================================
-- 22. ONE UNIT, CALLED POINTS
-- ===========================================================================
-- Two pieces of configuration on `categories` are removed here, and both are
-- removed for the same reason: they were shapes with nothing behind them.
--
-- `unit` (event_count | hours | points) NEVER CHANGED ANY ARITHMETIC. The
-- comment above the evaluator in migration 09 says so outright: "Event counts,
-- hours and points differ only in where the number comes from and how it is
-- labelled. The evaluator never branches on unit." It does not even decide
-- where the number comes from. That is event_categories.credit_mode, which is
-- per event and stays exactly as it is:
--
--   fixed            attending is worth fixed_credit, default 1. A QR scan.
--   from_submission  the member types a number at check-in and that number is
--                    the credit. A receipt, a headcount, a raised total.
--
-- So "Events" and "Points" were two words for one behaviour, offered as a
-- choice an officer had to make and could not get right or wrong. The club does
-- not track hours any more, which removes the third. What is left is one unit,
-- and the product already has a name for it: this is a point system, the total
-- is in points, and every category's credit is points.
--
-- `counts_toward_point_total` EXISTED FOR VOLUNTEERING HOURS. The 2025-2026
-- spreadsheet summed every category into the Total column except Volunteering,
-- because adding 29.5 hours to a count of events is not a number
-- (docs/00-spreadsheet-findings.md, finding 4). With hours gone, so is the only
-- thing it was ever false for: every live category already has it true, and the
-- checkbox offered an officer a way to make a member's point total quietly
-- wrong.
--
-- MEASURED, NOT ASSUMED, before dropping anything: on the live project all
-- thirteen categories are event_count, none carries a unit_label, and all
-- thirteen count toward the total. Nothing real is lost here.
--
-- WHAT REPLACES THE LABEL. Nothing, in most places. A number beside a category
-- name is named by the category: "GBMs 3 of 9" needs no noun after it, and it
-- is what an event count already rendered as. The one place a word is still
-- wanted is the point total itself, which says "45 points" and always did, in
-- client copy rather than in a column. The check-in form's number field is
-- labelled from the category name for the same reason, which is what
-- valueFieldLabel() already fell back to.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 22.1 The point total is the sum of all credit
-- ---------------------------------------------------------------------------
-- Redefined BEFORE the column is dropped, because the view reads it. Postgres
-- would refuse the drop otherwise, which is the correct order made mandatory.

create or replace view v_member_status with (security_invoker = true) as
  select me.member_id,
         me.academic_year_id,
         coalesce(pt.point_total, 0)  as point_total,
         coalesce(h.passed, false)    as is_honorary,
         rs.set_id                    as requirement_set_id
  from member_enrollments me
  left join lateral (
    select sum(t.total) as point_total
    from v_member_category_totals t
    where t.member_id        = me.member_id
      and t.academic_year_id = me.academic_year_id
  ) pt on true
  left join lateral (
    select fn_published_requirement_set(me.academic_year_id) as set_id
  ) rs on true
  left join lateral (
    -- When there is no published set, `s` yields no rows and the evaluator is
    -- never called, so is_honorary falls back to false rather than erroring.
    select f.passed
    from requirement_sets s
    cross join lateral fn_member_requirement_status(me.member_id, s.id) f
    where s.id = rs.set_id
      and f.node_id = s.root_node_id
  ) h on true;

comment on view v_member_status is
  'Point total and honorary status per member per year. The total is every categorys credit added up: one unit, and it is points. Honorary status is computed in Postgres, never in client JS.';

-- ---------------------------------------------------------------------------
-- 22.2 The columns, and the enum
-- ---------------------------------------------------------------------------
-- The functions that carried `unit` out to a client are redefined first, for the
-- same reason the view was: a function body is not checked until it runs, but
-- leaving one of them referring to a dropped column would break the check-in
-- page rather than this migration, which is a worse place to find out.
--
-- EACH ONE IS THE CURRENT DEFINITION WITH THE UNIT FIELDS TAKEN OUT, copied
-- rather than retyped. get_checkin_context() is the reason that is written
-- down: it mints the client nonce, bounds that minting through
-- fn_rate_limit_check(), and shares its token and window checks with
-- fn_checkin_event(). A version of it typed out fresh lost all three, every
-- caller ended up in one rate-limit bucket, and test/burst.test.mjs is what
-- said so.

create or replace function get_checkin_context(p_token text)
returns jsonb
language plpgsql
volatile                       -- it now mints a nonce, so it writes
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event events;
  v_out   jsonb;
  v_nonce text;
begin
  v_event := fn_checkin_event(p_token, true);

  -- Minting is bounded per token per minute, so the number of rate-limit
  -- buckets one event can have is itself capped. Without this, a caller could
  -- mint a fresh bucket per request and have no effective limit at all.
  perform fn_rate_limit_check(
    'nonce:' || p_token,
    fn_setting_int('checkin_nonce_max_per_min', 600)
  );

  insert into checkin_client_nonces (event_id, expires_at)
  values (v_event.id,
          now() + make_interval(mins => fn_setting_int('checkin_nonce_ttl_minutes', 240)))
  returning nonce into v_nonce;

  -- Cheap opportunistic cleanup of nonces nobody can use any more.
  delete from checkin_client_nonces where expires_at < now() - interval '1 day';

  select jsonb_build_object(
    -- Opaque, expiring, and worth nothing on its own. The client sends it back
    -- with search_members() and submit_checkin() so those calls are counted
    -- against this browser rather than against everybody at the event. It
    -- authorizes nothing: see the note in migration 08.
    'client_nonce', v_nonce,
    'event', jsonb_build_object(
      'id',          v_event.id,
      'title',       v_event.title,
      'occurred_on', v_event.occurred_on,
      'location',    v_event.location,
      'closes_at',   v_event.checkin_closes_at
    ),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',   c.id,
               'name', c.name
             ) order by c.sort_order, c.name)
      from event_categories ec
      join categories c on c.id = ec.category_id
      where ec.event_id = v_event.id
    ), '[]'::jsonb),
    -- Non-null when the form has to collect a number, and it says which
    -- category the number is for. That name is what labels the field: there is
    -- nothing else left to carry.
    'collect_value', (
      select jsonb_build_object(
               'category_id', c.id,
               'category',    c.name
             )
      from event_categories ec
      join categories c on c.id = ec.category_id
      where ec.event_id = v_event.id and ec.credit_mode = 'from_submission'
      limit 1
    ),
    'evidence_requirements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind',        r.kind,
               'is_required', r.is_required,
               'prompt',      r.prompt
             ) order by r.kind)
      from event_evidence_requirements r
      where r.event_id = v_event.id
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end
$$;

comment on function get_checkin_context(text) is
  'Anonymous. Everything the check-in page draws itself from, for one token: the event, its categories, whether a number is collected and for which category, and the evidence it asks for. Never a member, never a total.';

-- The two portal functions from migration 21, minus the unit they carried.

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
               'name', c.name
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
                   select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                          order by c.sort_order, c.name)
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

-- Now the columns themselves.

alter table categories drop column counts_toward_point_total;
alter table categories drop column unit;
alter table categories drop column unit_label;

-- The enum goes with its last user. Nothing else in the schema ever referenced
-- it, which is checked by the drop itself: Postgres refuses a type that is
-- still depended on.
drop type unit_type;

comment on table categories is
  'What a requirement measures. A category is a name and an order, and its credit is points: there is one unit, and event_categories.credit_mode decides whether attending is worth a fixed amount or the member supplies the number.';

-- ---------------------------------------------------------------------------
-- 22.3 One sentence left alone, on purpose
-- ---------------------------------------------------------------------------
-- submit_checkin() and request_missing_credit() both refuse a submission that
-- is missing a number the event collects, and both say "This event needs a
-- number (hours, for example)". The example is now the one thing this product
-- does not measure.
--
-- It is left as it is rather than fixed here, because fixing it means
-- recreating a 212-line function to edit a parenthetical, and a verbatim copy
-- of that much SQL is a drift hazard worth more than the sentence. The path is
-- a backstop: the check-in page validates the field before it submits, so
-- reaching this message means a client that bypassed its own form. The client
-- copy a member actually reads is in web/src/, and that is corrected.
