-- ===========================================================================
-- 09. HELPERS, THE REQUIREMENTS EVALUATOR, AND THE DERIVED VIEWS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 9.1 Role helpers
-- ---------------------------------------------------------------------------
-- These are SECURITY DEFINER on purpose. Policies on `profiles` need to read
-- `profiles` to decide who is asking; doing that through an ordinary query
-- would re-enter the policy that is currently being evaluated. A definer
-- function reads the table with the owner's rights, so the recursion never
-- starts.
--
-- Each one pins search_path, so a caller cannot shadow `profiles` with a
-- temp table of their own and promote themselves to admin.
-- ---------------------------------------------------------------------------

create or replace function fn_current_role()
returns app_role
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select p.role from profiles p where p.user_id = auth.uid()
$$;

create or replace function fn_current_member_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select p.member_id from profiles p where p.user_id = auth.uid()
$$;

create or replace function fn_is_admin()
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_current_role() = 'admin'
$$;

-- Officer means "officer or admin". An admin can do everything an officer can.
create or replace function fn_is_officer()
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_current_role() in ('officer', 'admin')
$$;

-- Staff means "can see the whole club", which includes the read-only viewer.
create or replace function fn_is_staff()
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_current_role() in ('officer', 'admin', 'viewer')
$$;

create or replace function fn_assert_officer()
returns void
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
begin
  if not fn_is_officer() then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;
end
$$;

create or replace function fn_assert_admin()
returns void
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
begin
  if not fn_is_admin() then
    raise exception 'This action requires an admin account.' using errcode = 'PDS07';
  end if;
end
$$;

-- Who may ask about one member's progress. Staff may ask about anyone; a
-- member may ask about themselves. A null auth.uid() means the caller is not
-- an end user at all (service_role, or a migration running as the owner), and
-- `anon` is never granted EXECUTE on anything that consults this.
create or replace function fn_can_view_member(p_member_id uuid)
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select case
    when auth.uid() is null then true
    when fn_is_staff()      then true
    else fn_current_member_id() is not distinct from p_member_id
  end
$$;

create or replace function fn_assert_can_view_member(p_member_id uuid)
returns void
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
begin
  if not fn_can_view_member(p_member_id) then
    raise exception 'Not allowed to read that members progress.' using errcode = 'PDS07';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 9.2 One summation path
-- ---------------------------------------------------------------------------
-- Every approved attendance record yields a numeric credit for each category
-- the event counts for. Event counts, hours and points differ only in where
-- the number comes from and how it is labelled. The evaluator never branches
-- on unit.
--
-- security_invoker means these views are filtered by the caller's own RLS.
-- A member reading v_member_status therefore gets their own row and correct
-- numbers, and an officer gets everyone, from the same view definition.
-- ---------------------------------------------------------------------------

create view v_attendance_credit with (security_invoker = true) as
  select a.id           as attendance_id,
         a.member_id,
         e.id           as event_id,
         e.academic_year_id,
         e.occurred_on,
         ec.category_id,
         case ec.credit_mode
           when 'fixed' then ec.fixed_credit
           else coalesce(a.submitted_value, 0)
         end as credit
  from attendance_records a
  join events           e  on e.id = a.event_id
  join event_categories ec on ec.event_id = e.id
  where a.status = 'approved'
    and a.member_id is not null;

create view v_member_category_totals with (security_invoker = true) as
  select member_id, academic_year_id, category_id, sum(credit) as total
  from v_attendance_credit
  group by member_id, academic_year_id, category_id;

-- ---------------------------------------------------------------------------
-- 9.3 The evaluator
-- ---------------------------------------------------------------------------
-- Returns one row per node in the set, evaluated deepest-first so a group
-- always sees its children's verdicts.
--
--   threshold  value  = SUM(credit) over the node's categories, in the set's
--                       academic year, optionally narrowed to a term
--              target = min_value
--   group      value  = how many children passed
--              target = min_children_passing, or the child count when null
--
-- No temp tables and no recursion in the plpgsql sense. Depth comes from one
-- recursive CTE, then the levels are walked from the leaves upward, carrying
-- the verdicts in a jsonb map. That keeps the function usable from inside a
-- lateral join over every member without leaving per-call state behind.
-- ---------------------------------------------------------------------------

