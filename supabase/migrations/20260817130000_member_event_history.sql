-- ===========================================================================
-- 23. A MEMBER'S OWN EVENT HISTORY
-- ===========================================================================
-- This reverses a decision migration 21 wrote down. That file says:
--
--   "A member's own check-in history is deliberately NOT here either. Approved
--    credit is a total on the leaderboard; the individual records are the part
--    an officer needs and a stranger does not."
--
-- The club asked for the opposite, and the reason is the spreadsheet this
-- product replaces. Its member-facing tab was a grid: one row per member, one
-- column per event of the year, a 1 in the cell where they attended and a blank
-- where they did not. A member could see which events they made, which they
-- missed, and when each one was. Replacing that with a single point total took
-- something away that people used.
--
-- WHAT THIS MEANS FOR PRIVACY, SAID PLAINLY RATHER THAN LEFT IMPLICIT, because
-- it is a wider surface than migration 21 opened. The portal has no login: a
-- member types a name and reads that member's page, and nothing stops them
-- typing somebody else's. So this function makes any member's event-by-event
-- attendance readable by anybody who can open points.pdsaucf.com. That is a
-- deliberate decision and it is the same one the leaderboard already makes: the
-- leaderboard lists every member with their point total, and the grid it
-- replaces was a link anybody in the club could open.
--
-- It is still a shaped answer to a shaped question. What is NOT here:
--
--   no email address, no student id, no notes, no audit trail, no photos,
--   no officer's decline reason, no flags, no reviewer, no review timestamp,
--   no claimed name from an unmatched check-in, no other member's records,
--   no unpublished event, no event from another year
--
-- A declined record says `declined` and stops there. The officer's reason is
-- the officer's, and a stranger typing a name would read it too.
--
-- WHY A SEPARATE FUNCTION rather than more keys on portal_scorecard(). The
-- scorecard is the fast answer, a handful of figures, and the page shows it the
-- moment it lands. This is a list as long as the club's year. Keeping them
-- apart means the points do not wait on the history, and it means the widened
-- surface is one named thing that test/privileges.test.mjs lists on purpose.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 23.1 Every event of the year, and what this member did about it
-- ---------------------------------------------------------------------------
-- Grouped by category, because that is how the requirements are written and how
-- the scorecard reads. An event attached to two categories appears under both,
-- which is correct: it earned credit in both.
--
-- WHICH CATEGORIES. Every live one, plus any archived one this member has a
-- record in. That second clause is not defensive habit. Credit from a category
-- retired mid-year still counts toward the point total, so leaving it out would
-- produce a page whose visible rows cannot account for the total printed above
-- them, which is exactly the disagreement that used to prove the total came
-- from Postgres. A section with no events and no credit is dropped instead of
-- drawn empty.
--
-- WHICH EVENTS. This year's, published only. An unpublished event is a draft an
-- officer has not opened yet, and a member seeing one would be reading over the
-- officer's shoulder.
--
-- WHICH RECORD, when there is more than one. `rejected` rows sit outside the
-- one_live_record_per_member_event unique index on purpose, so that a member
-- who was declined can check in again. That means an event can carry a rejected
-- row AND a later pending or approved one. The live row wins. A member who was
-- turned down, fixed the problem and checked in again should read where they
-- stand now, not the state that was superseded.
--
-- WHAT AN ATTENDED EVENT IS WORTH comes from v_attendance_credit and is not
-- recomputed here. That view is the single definition of what one record earns
-- (fixed_credit, or the number the member typed), and v_member_category_totals
-- is built on it. A second copy of that case expression in this file would be a
-- second definition, free to drift from the totals it sits next to.
--
-- NOTHING IS DENORMALISED. The title and the date are read from `events` on
-- every call, and the record is found by member_id. So renaming an event,
-- moving its date, or merging a duplicate member into another (which repoints
-- attendance_records.member_id) all show up here with nothing to run and
-- nothing to keep in step. test/public_portal.test.mjs does all three and reads
-- the result back, because that is the only thing that proves it.

