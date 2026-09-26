-- v_member_status.requirements_unmet: how many top-level honorary requirements
-- a member has not met yet.
--
-- The progress board filters to members one requirement away. Counting that in
-- the browser would be a second evaluator (invariant 2), so it comes from the
-- same fn_member_requirement_status() call that already decides is_honorary:
-- one call per member, read twice, at no extra cost.
--
-- NULL when the year has no published set, because there is nothing to be
-- short of. The column is appended, so every existing reader, which names its
-- columns, is unaffected.
begin;
set local search_path = public, extensions, pg_temp;

create or replace view v_member_status with (security_invoker = true) as
  select me.member_id,
         me.academic_year_id,
         coalesce(pt.point_total, 0)  as point_total,
         coalesce(h.passed, false)    as is_honorary,
         rs.set_id                    as requirement_set_id,
         case when rs.set_id is null then null else h.unmet end as requirements_unmet
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
    -- never called: passed is NULL, which falls back to false above.
    select bool_or(f.passed) filter (where f.node_id = s.root_node_id) as passed,
           count(*) filter (where f.parent_id = s.root_node_id and not f.passed)::int as unmet
    from requirement_sets s
    cross join lateral fn_member_requirement_status(me.member_id, s.id) f
    where s.id = rs.set_id
  ) h on true;

comment on view v_member_status is
  'Point total, honorary status and top-level requirements not yet met, per member per year. Honorary status is computed in Postgres, never in client JS.';

commit;
