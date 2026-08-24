-- Event fields, category links and the evidence requirement are one
-- configuration. Saving them through separate HTTP requests can leave a
-- partly edited event, and category changes immediately alter derived point
-- totals for approved attendance. This RPC replaces the whole configuration
-- in one transaction and checks a persisted revision after locking the event.

alter table events add column config_version bigint not null default 1;

-- Direct event updates outside the RPC still advance the revision. The RPC
-- writes its chosen next version explicitly, so this trigger does not add a
-- second increment there.
create or replace function fn_event_config_version_before_update()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if new.config_version = old.config_version and (
       new.academic_year_id is distinct from old.academic_year_id
    or new.term_id is distinct from old.term_id
    or new.title is distinct from old.title
    or new.occurred_on is distinct from old.occurred_on
    or new.notes is distinct from old.notes
    or new.review_policy is distinct from old.review_policy
    or new.checkin_token is distinct from old.checkin_token
    or new.checkin_opens_at is distinct from old.checkin_opens_at
    or new.checkin_closes_at is distinct from old.checkin_closes_at
    or new.token_rotated_at is distinct from old.token_rotated_at
    or new.is_published is distinct from old.is_published
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
  ) then
    new.config_version := old.config_version + 1;
  end if;
  return new;
end
$$;

revoke all on function fn_event_config_version_before_update() from public, anon, authenticated;

create trigger event_config_version_before_update
before update on events
for each row execute function fn_event_config_version_before_update();

-- Category and evidence writes carry no version column of their own. Bumping
-- the parent makes a stale whole-event editor notice those changes too.
create or replace function fn_bump_parent_event_config_version()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_old_event uuid := case when tg_op in ('UPDATE', 'DELETE') then old.event_id else null end;
  v_new_event uuid := case when tg_op in ('UPDATE', 'INSERT') then new.event_id else null end;
begin
  if v_old_event is not null and v_old_event is distinct from v_new_event then
    update events set config_version = config_version + 1 where id = v_old_event;
  end if;
  if v_new_event is not null then
    update events set config_version = config_version + 1 where id = v_new_event;
  elsif v_old_event is not null then
    update events set config_version = config_version + 1 where id = v_old_event;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function fn_bump_parent_event_config_version() from public, anon, authenticated;

create trigger event_categories_bump_config_version
after insert or update or delete on event_categories
for each row execute function fn_bump_parent_event_config_version();

create trigger event_evidence_bump_config_version
after insert or update or delete on event_evidence_requirements
for each row execute function fn_bump_parent_event_config_version();

