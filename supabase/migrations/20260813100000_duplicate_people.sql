-- ===========================================================================
-- 14. DUPLICATE PEOPLE
-- ===========================================================================
-- merge_members() already resolves a duplicate person. What was missing is
-- finding the pair in the first place, and not asking a second time about a
-- pair an officer has already looked at and rejected.
--
-- Two objects, plus the settings that tune them:
--
--   v_possible_duplicate_members  one row per likely pair, never both orders
--   dismiss_duplicate_pair(a, b)  "these really are two people", remembered
--
-- WHY A DISMISSAL TABLE WITH A CANONICAL ORDER
--
-- A pair is an unordered thing, but a uuid pair is not: (a,b) and (b,a) are
-- different rows. If a caller could store either, dismissing a pair in one
-- order would leave the other order live, the view would keep offering the
-- pair, and the officer would be nagged forever about something they had
-- already answered. Worse, it would look like a bug in the dismissal rather
-- than in the ordering.
--
-- So the ordering is enforced by the table (`check (member_a < member_b)`),
-- not remembered by callers. dismiss_duplicate_pair() sorts its arguments
-- with least/greatest before inserting, the detector emits pairs in the same
-- order, and there is no code path that can produce the reversed row.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 14.1 Normalising the identifiers
-- ---------------------------------------------------------------------------
-- fn_normalise_name() (migration 03) already does this for names. These do it
-- for the two identifiers that make a duplicate near certain.
--
-- Both matter more than they look, because members.email and members.ucf_nid
-- are UNIQUE and citext. Two live rows therefore CANNOT hold the same address
-- or the same NID: the second insert is refused. The duplicate that does get
-- created is the one where the same person is written down slightly
-- differently, which is exactly what these two functions collapse.
-- ---------------------------------------------------------------------------