create or replace function fn_member_requirement_status(
  p_member_id          uuid,
  p_requirement_set_id uuid
) returns table (
  node_id   uuid,
  parent_id uuid,
  type      node_type_t,
  label     text,
  value     numeric,
  target    numeric,
  passed    boolean
)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_year        uuid;
  v_depth       int;
  v_max_depth   int;
  v_values      jsonb := '{}'::jsonb;   -- node_id -> value
  v_targets     jsonb := '{}'::jsonb;   -- node_id -> target
  v_passed      jsonb := '{}'::jsonb;   -- node_id -> boolean
  r             record;
begin
  perform fn_assert_can_view_member(p_member_id);

  select rs.academic_year_id into v_year
  from requirement_sets rs
  where rs.id = p_requirement_set_id;

  if v_year is null then
    raise exception 'Unknown requirement set %.', p_requirement_set_id
      using errcode = 'PDS08';
  end if;

  -- Threshold values first. Every threshold is independent of every other
  -- node, so they all resolve in a single pass.
  for r in
    select n.id,
           coalesce((
             select sum(vac.credit)
             from requirement_node_categories rnc
             join v_attendance_credit vac
               on vac.category_id = rnc.category_id
             left join terms t on t.id = n.term_id
             where rnc.node_id = n.id
               and vac.member_id       = p_member_id
               and vac.academic_year_id = v_year
               and (n.term_id is null
                    or vac.occurred_on between t.starts_on and t.ends_on)
           ), 0) as value,
           n.min_value as target
    from requirement_nodes n
    where n.requirement_set_id = p_requirement_set_id
      and n.type = 'threshold'
  loop
    v_values  := jsonb_set(v_values,  array[r.id::text], to_jsonb(r.value));
    v_targets := jsonb_set(v_targets, array[r.id::text], to_jsonb(r.target));
    v_passed  := jsonb_set(v_passed,  array[r.id::text], to_jsonb(r.value >= r.target));
  end loop;

  -- Group nodes, deepest first.
  select max(d.depth) into v_max_depth
  from (
    with recursive tree as (
      select n.id, n.parent_id, 0 as depth
      from requirement_nodes n
      where n.requirement_set_id = p_requirement_set_id and n.parent_id is null
      union all
      select c.id, c.parent_id, tree.depth + 1
      from requirement_nodes c
      join tree on c.parent_id = tree.id
      where c.requirement_set_id = p_requirement_set_id
    )
    select depth from tree
  ) d;

  if v_max_depth is null then
    return;   -- an empty set evaluates to no rows
  end if;

  for v_depth in reverse v_max_depth .. 0 loop
    for r in
      with recursive tree as (
        select n.id, n.parent_id, 0 as depth
        from requirement_nodes n
        where n.requirement_set_id = p_requirement_set_id and n.parent_id is null
        union all
        select c.id, c.parent_id, tree.depth + 1
        from requirement_nodes c
        join tree on c.parent_id = tree.id
        where c.requirement_set_id = p_requirement_set_id
      )
      select n.id,
             n.min_children_passing,
             (select count(*) from requirement_nodes k where k.parent_id = n.id) as child_count
      from requirement_nodes n
      join tree on tree.id = n.id
      where n.requirement_set_id = p_requirement_set_id
        and n.type = 'group'
        and tree.depth = v_depth
    loop
      declare
        v_children_passed numeric;
        v_target          numeric;
      begin
        select count(*) filter (
                 where coalesce((v_passed #>> array[k.id::text])::boolean, false)
               )
          into v_children_passed
        from requirement_nodes k
        where k.parent_id = r.id;

        v_target := coalesce(r.min_children_passing, r.child_count);

        v_values  := jsonb_set(v_values,  array[r.id::text], to_jsonb(v_children_passed));
        v_targets := jsonb_set(v_targets, array[r.id::text], to_jsonb(v_target));
        v_passed  := jsonb_set(v_passed,  array[r.id::text],
                               to_jsonb(v_children_passed >= v_target));
      end;
    end loop;
  end loop;

  return query
    select n.id,
           n.parent_id,
           n.type,
           n.label,
           (v_values  #>> array[n.id::text])::numeric,
           (v_targets #>> array[n.id::text])::numeric,
           coalesce((v_passed #>> array[n.id::text])::boolean, false)
    from requirement_nodes n
    where n.requirement_set_id = p_requirement_set_id
    order by n.parent_id nulls first, n.sort_order, n.label;
end
$$;

comment on function fn_member_requirement_status(uuid, uuid) is
  'One row per requirement node for one member. Deepest-first, so groups see their childrens verdicts. Nothing about categories or thresholds is hardcoded here: everything comes from requirement_nodes.';

-- ---------------------------------------------------------------------------
-- 9.4 The published set for a year
-- ---------------------------------------------------------------------------

create or replace function fn_published_requirement_set(p_academic_year_id uuid)
returns uuid
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select rs.id
  from requirement_sets rs
  where rs.academic_year_id = p_academic_year_id
    and rs.status = 'published'
  order by rs.version desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- 9.5 Member status
-- ---------------------------------------------------------------------------
-- point_total sums only the categories flagged as counting toward it, which is
-- what reproduces a Total column that excludes Volunteering hours while still
-- requiring them for Honorary.
--
-- is_honorary is the root node's verdict. It is computed here, in Postgres,
-- and nowhere else.
-- ---------------------------------------------------------------------------

create view v_member_status with (security_invoker = true) as
  select me.member_id,
         me.academic_year_id,
         coalesce(pt.point_total, 0)  as point_total,
         coalesce(h.passed, false)    as is_honorary,
         rs.set_id                    as requirement_set_id
  from member_enrollments me
  left join lateral (
    select sum(t.total) as point_total
    from v_member_category_totals t
    join categories c on c.id = t.category_id
    where t.member_id        = me.member_id
      and t.academic_year_id = me.academic_year_id
      and c.counts_toward_point_total
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
  'Point total and honorary status per member per year. Honorary status is computed in Postgres, never in client JS.';

-- ---------------------------------------------------------------------------
-- 9.6 Configuration lint
-- ---------------------------------------------------------------------------
-- The anti-drift banner. Every row here is a way the spreadsheet went wrong.
-- ---------------------------------------------------------------------------

-- Abandoned uploads: a grant that expired without ever being submitted, whose
-- object may still be sitting in the bucket with nothing pointing at it.
-- purge_evidence() cannot see these, because it scans attendance_evidence and
-- no such row was ever created. purge_orphaned_uploads() reclaims them.
create view v_orphaned_uploads with (security_invoker = true) as
  select g.id            as grant_id,
         g.event_id,
         e.title         as event_title,
         g.member_id,
         g.kind,
         g.bucket_id,
         g.object_path,
         g.created_at,
         g.expires_at,
         exists (
           select 1 from storage.objects o
           where o.bucket_id = g.bucket_id and o.name = g.object_path
         ) as object_exists
  from evidence_upload_grants g
  join events e on e.id = g.event_id
  where g.consumed_at  is null
    and g.reclaimed_at is null
    and g.expires_at   < now()
    and not exists (
      select 1 from attendance_evidence ae where ae.object_path = g.object_path
    );

comment on view v_orphaned_uploads is
  'Uploads that were granted and never submitted. Storage the system is holding but nothing references. Reclaimed by purge_orphaned_uploads(), never on a timer.';

create view v_config_warnings with (security_invoker = true) as
  -- An active category that no published rule measures. This is the shape of
  -- "we added a category and forgot to give it a requirement".
  select 'category_without_rule'::text as code,
         'warning'::text               as severity,
         'category'::text              as subject_type,
         c.id                          as subject_id,
         c.name                        as subject_label,
         'Active category with no rule in the current years published requirement set.'::text as detail
  from categories c
  cross join lateral (select id from academic_years where is_current limit 1) ay
  where c.archived_at is null
    and not exists (
      select 1
      from requirement_node_categories rnc
      join requirement_nodes n  on n.id = rnc.node_id
      join requirement_sets  rs on rs.id = n.requirement_set_id
      where rnc.category_id = c.id
        and rs.academic_year_id = ay.id
        and rs.status = 'published'
    )

  union all

  -- A published rule still pointing at a category somebody archived. This is
  -- the #REF! tab, caught before anyone notices a wrong total.
  select 'rule_on_archived_category', 'error', 'requirement_node', n.id, n.label,
         'Requirement node measures category "' || c.name || '", which is archived.'
  from requirement_nodes n
  join requirement_node_categories rnc on rnc.node_id = n.id
  join categories       c  on c.id  = rnc.category_id
  join requirement_sets rs on rs.id = n.requirement_set_id
  where c.archived_at is not null
    and rs.status = 'published'

  union all

  -- An event nobody gets credit for.
  select 'event_without_category', 'error', 'event', e.id, e.title,
         'Published event has no categories, so attending it earns nothing.'
  from events e
  where e.is_published
    and not exists (select 1 from event_categories ec where ec.event_id = e.id)

  union all

  -- Asking for a photo and then not looking at it.
  select 'auto_approve_with_evidence', 'warning', 'event', e.id, e.title,
         'Event requires evidence but is set to auto-approve, so nobody will ever look at it.'
  from events e
  where e.review_policy = 'auto_approve'
    and exists (
      select 1 from event_evidence_requirements r
      where r.event_id = e.id and r.is_required
    )

  union all

  -- A year that cannot compute honorary status at all.
  select 'year_without_published_ruleset', 'error', 'academic_year', ay.id, ay.label,
         'Current academic year has no published requirement set, so nobody can qualify.'
  from academic_years ay
  where ay.is_current
    and fn_published_requirement_set(ay.id) is null

  union all

  -- A group with no children passes vacuously, which is almost never intended.
  select 'empty_group_node', 'warning', 'requirement_node', n.id, n.label,
         'Group node has no children, so it passes for everybody.'
  from requirement_nodes n
  join requirement_sets rs on rs.id = n.requirement_set_id
  where n.type = 'group'
    and rs.status = 'published'
    and not exists (select 1 from requirement_nodes k where k.parent_id = n.id)

  union all

  -- An event about to happen against an empty roster. The system ships with
  -- no members, so this is the state it starts in, and the failure it causes
  -- is silent: check-in still works, but every attendee falls through "I don't
  -- see my name" and lands in the review queue as an unmatched row for an
  -- officer to resolve by hand, one at a time, afterwards.
  --
  -- Telling them beforehand costs one banner. Discovering it afterwards costs
  -- an evening.
  select 'event_without_enrolled_members', 'error', 'event', e.id, e.title,
         'Nobody is enrolled in this events academic year, so every attendee will '
         || 'check in as an unmatched name. Load the roster with scripts/import_roster.py '
         || 'before the event.'
  from events e
  where e.is_published
    and (
      -- check-in is open now
      (e.checkin_opens_at is not null and e.checkin_opens_at <= now()
        and (e.checkin_closes_at is null or e.checkin_closes_at >= now()))
      -- or the event is coming up soon, including one with no window set yet
      or e.occurred_on between current_date and current_date + 7
    )
    and not exists (
      select 1 from member_enrollments me
      where me.academic_year_id = e.academic_year_id and me.status = 'active'
    )

  union all

  -- Storage being consumed by uploads nothing points at. One aggregate row
  -- rather than one per object, because the operator action is a single
  -- button and the per-object detail lives in v_orphaned_uploads.
  select 'orphaned_uploads', 'warning', 'storage', null,
         count(*)::text || ' abandoned upload(s)',
         'Photos were uploaded but never submitted, so no attendance record points at them. '
         || 'Run purge_orphaned_uploads() to reclaim them.'
  from v_orphaned_uploads
  where object_exists
  having count(*) > 0;