create or replace function portal_attendance(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_year   uuid := fn_portal_year();
  v_member record;
  v_out    jsonb;
begin
  if v_year is null then
    raise exception 'No academic year is set up yet.' using errcode = 'PDS03';
  end if;

  select m.id, m.display_name
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

  with mine as (
    -- One row per event: the live record if there is one, otherwise the most
    -- recent rejected one.
    select distinct on (a.event_id)
           a.event_id,
           a.id     as attendance_id,
           a.status
    from attendance_records a
    join events e on e.id = a.event_id
    where a.member_id = v_member.id
      and e.academic_year_id = v_year
    order by a.event_id,
             (a.status <> 'rejected') desc,
             a.submitted_at desc
  ),
  shown as (
    select c.id, c.name, c.sort_order
    from categories c
    where c.archived_at is null
       or exists (
            select 1
            from mine
            join event_categories ec on ec.event_id = mine.event_id
            where ec.category_id = c.id
          )
  )
  select coalesce(jsonb_agg(section order by sort_order, name), '[]'::jsonb)
    into v_out
  from (
    select s.sort_order,
           s.name,
           jsonb_build_object(
             'id',     s.id,
             'name',   s.name,
             'total',  coalesce(t.total, 0),
             'events', coalesce(ev.events, '[]'::jsonb)
           ) as section
    from shown s
    left join v_member_category_totals t
      on t.category_id      = s.id
     and t.member_id        = v_member.id
     and t.academic_year_id = v_year
    left join lateral (
      select jsonb_agg(
               jsonb_build_object(
                 'id',          e.id,
                 'title',       e.title,
                 'occurred_on', e.occurred_on,
                 'status',      case
                                  when mine.status = 'approved' then 'attended'
                                  when mine.status = 'pending'  then 'waiting'
                                  when mine.status = 'rejected' then 'declined'
                                  -- Not "you missed this" while they can still
                                  -- walk up and scan the code. An event with an
                                  -- open window is open to them whatever the
                                  -- date says.
                                  when e.occurred_on > current_date
                                    or (e.checkin_closes_at is not null
                                        and e.checkin_closes_at > now())
                                    then 'upcoming'
                                  else 'none'
                                end,
                 'credit',      vc.credit
               ) order by e.occurred_on, e.title
             ) as events
      from events e
      join event_categories ec
        on ec.event_id = e.id
       and ec.category_id = s.id
      left join mine on mine.event_id = e.id
      -- Joins only for an approved record: the view selects those and no
      -- others, so `credit` is null for every other state without asking.
      left join v_attendance_credit vc
        on vc.attendance_id = mine.attendance_id
       and vc.category_id   = s.id
      where e.academic_year_id = v_year
        and e.is_published
    ) ev on true
    -- A live category with no events yet and nothing earned is a heading with
    -- nothing under it.
    where ev.events is not null
       or coalesce(t.total, 0) <> 0
  ) sections;

  return jsonb_build_object(
    'year', (select jsonb_build_object('id', y.id, 'label', y.label)
             from academic_years y where y.id = v_year),
    'member', jsonb_build_object('id', v_member.id,
                                 'display_name', v_member.display_name),
    'categories', v_out
  );
end
$$;

comment on function portal_attendance(uuid) is
  'Public. One members own event-by-event attendance for this year, by category: every published event with attended, waiting, declined, upcoming or nothing. No decline reason, no flags, no reviewer, no photos, no other members.';

-- ---------------------------------------------------------------------------
-- 23.2 Privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC, so this is revoked and
-- then granted deliberately, the same way migration 21 section 21.6 does it.

revoke all on function portal_attendance(uuid) from public, anon, authenticated;

grant execute on function portal_attendance(uuid) to anon, authenticated, service_role;
