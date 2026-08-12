-- ===========================================================================
-- 00. DROP THE STARTER TABLES
-- ===========================================================================
--
-- READ THIS BEFORE APPLYING. THIS MIGRATION DESTROYS DATA.
--
-- The Supabase project was created with three placeholder tables named
-- `members`, `events` and `attendance`. The brief marks them as disposable:
-- they hold no production data and their shape does not match the design in
-- docs/01-data-model.md.
--
-- This migration is deliberately separate from every other migration so you
-- see it, and can decide about it, before anything else runs. If your project
-- does NOT have these starter tables, this migration is a no-op and is safe to
-- apply as-is. If you have put real data in them, STOP: back it up first,
-- because everything below is irreversible.
--
-- The `if exists` guards mean applying this twice is harmless.
-- ===========================================================================

drop table if exists public.attendance cascade;
drop table if exists public.events     cascade;
drop table if exists public.members    cascade;
