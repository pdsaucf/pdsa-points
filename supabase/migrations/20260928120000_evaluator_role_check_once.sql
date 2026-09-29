-- The requirements evaluator checks the caller once, then reads as the owner.
--
-- fn_member_requirement_status() runs a dozen or so statements per member,
-- and each touched attendance_records, events, event_categories, terms and the
-- requirement tables under the caller's RLS. Every policy is a role check, and
-- 20260926100000 only made that once per statement, so v_member_status paid
-- for tens of role lookups per member. At 235 members of 2026-2027 it passed
-- the 8 second statement timeout and the Members screen failed.
--
-- The evaluator already authorizes its caller in its first line:
-- fn_assert_can_view_member() admits staff, and definer code running with no
-- signed-in user (the public portal RPCs). SECURITY DEFINER keeps that check
-- and drops the per-table ones behind it. EXECUTE stays with authenticated.
--
-- One case changes meaning. The no-user clause of fn_can_view_member() tests
-- current_user, which inside a definer is the owner, so an authenticated
-- request carrying no user would now pass it. The evaluator refuses that case
-- itself. A portal RPC reaches it as anon, which keeps working.
begin;
set local search_path = public, extensions, pg_temp;

do $migration$
declare
  definition text;
  guard constant text := 'perform fn_assert_can_view_member(p_member_id);';
begin
  definition := pg_get_functiondef('public.fn_member_requirement_status(uuid,uuid)'::regprocedure);
  if strpos(definition, guard) = 0 then
    raise exception 'fn_member_requirement_status no longer authorizes its caller';
  end if;
  execute replace(definition, guard, guard || '
  if auth.uid() is null and current_setting(''role'', true) = ''authenticated'' then
    raise exception ''Not allowed to read that members progress.'' using errcode = ''PDS07'';
  end if;');
end
$migration$;

alter function fn_member_requirement_status(uuid, uuid) security definer;

-- Unchanged, restated so this file alone shows who may call it.
revoke all on function fn_member_requirement_status(uuid, uuid) from public, anon;
grant execute on function fn_member_requirement_status(uuid, uuid) to authenticated;

commit;