create or replace function save_event_config(
  p_event_id               uuid,
  p_academic_year_id       uuid,
  p_event                  jsonb,
  p_categories             jsonb default '[]'::jsonb,
  p_evidence               jsonb default null,
  p_expected_config_version bigint default null,
  p_create                 boolean default false
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event          events;
  v_title          text := btrim(coalesce(p_event ->> 'title', ''));
  v_occurred       date;
  v_starts         timestamptz;
  v_ends           timestamptz;
  v_closes         timestamptz;
  v_term           uuid;
  v_category_count int;
  v_next_version   bigint;
  v_old_value_set  uuid[];
  v_new_value_set  uuid[];
begin
  perform fn_assert_officer();

  if p_event_id is null or p_academic_year_id is null then
    raise exception 'Event id and academic year are required.' using errcode = 'PDS03';
  end if;
  if v_title = '' then
    raise exception 'Type a title.' using errcode = 'PDS03';
  end if;
  if jsonb_typeof(coalesce(p_categories, '[]'::jsonb)) <> 'array' then
    raise exception 'Event categories must be a list.' using errcode = 'PDS03';
  end if;
  if p_evidence is not null and jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'The photo requirement is not valid.' using errcode = 'PDS03';
  end if;

  begin
    v_occurred := nullif(p_event ->> 'occurred_on', '')::date;
    v_starts := nullif(p_event ->> 'starts_at', '')::timestamptz;
    v_ends := nullif(p_event ->> 'ends_at', '')::timestamptz;
    v_closes := nullif(p_event ->> 'checkin_closes_at', '')::timestamptz;
    v_term := nullif(p_event ->> 'term_id', '')::uuid;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'The event date or time is not valid.' using errcode = 'PDS03';
  end;

  if v_occurred is null then
    raise exception 'Pick a date.' using errcode = 'PDS03';
  end if;
  if (v_starts is null) <> (v_ends is null) or (v_starts is not null and v_ends <= v_starts) then
    raise exception 'Enter both event times, with the end after the start.' using errcode = 'PDS03';
  end if;
  if not exists (select 1 from academic_years y where y.id = p_academic_year_id) then
    raise exception 'Unknown academic year.' using errcode = 'PDS03';
  end if;
  if v_term is not null and not exists (
    select 1 from terms t where t.id = v_term and t.academic_year_id = p_academic_year_id
  ) then
    raise exception 'That term does not belong to this academic year.' using errcode = 'PDS03';
  end if;

  -- The advisory lock also covers a not-yet-existing row. Two create retries
  -- carrying the same caller-generated UUID therefore cannot both observe an
  -- empty slot and race into the primary key. Hash collisions only serialize
  -- unrelated event saves; they cannot change either result.
  perform pg_advisory_xact_lock(
    hashtextextended('event-config:' || p_event_id::text, 724603)
  );

  -- This row lock is the serialization point shared with fn_checkin_event().
  select * into v_event from events e where e.id = p_event_id for update;

  if p_create and v_event.id is not null then
    if v_event.academic_year_id <> p_academic_year_id then
      raise exception 'That event belongs to another academic year.' using errcode = 'PDS03';
    end if;
    -- A committed create whose HTTP response was lost returns the one event
    -- already written under the caller-generated id. The first call was
    -- atomic, so there is no partial configuration to repair here.
    return jsonb_build_object('id', v_event.id,
                              'checkin_token', v_event.checkin_token,
                              'config_version', v_event.config_version,
                              'created', true);
  end if;

  if not p_create then
    if v_event.id is null then
      raise exception 'Unknown event.' using errcode = 'PDS03';
    end if;
    if v_event.academic_year_id <> p_academic_year_id then
      raise exception 'That event belongs to another academic year.' using errcode = 'PDS03';
    end if;
    if p_expected_config_version is null
       or p_expected_config_version <> v_event.config_version then
      raise exception 'This event changed after you opened it. Reload it before saving.'
        using errcode = 'PDS15';
    end if;
  end if;

  select count(*) into v_category_count
  from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
       as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric);

  if v_category_count <> (
    select count(distinct c.category_id)
    from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
         as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
  ) then
    raise exception 'Choose each category once.' using errcode = 'PDS03';
  end if;

  -- A retired category may stay on the event it already belongs to, but its
  -- mode and credit are frozen. It cannot be attached to another event.
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
         as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
    left join categories cat on cat.id = c.category_id
    where c.category_id is null or c.credit_mode is null or c.fixed_credit is null
       or cat.id is null
       or (cat.archived_at is not null and not exists (
         select 1 from event_categories old
         where old.event_id = p_event_id
           and old.category_id = c.category_id
           and old.credit_mode = c.credit_mode
           and old.fixed_credit = c.fixed_credit
       ))
  ) then
    raise exception 'One of those categories cannot be used.' using errcode = 'PDS03';
  end if;

  if (
    select count(*)
    from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
         as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
    where c.credit_mode = 'from_submission'
  ) > 1 then
    raise exception 'Only one category can use member-entered points.' using errcode = 'PDS03';
  end if;

  -- Once submissions exist, changing which category reads submitted_value
  -- would reinterpret already stored values. Fixed credit remains editable
  -- and intentionally updates derived totals retroactively.
  if not p_create and exists (
    select 1 from attendance_records a where a.event_id = p_event_id
  ) then
    select array(
      select ec.category_id from event_categories ec
      where ec.event_id = p_event_id and ec.credit_mode = 'from_submission'
      order by ec.category_id
    ) into v_old_value_set;
    select array(
      select c.category_id
      from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
           as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
      where c.credit_mode = 'from_submission'
      order by c.category_id
    ) into v_new_value_set;
    if v_old_value_set is distinct from v_new_value_set then
      raise exception 'Member-entered points cannot be changed after check-ins exist.'
        using errcode = 'PDS03';
    end if;
  end if;

  if p_create then
    insert into events (
      id, academic_year_id, title, occurred_on, starts_at, ends_at,
      term_id, checkin_closes_at, created_by, config_version
    ) values (
      p_event_id, p_academic_year_id, v_title, v_occurred, v_starts, v_ends,
      v_term, v_closes, auth.uid(), 1
    ) returning * into v_event;
    v_next_version := 1;
  else
    v_next_version := v_event.config_version + 1;
    update events
    set title = v_title,
        occurred_on = v_occurred,
        starts_at = v_starts,
        ends_at = v_ends,
        term_id = v_term,
        checkin_closes_at = v_closes,
        config_version = v_next_version
    where id = p_event_id;
  end if;

  delete from event_categories where event_id = p_event_id;
  insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
  select p_event_id, c.category_id, c.credit_mode, c.fixed_credit
  from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
       as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric);

  delete from event_evidence_requirements where event_id = p_event_id;
  if p_evidence is not null then
    insert into event_evidence_requirements (event_id, kind, is_required, prompt)
    values (p_event_id,
            (p_evidence ->> 'kind')::evidence_kind_t,
            true,
            nullif(btrim(coalesce(p_evidence ->> 'prompt', '')), ''));
  end if;

  -- Child triggers may have advanced the revision several times inside this
  -- still-invisible transaction. The whole save is one logical revision.
  update events set config_version = v_next_version where id = p_event_id;

  perform fn_audit(
    case when p_create then 'create_event' else 'save_event' end,
    'event',
    p_event_id,
    jsonb_build_object('category_count', v_category_count,
                       'has_evidence', p_evidence is not null,
                       'config_version', v_next_version)
  );

  select * into v_event from events e where e.id = p_event_id;
  return jsonb_build_object('id', v_event.id,
                            'checkin_token', v_event.checkin_token,
                            'config_version', v_event.config_version,
                            'created', p_create);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'The event configuration is not valid.' using errcode = 'PDS03';
end
$$;

revoke all on function save_event_config(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean)
  from public, anon;
grant execute on function save_event_config(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean)
  to authenticated;

comment on function save_event_config(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean) is
  'Officer only and audited. Atomically saves an events fields, categories and evidence after a locked revision check. A caller-generated id makes create retry idempotent. Retired links may only be preserved unchanged.';
