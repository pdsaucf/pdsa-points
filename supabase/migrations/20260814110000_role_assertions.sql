-- ===========================================================================
-- 16. THE ROLE ASSERTIONS, AND THE ONE FUNCTION STILL ON THE DEFAULT ACL
-- ===========================================================================
-- fn_assert_officer() did not refuse the caller it most needed to.
--
-- HOW. fn_is_officer() is `select fn_current_role() in ('officer','admin')`,
-- and fn_current_role() reads profiles for auth.uid(). A caller with no
-- profiles row selects no row, so fn_current_role() is NULL, so
-- `NULL in ('officer','admin')` is NULL, and fn_is_officer() returns NULL
-- rather than false. The assertion was written `if not fn_is_officer() then
-- raise`, and `not NULL` is NULL, which plpgsql treats as false: the IF branch
-- is not taken and the function returns normally. The caller is then inside a
-- SECURITY DEFINER RPC running with the owner's rights. fn_assert_admin() had
-- the same shape over fn_is_admin().
--
-- THAT CALLER EXISTS. Anyone who completes a magic-link sign-in with the anon
-- key holds an `authenticated` JWT, and nothing in this schema creates a
-- profiles row for them. An account nobody has given a role to is the default
-- state of a new sign-in, not an edge case, and every officer RPC below routed
-- its only role check through these two helpers.
--
-- THE FIX, AND WHY THIS DEFAULT. An assertion answers one question: may this
-- caller proceed. "I cannot tell" is not a yes. coalesce(..., false) makes an
-- indeterminate role a refusal, so the failure mode of a lookup that returns
-- nothing is a locked door rather than an open one. The error messages and the
-- PDS07 errcode are unchanged, because they are the contract clients match on
-- (README, "The security model in one paragraph").
--
-- THIS ALSO REFUSES service_role AND THE OWNER, which have no profiles row
-- either. That is intended. The product is a static frontend with no backend:
-- nothing calls these RPCs as service_role, no migration calls them, and every
-- test drives them as a signed-in user. A privileged caller that needs to
-- bypass a role check should write the tables directly rather than be handed a
-- silent exemption inside an assertion.
--
-- SO THE service_role GRANTS ON THOSE FUNCTIONS ARE INERT. Migrations 15 and
-- 17 grant EXECUTE to `authenticated, service_role`, and later migrations
-- following the same pattern will too. service_role can reach those functions
-- and is then refused by the check inside them, so the grant buys nothing.
-- It is left in place rather than trimmed from one function at a time, which
-- would only make two functions that should read alike read differently.
--
-- THE RECOVERY PATH IS THE TABLES. service_role is `bypassrls`, so an operator
-- who has to repair data does it with SQL against members, member_enrollments
-- and attendance_records directly. That is the right shape: a repair should be
-- visible as table writes rather than disguised as an officer action, and
-- nothing about it depends on an assertion quietly making an exception.
--
-- dismiss_duplicate_pair() is the one deliberate exception in the schema. Its
-- inline check is `coalesce(fn_is_officer(), auth.uid() is null)`, which admits
-- a caller with no end user at all. That is a choice made in migration 14 and
-- is left alone; it is not what these two helpers now do.
--
-- TWO FUNCTIONS ALREADY DID THIS THEMSELVES. dismiss_duplicate_pair()
-- (migration 14) and upsert_member_and_enroll() (migration 15) each carry an
-- inline positive check because this gap was known when they were written.
-- They are left exactly as they are: they are not the gap, and the helpers now
-- agree with them. dismiss_duplicate_pair() still admits a null auth.uid(),
-- which is a deliberate difference and not drift.
--
-- WHAT IS NOT HERE. `create or replace function` keeps the existing ACL, so
-- the grants migration 11 made to `authenticated` survive. That is asserted in
-- test/privileges.test.mjs rather than assumed, which is also where the
-- revoke below is held in place.
-- ===========================================================================

create or replace function fn_assert_officer()
returns void
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
begin
  if not coalesce(fn_is_officer(), false) then
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
  if not coalesce(fn_is_admin(), false) then
    raise exception 'This action requires an admin account.' using errcode = 'PDS07';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 16.1 The one function left on the default ACL
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC. Migration 11 cleared
-- that once, over the functions that existed then, and migrations 14 and 15
-- revoke their own. fn_members_member_column_guard() was created in migration
-- 11 itself, after that blanket revoke ran, and was missed: its proacl is
-- still null, which is the default, and the default grants PUBLIC EXECUTE.
--
-- Nothing is exploitable through it. It is a trigger function, so calling it
-- outside a trigger raises before its body runs, and its body only ever
-- refuses an update. It is revoked anyway so that "no function in public
-- carries EXECUTE for PUBLIC" is a property with no exceptions, which is what
-- test/privileges.test.mjs asserts. An invariant with one permitted exception
-- is an invariant nobody notices the second exception to.
--
-- The `alter default privileges ... revoke execute on functions from public`
-- in migration 01 does not cover this and never has: it writes no pg_default_
-- acl row, and a function created afterwards still comes out with `=X/postgres`
-- in its ACL. The line is harmless and is left where it is. The durable guard
-- is the test, not another default-privileges statement.
-- ---------------------------------------------------------------------------

revoke all on function fn_members_member_column_guard() from public, anon, authenticated;