-- Gmail-style local part rules: a +tag and interior dots do not change who
-- receives the mail. abby.catto+pdsa@ucf.edu and abbycatto@ucf.edu are one
-- inbox, and the unique index does not know that.
create or replace function fn_normalise_email(p_email text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select case
           when v.local = '' or v.domain = '' then null
           else v.local || '@' || v.domain
         end
  from (
    select replace(
             regexp_replace(split_part(lower(btrim(coalesce(p_email, ''))), '@', 1), '\+.*$', ''),
             '.', ''
           ) as local,
           split_part(lower(btrim(coalesce(p_email, ''))), '@', 2) as domain
  ) v
$$;

comment on function fn_normalise_email(text) is
  'Lowercases, drops a +tag and interior dots from the local part. Two addresses that normalise the same reach one inbox, which the unique index on members.email cannot tell.';

-- ab123456, AB123456 and ab-123456 are one NID. citext already handles the
-- case; this handles the punctuation somebody typed.
create or replace function fn_normalise_nid(p_nid text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select nullif(regexp_replace(lower(btrim(coalesce(p_nid, ''))), '[^a-z0-9]+', '', 'g'), '')
$$;

-- ---------------------------------------------------------------------------
-- 14.2 Dismissals
-- ---------------------------------------------------------------------------

create table member_duplicate_dismissals (
  -- Always the lower uuid. See the check constraint below, which is what
  -- makes a dismissal order independent rather than trusting every caller to
  -- sort first.
  member_a     uuid not null references members on delete cascade,
  member_b     uuid not null references members on delete cascade,
  dismissed_by uuid references auth.users,
  dismissed_at timestamptz not null default now(),
  primary key (member_a, member_b),
  constraint member_duplicate_dismissals_canonical
    check (member_a < member_b)
);

create index member_duplicate_dismissals_b on member_duplicate_dismissals (member_b);

comment on table member_duplicate_dismissals is
  'Pairs an officer has confirmed are two different people. The check constraint holds the pair in one canonical order, so dismissing (a,b) also suppresses (b,a).';

comment on constraint member_duplicate_dismissals_canonical on member_duplicate_dismissals is
  'Pair identity is order independent. Enforced here rather than remembered by callers: a reversed row would silently resurrect a dismissed pair.';

-- Deleting a member takes their dismissals with them, unlike member_merges,
-- which restricts. A merge record is history and must survive; a dismissal is
-- a live suppression rule about two rows, and it means nothing once one of
-- them is gone. The audit_log entry written by dismiss_duplicate_pair() is
-- what survives either way.

-- ---------------------------------------------------------------------------
-- 14.3 Detection thresholds
-- ---------------------------------------------------------------------------
-- Rows, not constants, so the flood/miss balance is tuned from the admin UI.
--
-- WHY THESE ARE NOT duplicate_name_similarity (0.62, migration 08)
--
-- That setting answers a different question: at check-in, did this person tap
-- the wrong name in the picker? It fires per submission, into the review
-- queue, so it has to be a high bar. This one asks whether two ROSTER ROWS
-- are one human. It is shown once per pair and dismissable forever, so it can
-- afford a lower bar. Lowering the check-in bar to catch Abby/Abigail would
-- flag every check-in either of them ever makes.
--
-- MEASURED, on a synthetic 355-name roster (the size of the real one) drawn
-- from a realistic name pool:
--
--   whole-name similarity >= 0.45   31 pairs   catches Abby/Abigail Catto
--   whole-name similarity >= 0.50   18 pairs   misses it
--   whole-name similarity >= 0.55    4 pairs   misses it
--
-- A flat whole-name threshold cannot separate the case that matters from the
-- case that floods, because they score almost identically:
--
--   Abby Catto     vs Abigail Catto   0.4706   the same person
--   John Smith     vs Jane Smith      0.4667   two people
--
-- So the name test is in two parts instead. A high whole-name bar catches
-- misspellings anywhere in the name (Abby Catto vs Abby Cato, 0.75). A lower
-- bar applies only when the surnames match exactly AND the first names start
-- with the same letter, which is the shape a nickname takes (Abby/Abigail,
-- Mike/Michael, Sam/Samantha) and is not the shape two different people with
-- a common surname take (Roy/Juan Anderson is excluded by the initial).
--
-- Together: 15 pairs on that same 355-name roster, and Abby/Abigail Catto is
-- one of them.
--
-- Known limit: a nickname that changes the first letter (Liz/Elizabeth,
-- Bob/Robert) is not caught by the surname branch. Raising
-- duplicate_person_similarity's reach far enough to catch those brings the
-- flood back, so those are left to the check-in duplicate flag and to the CSV
-- import preview.
-- ---------------------------------------------------------------------------

insert into app_settings (key, value) values
  -- Whole-name trigram similarity. Catches a typo anywhere in the name.
  -- Values below 0.30 are clamped: see fn_duplicate_member_pairs().
  ('duplicate_person_similarity',         '0.55'::jsonb),
  -- The lower bar that applies only when the surname and the first initial
  -- both match exactly.
  ('duplicate_person_variant_similarity', '0.40'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 14.4 The detector
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for two concrete reasons, neither of them about hiding
-- anything:
--
--   * migration 11 revokes EXECUTE on every function in public from
--     authenticated, which includes pg_trgm's similarity(). A
--     security_invoker view calling it directly would fail for an officer.
--
--   * the trigram GIN index on members.display_name is only reachable through
--     the % operator, whose threshold is the pg_trgm.similarity_threshold
--     GUC. A view cannot set a GUC. The function pins it to 0.25 so the
--     prefilter is the same on every connection regardless of what the
--     caller's session has set, and the real, settings-driven threshold is
--     then applied on top of it.
--
-- The 0.25 pin is why duplicate_person_similarity is clamped to 0.30: below
-- that the prefilter, not the setting, would decide what is returned, and a
-- setting that silently stops working is worse than one with a floor. The %
-- operator is strictly greater-than, so 0.25 leaves room under a 0.30 floor.
--
-- Because it runs as the owner it bypasses RLS on members, so it carries its
-- own role check, in the same shape as fn_can_view_member(): a null auth.uid()
-- is the service role or a migration, and anything else must be staff. The
-- view on top joins back to members, so a member-role caller is filtered
-- twice over.
--
-- THE COALESCE IS NOT DECORATION. fn_current_role() returns NULL for a signed
-- in user with no profiles row, which is a reachable state: nothing creates a
-- profile automatically. `null in ('officer','admin')` is NULL, `not NULL` is
-- NULL, and plpgsql treats a NULL condition as false, so the obvious spelling
-- (`if not fn_is_staff() then return`) admits exactly the caller it is meant
-- to refuse. Staff status is therefore asserted positively, and the fallback
-- when the role is unknown is "only when there is no end user at all".
--
-- WHY EACH PAIR IS EMITTED ONCE. Every branch produces the lower uuid first,
-- either by joining on b.id > a.id or by least/greatest. A pair matched by
-- more than one branch collapses to its strongest reason, so a pair with the
-- same email and a similar name is reported as exact_email and not twice.
--
-- reason is the contract the UI branches on. score exists to rank, and the
-- exact reasons are pinned above any name similarity by construction:
--
--   exact_email  1.000   the same inbox after normalisation
--   exact_nid    0.999   the same NID after normalisation
--   exact_name   0.998   the same name after normalisation
--   close_name   <=0.997 trigram similarity of the two display names
-- ---------------------------------------------------------------------------

create or replace function fn_duplicate_member_pairs()
returns table (
  member_a uuid,
  member_b uuid,
  reason   text,
  score    numeric
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_whole   numeric;
  v_variant numeric;
begin
  -- Same pin as before (see the comment above), but set_config() rather than
  -- a function-level SET: Supabase's migration role is not permitted to
  -- ALTER FUNCTION ... SET on an extension-owned GUC, only to SET it at
  -- runtime. The `true` third argument scopes it to this transaction, which
  -- is what a function-level SET would have done anyway.
  perform set_config('pg_trgm.similarity_threshold', '0.25', true);

  if not coalesce(fn_is_staff(), auth.uid() is null) then
    return;
  end if;

  v_whole   := greatest(fn_setting_numeric('duplicate_person_similarity', 0.55), 0.30);
  v_variant := fn_setting_numeric('duplicate_person_variant_similarity', 0.40);

  return query
  with live as (
    select m.id,
           m.display_name,
           fn_normalise_name(m.display_name) as norm_name,
           fn_normalise_name(m.last_name)    as norm_last,
           left(fn_normalise_name(coalesce(m.preferred_name, m.first_name)), 1) as initial,
           fn_normalise_email(m.email)       as norm_email,
           fn_normalise_nid(m.ucf_nid)       as norm_nid
    from members m
    where m.archived_at is null
      and m.merged_into_id is null
  ),
  candidate as (
    select a.id as member_a, b.id as member_b,
           1 as priority, 'exact_email'::text as reason, 1.000::numeric as score
    from live a
    join live b on b.id > a.id and b.norm_email = a.norm_email
    where a.norm_email is not null

    union all

    select a.id, b.id, 2, 'exact_nid', 0.999
    from live a
    join live b on b.id > a.id and b.norm_nid = a.norm_nid
    where a.norm_nid is not null

    union all

    select a.id, b.id, 3, 'exact_name', 0.998
    from live a
    join live b on b.id > a.id and b.norm_name = a.norm_name
    where a.norm_name is not null

    union all

    -- Same surname, same first initial: the nickname shape. An equality join,
    -- so the trigram work only happens within a surname.
    select a.id, b.id, 4, 'close_name',
           least(round(similarity(a.display_name, b.display_name)::numeric, 3), 0.997)
    from live a
    join live b on b.id > a.id
               and b.norm_last = a.norm_last
               and b.initial   = a.initial
    where a.norm_last is not null
      and a.initial is not null
      and similarity(a.display_name, b.display_name) >= v_variant

    union all

    -- A misspelling anywhere in the name. This one reads members directly
    -- rather than the CTE above, because the % operator is what reaches
    -- members_name_trgm and a CTE would hide the index. It yields both
    -- orders, which least/greatest and the DISTINCT ON below fold together.
    select least(a.id, b.id), greatest(a.id, b.id), 5, 'close_name',
           least(round(similarity(a.display_name, b.display_name)::numeric, 3), 0.997)
    from members a
    join members b on b.id <> a.id
                  and b.display_name % a.display_name
    where a.archived_at is null and a.merged_into_id is null
      and b.archived_at is null and b.merged_into_id is null
      and similarity(a.display_name, b.display_name) >= v_whole
  )
  select distinct on (c.member_a, c.member_b)
         c.member_a, c.member_b, c.reason, c.score
  from candidate c
  where not exists (
    select 1
    from member_duplicate_dismissals d
    where d.member_a = c.member_a
      and d.member_b = c.member_b
  )
  order by c.member_a, c.member_b, c.priority, c.score desc;
end
$$;

comment on function fn_duplicate_member_pairs() is
  'Candidate duplicate people, one row per pair in canonical uuid order, strongest reason only, dismissed pairs removed.';

-- ---------------------------------------------------------------------------
-- 14.5 The view the Members screen reads
-- ---------------------------------------------------------------------------
-- records_a and records_b are attendance counts because that is the number an
-- officer decides the survivor on. Every attendance row counts, whatever its
-- status, since that is exactly what merge_members() would move.
--
-- joined_a and joined_b come from the earliest enrollment, falling back to
-- when the row was created for somebody who has never been enrolled.
-- ---------------------------------------------------------------------------

create view v_possible_duplicate_members with (security_invoker = true) as
  select p.member_a,
         p.member_b,
         ma.display_name as display_a,
         mb.display_name as display_b,
         ma.email        as email_a,
         mb.email        as email_b,
         p.reason,
         p.score,
         coalesce(ra.n, 0) as records_a,
         coalesce(rb.n, 0) as records_b,
         coalesce(ja.joined_on, ma.created_at::date) as joined_a,
         coalesce(jb.joined_on, mb.created_at::date) as joined_b
  from fn_duplicate_member_pairs() p
  join members ma on ma.id = p.member_a
  join members mb on mb.id = p.member_b
  left join lateral (
    select count(*)::int as n from attendance_records ar where ar.member_id = p.member_a
  ) ra on true
  left join lateral (
    select count(*)::int as n from attendance_records ar where ar.member_id = p.member_b
  ) rb on true
  left join lateral (
    select min(me.joined_on) as joined_on from member_enrollments me where me.member_id = p.member_a
  ) ja on true
  left join lateral (
    select min(me.joined_on) as joined_on from member_enrollments me where me.member_id = p.member_b
  ) jb on true
  order by p.score desc, ma.display_name, mb.display_name;

comment on view v_possible_duplicate_members is
  'Likely duplicate people, one row per pair. reason is a stable code (exact_email, exact_nid, exact_name, close_name); score ranks them. Archived, merged and dismissed pairs are already excluded.';

-- ---------------------------------------------------------------------------
-- 14.6 dismiss_duplicate_pair(a, b)
-- ---------------------------------------------------------------------------
-- Officer only, order independent, idempotent. There is no undo in the UI, so
-- the audit row is how a mistaken dismissal is found afterwards; deleting the
-- row is a service-role operation.
--
-- The role check is spelled out here rather than delegated to
-- fn_assert_officer(), for the reason given above 14.4: that helper asks
-- `if not fn_is_officer()`, which is NULL rather than true when the caller has
-- no profiles row, so it does not raise. Officer status is asserted positively
-- instead, and a caller whose role cannot be determined is refused unless
-- there is no end user at all (the service role, or a migration).
-- ---------------------------------------------------------------------------

create or replace function dismiss_duplicate_pair(p_member_a uuid, p_member_b uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_a uuid;
  v_b uuid;
begin
  if not coalesce(fn_is_officer(), auth.uid() is null) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  if p_member_a is null or p_member_b is null then
    raise exception 'Two members are required.' using errcode = 'PDS03';
  end if;
  if p_member_a = p_member_b then
    raise exception 'A member cannot be a duplicate of themselves.' using errcode = 'PDS03';
  end if;
  if not exists (select 1 from members where id = p_member_a)
     or not exists (select 1 from members where id = p_member_b) then
    raise exception 'Unknown member.' using errcode = 'PDS03';
  end if;

  -- The whole point. Callers may pass the pair either way round; one row is
  -- stored, and it suppresses both orders.
  v_a := least(p_member_a, p_member_b);
  v_b := greatest(p_member_a, p_member_b);

  insert into member_duplicate_dismissals (member_a, member_b, dismissed_by)
  values (v_a, v_b, auth.uid())
  on conflict (member_a, member_b) do nothing;

  perform fn_audit('dismiss_duplicate_pair', 'member', v_a,
                   jsonb_build_object('member_b', v_b));
end
$$;

-- ---------------------------------------------------------------------------
-- 14.7 Privileges
-- ---------------------------------------------------------------------------
-- THE REVOKES BELOW ARE LOAD BEARING, AND EVERY LATER MIGRATION NEEDS THEM.
--
-- Postgres grants EXECUTE on a new function to PUBLIC. Migration 11 clears
-- that with one `revoke all on all functions in schema public from public,
-- anon, authenticated`, but that ran once, over the functions that existed
-- then. Anything created afterwards, including everything in this file,
-- arrives with PUBLIC EXECUTE and is therefore callable by anon.
--
-- The `alter default privileges` in migration 01 does not cover this: it
-- leaves no row in pg_default_acl, and the function ACLs here were
-- `{=X/postgres,...}` until these lines existed. A SECURITY DEFINER function
-- reachable by anon is the exact shape of hole migration 11's header warns
-- about, so each function is revoked explicitly and then granted back to the
-- roles that should have it.
-- ---------------------------------------------------------------------------

alter table member_duplicate_dismissals enable row level security;

-- Readable by staff so an officer can audit what has been dismissed. Nobody
-- is granted a write: the only way a row appears is dismiss_duplicate_pair(),
-- which checks the caller is an officer.
grant select on member_duplicate_dismissals to authenticated;
grant all    on member_duplicate_dismissals to service_role;
create policy dup_dismissals_read on member_duplicate_dismissals
  for select to authenticated using (fn_is_staff());

grant select on v_possible_duplicate_members to authenticated, service_role;

revoke all on function fn_normalise_email(text)           from public, anon, authenticated;
revoke all on function fn_normalise_nid(text)             from public, anon, authenticated;
revoke all on function fn_duplicate_member_pairs()        from public, anon, authenticated;
revoke all on function dismiss_duplicate_pair(uuid, uuid) from public, anon, authenticated;

grant execute on function fn_duplicate_member_pairs()        to authenticated, service_role;
grant execute on function dismiss_duplicate_pair(uuid, uuid) to authenticated, service_role;

-- fn_normalise_email and fn_normalise_nid are granted to nobody but the
-- service role. They are called from inside the definer function above, which
-- runs as the owner, so no client needs to reach them.
grant execute on function fn_normalise_email(text) to service_role;
grant execute on function fn_normalise_nid(text)   to service_role;
