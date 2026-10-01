-- ===========================================================================
-- 30. EVENT SIGN-UPS
-- ===========================================================================
-- docs/09-event-signups.md. Sign-ups move off Google Forms and onto /events:
-- an officer builds the form on the event itself, a member signs up on the
-- public page, and the officer reads the responses as a sheet on the event's
-- own screen.
--
-- A SIGN-UP HOLDS ITS SPOT THE MOMENT IT IS SUBMITTED. No email goes out
-- then. At a time the officer picks (so many days before the event, at a
-- time of day), everybody in line is emailed a confirmation link the officer
-- wrote. Confirming keeps the spot. Not confirming within the officer's
-- window drops the sign-up, and the waitlist moves up.
--
-- WHO IS SIGNING UP. A member picks their roster name, and the confirmation
-- goes to the email address ON FILE for that member, never to an address the
-- person typed. Somebody who picks another member's name holds a spot until
-- the email goes out, and the real member, not them, holds the link. A guest
-- (open events only) types a name and an address, and the link goes there.
--
-- This reverses one sentence of invariant 8: members.email is now read, by
-- signup_due_emails() alone, to decide where a confirmation goes. It is never
-- returned to an anonymous caller, and never shown on a public page.
--
-- THE RAW TOKEN NEVER REACHES A BROWSER. signup_due_emails() is granted to
-- service_role only. The send-signup-emails Edge Function, run every five
-- minutes, calls it, receives each token and address, and emails the link.
-- Only the sha256 of a token is stored.
--
-- SPOTS ARE RANKED, NOT STORED. A live sign-up's place is its rank by
-- created_at among the event's live sign-ups. Rank within capacity is going,
-- past it is the waitlist, and a cancellation or a drop moves everybody
-- behind it up by one with no write anywhere. A drop is computed too: a held
-- sign-up whose confirm_by has passed.
begin;
set local search_path = public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- Event columns
-- ---------------------------------------------------------------------------
alter table events
  add column members_only     boolean not null default false,
  add column signups_enabled  boolean not null default false,
  add column signup_capacity  int check (signup_capacity is null or signup_capacity between 1 and 5000),
  add column signup_closes_at timestamptz,
  add column signup_email_days_before int not null default 2
    check (signup_email_days_before between 0 and 30),
  add column signup_email_time time not null default '18:00',
  add column signup_confirm_hours int not null default 24
    check (signup_confirm_hours between 1 and 168),
  add column signup_email_subject text check (length(signup_email_subject) <= 200),
  add column signup_email_body text check (length(signup_email_body) <= 4000),
  add column published_at     timestamptz;

comment on column events.members_only is
  'Only this years active roster may sign up. Shown on /events either way.';
comment on column events.signups_enabled is
  'The sign-up form on /events is on. events.signup (a link or a line of text) is the older, external route and is shown only when this is off.';
comment on column events.signup_capacity is
  'Spots. Null is unlimited. Live sign-ups past it are the waitlist.';
comment on column events.signup_closes_at is
  'When sign-ups close. Null closes them at starts_at, or at the end of occurred_on when there is no time.';
comment on column events.signup_email_days_before is
  'The confirmation email goes out this many days before occurred_on, at signup_email_time New York time.';
comment on column events.signup_confirm_hours is
  'How long after the email a sign-up has to confirm before it is dropped. Never past the start of the event.';
comment on column events.signup_email_subject is
  'The officer''s subject line, with {name} {event} {date} {time} {location} {confirm_by}. Null is the default.';
comment on column events.signup_email_body is
  'The officer''s message, same placeholders. The confirm link is added below it. Null is the default.';
comment on column events.published_at is
  'When an officer last published by hand. Drives the New ribbon on /events. Null when unpublished, or published before this column existed.';


-- Publish time is stamped by the database, so set_event_published() and any
-- future path agree on it without having to remember.
create function fn_event_published_at_before_write()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if new.is_published and (tg_op = 'INSERT' or not old.is_published) then
    new.published_at := now();
  elsif not new.is_published then
    new.published_at := null;
  end if;
  return new;
end
$$;

revoke all on function fn_event_published_at_before_write() from public, anon, authenticated;

create trigger events_published_at_before_write
  before insert or update of is_published on events
  for each row execute function fn_event_published_at_before_write();

-- The sign-up settings are event configuration: a stale editor must not write
-- them back over a newer save. Full definition from migration 29 plus the sign-up columns.
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
    or new.location is distinct from old.location
    or new.attire is distinct from old.attire
    or new.signup is distinct from old.signup
    or new.description is distinct from old.description
    or new.members_only is distinct from old.members_only
    or new.signups_enabled is distinct from old.signups_enabled
    or new.signup_capacity is distinct from old.signup_capacity
    or new.signup_closes_at is distinct from old.signup_closes_at
    or new.signup_email_days_before is distinct from old.signup_email_days_before
    or new.signup_email_time is distinct from old.signup_email_time
    or new.signup_confirm_hours is distinct from old.signup_confirm_hours
    or new.signup_email_subject is distinct from old.signup_email_subject
    or new.signup_email_body is distinct from old.signup_email_body
  ) then
    new.config_version := old.config_version + 1;
  end if;
  return new;
end
$$;

revoke all on function fn_event_config_version_before_update() from public, anon, authenticated;

-- The instant sign-ups stop: the officer's own close time, else the start of
-- the event, else midnight at the end of its day in New York.
create function fn_signup_closes_at(p_closes_at timestamptz, p_starts_at timestamptz, p_occurred_on date)
returns timestamptz
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(p_closes_at, p_starts_at,
                  ((p_occurred_on + 1)::timestamp at time zone 'America/New_York'))
$$;

revoke all on function fn_signup_closes_at(timestamptz, timestamptz, date) from public, anon;
grant execute on function fn_signup_closes_at(timestamptz, timestamptz, date) to authenticated;

-- When the confirmation email goes out: so many days before the event, at the
-- officer's time of day, in New York.
create function fn_signup_email_at(p_occurred_on date, p_days int, p_time time)
returns timestamptz
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select ((p_occurred_on - p_days) + p_time) at time zone 'America/New_York'
$$;

revoke all on function fn_signup_email_at(date, int, time) from public, anon;
grant execute on function fn_signup_email_at(date, int, time) to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create type signup_question_kind as enum ('short_text', 'long_text', 'single_choice', 'multi_choice');

create table event_signup_questions (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events on delete cascade,
  position    int  not null,
  kind        signup_question_kind not null,
  prompt      text not null check (length(btrim(prompt)) between 1 and 300),
  is_required boolean not null default false,
  options     text[] not null default '{}',
  check ((kind in ('single_choice', 'multi_choice')) = (cardinality(options) > 0))
);

create index event_signup_questions_event on event_signup_questions (event_id, position);

comment on table event_signup_questions is
  'The questions on an events sign-up form, in order. Edited only through save_event().';

create table event_signups (
  id               uuid primary key default gen_random_uuid(),
  -- Restrict, like attendance: an event people signed up for is not empty.
  event_id         uuid not null references events  on delete restrict,
  member_id        uuid references members on delete restrict,
  name             text not null check (length(btrim(name)) between 1 and 200),
  -- Where the confirmation goes: the roster address for a member, the typed
  -- one for a guest. Null only for somebody an officer added by hand.
  email            citext check (length(email) between 3 and 254),
  answers          jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  -- held: in line, not confirmed yet. confirmed: replied to the email, or
  -- added by an officer. cancelled: by them or by an officer.
  status           text not null default 'held'
                     check (status in ('held', 'confirmed', 'cancelled')),
  token_hash       bytea unique,
  emailed_at       timestamptz,
  email_attempts   int not null default 0,
  confirm_by       timestamptz,
  created_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  cancelled_at     timestamptz,
  cancelled_by     text check (cancelled_by in ('self', 'officer')),
  added_by_officer boolean not null default false,
  check (email is not null or added_by_officer),
  check (status <> 'confirmed' or confirmed_at is not null),
  check (status <> 'cancelled' or (cancelled_at is not null and cancelled_by is not null)),
  check (emailed_at is null or token_hash is not null)
);

-- One live sign-up per person per event, by roster row and by address.
create unique index event_signups_one_live_member on event_signups (event_id, member_id)
  where status <> 'cancelled' and member_id is not null;
create unique index event_signups_one_live_email on event_signups (event_id, email)
  where status <> 'cancelled';
create index event_signups_event on event_signups (event_id, status, created_at);
create index event_signups_due on event_signups (event_id) where status = 'held' and emailed_at is null;

comment on table event_signups is
  'Sign-ups from /events. Written only by portal_signup_submit(), signup_due_emails(), the portal_signup_* link functions, add_event_signup() and remove_event_signup().';

alter table event_signup_questions enable row level security;
alter table event_signups          enable row level security;

revoke all on event_signup_questions, event_signups from public, anon, authenticated;
grant select on event_signup_questions, event_signups to authenticated;
grant all on event_signup_questions, event_signups to service_role;

create policy signup_questions_read_staff on event_signup_questions
  for select to authenticated using ((select fn_is_staff()));
create policy signups_read_staff on event_signups
  for select to authenticated using ((select fn_is_staff()));

-- ---------------------------------------------------------------------------
-- Where each sign-up stands
-- ---------------------------------------------------------------------------
-- The one place going, waitlist and dropped are decided. Security invoker, so
-- an officer reading it goes through the policies above.
--
--   state   going | waitlist | dropped | cancelled
--   reply   confirmed | awaiting (emailed, inside the window) | scheduled
--           (email not sent yet) | null for dropped and cancelled
create view v_event_signups with (security_invoker = true) as
  with flagged as (
    select s.*,
           (s.status = 'held' and s.confirm_by is not null and s.confirm_by <= now()) as dropped
    from event_signups s
  ),
  ranked as (
    select f.*,
           case when f.status <> 'cancelled' and not f.dropped then
             row_number() over (partition by f.event_id, (f.status <> 'cancelled' and not f.dropped)
                                order by f.created_at, f.id)
           end as spot
    from flagged f
  )
  select r.id, r.event_id, r.member_id, r.name,
         -- A member's current roster address, where the email goes.
         case when r.member_id is not null then coalesce(m.email, r.email) else r.email end as email,
         r.answers, r.status,
         r.created_at, r.confirmed_at, r.cancelled_at, r.cancelled_by, r.emailed_at,
         r.confirm_by, r.added_by_officer,
         case
           when r.status = 'cancelled' then 'cancelled'
           when r.dropped then 'dropped'
           when e.signup_capacity is null or r.spot <= e.signup_capacity then 'going'
           else 'waitlist'
         end as state,
         case
           when r.spot is not null and e.signup_capacity is not null and r.spot > e.signup_capacity
             then (r.spot - e.signup_capacity)::int
         end as waitlist_position,
         case
           when r.status = 'cancelled' or r.dropped then null
           when r.status = 'confirmed' then 'confirmed'
           when r.emailed_at is not null then 'awaiting'
           else 'scheduled'
         end as reply,
         case when r.status = 'held' and r.emailed_at is null then
           greatest(fn_signup_email_at(e.occurred_on, e.signup_email_days_before, e.signup_email_time),
                    r.created_at)
         end as email_at
  from ranked r
  join events e on e.id = r.event_id
  left join members m on m.id = r.member_id;

revoke all on v_event_signups from public, anon, authenticated;
grant select on v_event_signups to authenticated, service_role;

comment on view v_event_signups is
  'Every sign-up with its state (going, waitlist, dropped, cancelled) and reply (confirmed, awaiting, scheduled). Spots are ranked by created_at at read time; a drop is a held sign-up past confirm_by.';

-- ---------------------------------------------------------------------------
-- Saving the form with the event
-- ---------------------------------------------------------------------------
-- save_event() is save_event_config() plus the sign-up settings and questions,
-- in the same transaction, so an event and its form cannot disagree. The
-- revision check is save_event_config()'s own, and runs first.
create function fn_apply_signup_form(p_event_id uuid, p_form jsonb)
returns void
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  v_enabled   boolean;
  v_members   boolean;
  v_capacity  int;
  v_closes    timestamptz;
  v_days      int;
  v_time      time;
  v_hours     int;
  v_subject   text;
  v_body      text;
  v_questions jsonb := coalesce(p_form -> 'questions', '[]'::jsonb);
  v_q         jsonb;
  v_index     int := 0;
  v_id        uuid;
  v_kind      signup_question_kind;
  v_prompt    text;
  v_options   text[];
  v_keep      uuid[] := '{}';
begin
  if jsonb_typeof(p_form) <> 'object' or jsonb_typeof(v_questions) <> 'array' then
    raise exception 'The sign-up form is not valid.' using errcode = 'PDS03';
  end if;
  if jsonb_array_length(v_questions) > 30 then
    raise exception 'A form can have at most 30 questions.' using errcode = 'PDS03';
  end if;

  begin
    v_enabled  := coalesce((p_form ->> 'enabled')::boolean, false);
    v_members  := coalesce((p_form ->> 'members_only')::boolean, false);
    v_capacity := nullif(p_form ->> 'capacity', '')::int;
    v_closes   := nullif(p_form ->> 'closes_at', '')::timestamptz;
    v_days     := coalesce(nullif(p_form ->> 'email_days_before', '')::int, 2);
    v_time     := coalesce(nullif(p_form ->> 'email_time', '')::time, '18:00');
    v_hours    := coalesce(nullif(p_form ->> 'confirm_hours', '')::int, 24);
    -- Blank, or the default word for word, stores null: the default.
    v_subject  := nullif(btrim(coalesce(p_form ->> 'email_subject', '')), '');
    v_body     := nullif(btrim(coalesce(p_form ->> 'email_body', '')), '');
  exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'The sign-up settings are not valid.' using errcode = 'PDS03';
  end;

  if v_capacity is not null and (v_capacity < 1 or v_capacity > 5000) then
    raise exception 'Spots must be between 1 and 5000.' using errcode = 'PDS03';
  end if;
  if v_enabled and v_closes is not null and exists (
    select 1 from events e where e.id = p_event_id
      and v_closes > fn_signup_closes_at(null, e.starts_at, e.occurred_on)
  ) then
    raise exception 'Sign-ups have to close by the start of the event.' using errcode = 'PDS03';
  end if;
  if v_days < 0 or v_days > 30 then
    raise exception 'Send the email 0 to 30 days before.' using errcode = 'PDS03';
  end if;
  if v_hours < 1 or v_hours > 168 then
    raise exception 'The confirm window is 1 to 168 hours.' using errcode = 'PDS03';
  end if;
  if length(v_subject) > 200 or length(v_body) > 4000 then
    raise exception 'The email is too long.' using errcode = 'PDS03';
  end if;
  if v_subject = fn_signup_email_default_subject() then v_subject := null; end if;
  if v_body = btrim(fn_signup_email_default_body()) then v_body := null; end if;

  update events
  set members_only = v_members,
      signups_enabled = v_enabled,
      signup_capacity = v_capacity,
      signup_closes_at = v_closes,
      signup_email_days_before = v_days,
      signup_email_time = v_time,
      signup_confirm_hours = v_hours,
      signup_email_subject = v_subject,
      signup_email_body = v_body
  where id = p_event_id;

  -- An email due at or after the event starts can never be sent (the queue
  -- stops at the start), and its sign-ups would never get a link or a
  -- deadline. Checked against the event as just saved, so a date or time
  -- change is checked too.
  if v_enabled and exists (
    select 1 from events e
    where e.id = p_event_id
      and fn_signup_email_at(e.occurred_on, v_days, v_time)
          >= fn_signup_closes_at(null, e.starts_at, e.occurred_on)
  ) then
    raise exception 'The confirmation email would go out after the event starts.' using errcode = 'PDS03';
  end if;

  for v_q in select value from jsonb_array_elements(v_questions) loop
    v_index := v_index + 1;
    begin
      v_id := coalesce(nullif(v_q ->> 'id', '')::uuid, gen_random_uuid());
      v_kind := (v_q ->> 'kind')::signup_question_kind;
    exception when invalid_text_representation then
      raise exception 'Question % is not valid.', v_index using errcode = 'PDS03';
    end;
    v_prompt := btrim(coalesce(v_q ->> 'prompt', ''));
    if v_prompt = '' then
      raise exception 'Question % needs a prompt.', v_index using errcode = 'PDS03';
    end if;
    if length(v_prompt) > 300 then
      raise exception 'Question % is too long.', v_index using errcode = 'PDS03';
    end if;

    if v_kind in ('single_choice', 'multi_choice') then
      if jsonb_typeof(coalesce(v_q -> 'options', 'null'::jsonb)) <> 'array' then
        raise exception 'Question % needs choices.', v_index using errcode = 'PDS03';
      end if;
      -- Blank choices dropped, repeats collapsed, the officer's order kept.
      select coalesce(array_agg(o order by n), '{}')
        into v_options
      from (
        select btrim(value) as o, min(ordinality) as n
        from jsonb_array_elements_text(v_q -> 'options') with ordinality
        where btrim(value) <> ''
        group by btrim(value)
      ) opts;
      if cardinality(v_options) = 0 then
        raise exception 'Question % needs choices.', v_index using errcode = 'PDS03';
      end if;
      if cardinality(v_options) > 30 or exists (select 1 from unnest(v_options) o where length(o) > 200) then
        raise exception 'Question % has too many or too long choices.', v_index using errcode = 'PDS03';
      end if;
    else
      v_options := '{}';
    end if;

    if exists (select 1 from event_signup_questions q where q.id = v_id and q.event_id <> p_event_id) then
      raise exception 'Question % belongs to another event.', v_index using errcode = 'PDS03';
    end if;
    if v_id = any (v_keep) then
      raise exception 'Question % is listed twice.', v_index using errcode = 'PDS03';
    end if;

    insert into event_signup_questions (id, event_id, position, kind, prompt, is_required, options)
    values (v_id, p_event_id, v_index, v_kind, v_prompt,
            coalesce((v_q ->> 'required')::boolean, false), v_options)
    on conflict (id) do update
      set position = excluded.position,
          kind = excluded.kind,
          prompt = excluded.prompt,
          is_required = excluded.is_required,
          options = excluded.options;

    v_keep := v_keep || v_id;
  end loop;

  -- Answers to a removed question stay in event_signups.answers. The sheet
  -- shows the current questions only.
  delete from event_signup_questions
  where event_id = p_event_id and not (id = any (v_keep));
end
$$;

revoke all on function fn_apply_signup_form(uuid, jsonb) from public, anon, authenticated;

create function save_event(
  p_event_id                uuid,
  p_academic_year_id        uuid,
  p_event                   jsonb,
  p_categories              jsonb default '[]'::jsonb,
  p_evidence                jsonb default null,
  p_expected_config_version bigint default null,
  p_create                  boolean default false,
  p_signup_form             jsonb default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_result  jsonb;
  v_replay  boolean;
begin
  perform fn_assert_officer();

  -- The same lock save_event_config() takes (it is reentrant), held from
  -- here so the replay check below and the save cannot interleave with
  -- another officer's save of this event.
  perform pg_advisory_xact_lock(
    hashtextextended('event-config:' || p_event_id::text, 724603)
  );
  -- A create whose response was lost and is retried finds its own event
  -- already written. save_event_config() answers it without changing
  -- anything, and so must the form: applying it now would overwrite
  -- whatever was saved since, with no revision check to stop it.
  v_replay := p_create and exists (select 1 from events where id = p_event_id);

  v_result := save_event_config(p_event_id, p_academic_year_id, p_event, p_categories,
                                p_evidence, p_expected_config_version, p_create);

  if p_signup_form is not null and not v_replay then
    perform fn_apply_signup_form(p_event_id, p_signup_form);
    -- The form is part of the same logical revision save_event_config() just
    -- wrote. Changing only config_version does not trip the version trigger.
    update events set config_version = (v_result ->> 'config_version')::bigint
    where id = p_event_id;
  end if;

  return v_result;
end
$$;

revoke all on function save_event(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean, jsonb)
  from public, anon;
grant execute on function save_event(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean, jsonb)
  to authenticated;

comment on function save_event(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean, jsonb) is
  'Officer only. save_event_config() plus the sign-up settings and questions, atomically. A null p_signup_form leaves the form as it was.';

-- ---------------------------------------------------------------------------
-- Answers
-- ---------------------------------------------------------------------------
-- Keeps only answers to this event's questions, checks each against its
-- question, and refuses a required one left blank.
create function fn_clean_signup_answers(p_event_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_q      event_signup_questions;
  v_raw    jsonb;
  v_text   text;
  v_list   text[];
  v_clean  jsonb := '{}'::jsonb;
begin
  if p_answers is not null and jsonb_typeof(p_answers) <> 'object' then
    raise exception 'The answers are not valid.' using errcode = 'PDS03';
  end if;

  for v_q in
    select * from event_signup_questions where event_id = p_event_id order by position
  loop
    v_raw := coalesce(p_answers, '{}'::jsonb) -> v_q.id::text;

    if v_q.kind = 'multi_choice' then
      if v_raw is null or jsonb_typeof(v_raw) = 'null' then
        v_list := '{}';
      elsif jsonb_typeof(v_raw) <> 'array' then
        raise exception 'Answer "%" is not valid.', v_q.prompt using errcode = 'PDS03';
      else
        select coalesce(array_agg(distinct value), '{}') into v_list
        from jsonb_array_elements_text(v_raw);
      end if;
      if exists (select 1 from unnest(v_list) x where not (x = any (v_q.options))) then
        raise exception 'Answer "%" is not one of the choices.', v_q.prompt using errcode = 'PDS03';
      end if;
      if v_q.is_required and cardinality(v_list) = 0 then
        raise exception 'Answer "%".', v_q.prompt using errcode = 'PDS03';
      end if;
      if cardinality(v_list) > 0 then
        -- Stored in the order the officer wrote the choices.
        v_clean := v_clean || jsonb_build_object(v_q.id::text,
          (select jsonb_agg(o order by n) from unnest(v_q.options) with ordinality u(o, n)
           where o = any (v_list)));
      end if;
    else
      if v_raw is not null and jsonb_typeof(v_raw) not in ('string', 'null') then
        raise exception 'Answer "%" is not valid.', v_q.prompt using errcode = 'PDS03';
      end if;
      v_text := nullif(btrim(coalesce(v_raw #>> '{}', '')), '');
      if v_q.is_required and v_text is null then
        raise exception 'Answer "%".', v_q.prompt using errcode = 'PDS03';
      end if;
      if v_text is not null then
        if v_q.kind = 'single_choice' and not (v_text = any (v_q.options)) then
          raise exception 'Answer "%" is not one of the choices.', v_q.prompt using errcode = 'PDS03';
        end if;
        if length(v_text) > (case when v_q.kind = 'long_text' then 4000 else 500 end) then
          raise exception 'Answer "%" is too long.', v_q.prompt using errcode = 'PDS03';
        end if;
        v_clean := v_clean || jsonb_build_object(v_q.id::text, v_text);
      end if;
    end if;
  end loop;

  return v_clean;
end
$$;

revoke all on function fn_clean_signup_answers(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- portal_signup_submit: the form on /events
-- ---------------------------------------------------------------------------
-- p_member_id set: a roster member. The address used later is the one on file.
-- p_member_id null: a guest, on an open event only, with the address typed.
-- A guest whose typed address is a roster member's becomes that member.
--
-- Holds a spot at once and sends nothing. Returns where the sign-up stands
-- and when the confirmation email goes out, and never an address.
create function portal_signup_submit(
  p_event_id  uuid,
  p_member_id uuid,
  p_name      text,
  p_email     text,
  p_answers   jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event    events;
  v_member   members;
  v_name     text;
  v_email    citext;
  v_answers  jsonb;
  v_existing v_event_signups;
  v_id       uuid;
  v_view     v_event_signups;
begin
  if p_event_id is null then
    raise exception 'Unknown event.' using errcode = 'PDS03';
  end if;

  perform fn_rate_limit_check('signup:' || p_event_id::text, 60);

  select * into v_event from events where id = p_event_id;
  if v_event.id is null
     or not fn_event_is_visible(v_event.is_published, v_event.release_at) then
    raise exception 'Unknown event.' using errcode = 'PDS03';
  end if;
  if not v_event.signups_enabled
     or now() >= fn_signup_closes_at(v_event.signup_closes_at, v_event.starts_at, v_event.occurred_on) then
    raise exception 'Sign-ups are closed.' using errcode = 'PDS19';
  end if;

  if p_member_id is null and nullif(btrim(coalesce(p_email, '')), '') is not null then
    select m.* into v_member
    from members m
    join member_enrollments me on me.member_id = m.id
     and me.academic_year_id = v_event.academic_year_id and me.status = 'active'
    where m.email = btrim(p_email)::citext
      and m.archived_at is null and m.merged_into_id is null;
  elsif p_member_id is not null then
    select m.* into v_member
    from members m
    join member_enrollments me on me.member_id = m.id
     and me.academic_year_id = v_event.academic_year_id and me.status = 'active'
    where m.id = p_member_id
      and m.archived_at is null and m.merged_into_id is null;
    if v_member.id is null then
      raise exception 'Not on this years roster.' using errcode = 'PDS17';
    end if;
  end if;

  if v_member.id is not null then
    if v_member.email is null then
      raise exception 'No email on file.' using errcode = 'PDS20';
    end if;
    v_name := v_member.display_name;
    v_email := v_member.email;
  else
    if v_event.members_only then
      raise exception 'Members only.' using errcode = 'PDS17';
    end if;
    v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
    v_email := nullif(btrim(coalesce(p_email, '')), '')::citext;
    if v_name = '' or length(v_name) > 200 then
      raise exception 'Type your full name.' using errcode = 'PDS03';
    end if;
    if v_email is null or length(v_email) > 254
       or v_email::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Type a valid email.' using errcode = 'PDS03';
    end if;
  end if;

  v_answers := fn_clean_signup_answers(p_event_id, p_answers);

  -- Serialises two submits for the same person on the same event.
  perform pg_advisory_xact_lock(
    hashtextextended('event-signup:' || p_event_id::text || ':' || lower(v_email::text), 724603)
  );

  select v.* into v_existing
  from v_event_signups v
  where v.event_id = p_event_id
    and v.state <> 'cancelled'
    and (v.email = v_email or (v_member.id is not null and v.member_id = v_member.id))
  order by v.created_at
  limit 1;

  if v_existing.id is not null and v_existing.state <> 'dropped' then
    raise exception 'Already signed up.' using errcode = 'PDS18';
  end if;

  if v_existing.id is not null then
    -- Dropped for not confirming: signing up again goes to the back of the line.
    delete from signup_deliveries where signup_id = v_existing.id;
    update event_signups
    set name = v_name, email = v_email, member_id = v_member.id, answers = v_answers,
        status = 'held', created_at = clock_timestamp(), token_hash = null, emailed_at = null,
        email_attempts = 0, confirm_by = null
    where id = v_existing.id
    returning id into v_id;
  else
    insert into event_signups (event_id, member_id, name, email, answers, created_at)
    values (p_event_id, v_member.id, v_name, v_email, v_answers, clock_timestamp())
    returning id into v_id;
  end if;

  select * into v_view from v_event_signups where id = v_id;
  return jsonb_build_object(
    'state',             v_view.state,
    'waitlist_position', v_view.waitlist_position,
    'email_at',          v_view.email_at,
    'confirm_hours',     v_event.signup_confirm_hours,
    'is_member',         v_member.id is not null
  );
end
$$;

revoke all on function portal_signup_submit(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function portal_signup_submit(uuid, uuid, text, text, jsonb) to anon, authenticated, service_role;

comment on function portal_signup_submit(uuid, uuid, text, text, jsonb) is
  'Public. Holds a spot on a visible event with its form on. Returns going or waitlist and when the confirmation email goes out. Never an address or a token.';

-- ---------------------------------------------------------------------------
-- The scheduled email
-- ---------------------------------------------------------------------------
-- The officer's subject and message with the placeholders filled in. The
-- same wording sits in web/src/signup-email.js for the form's preview, and
-- test/event_signups.test.mjs checks the two agree.
create function fn_signup_email_default_subject() returns text
language sql immutable set search_path = public, extensions, pg_temp
as $$ select 'Confirm your spot: {event}' $$;

create function fn_signup_email_default_body() returns text
language sql immutable set search_path = public, extensions, pg_temp
as $$
  select E'{name},\n\nYou signed up for {event} on {date}, {time}, at {location}.\n\n'
      || E'Confirm by {confirm_by} to keep your spot. Sign-ups not confirmed by then are dropped, '
      || E'and the next person on the waitlist moves up.\n\nPDSA UCF'
$$;

create function fn_signup_email_render(
  p_template   text,
  p_name       text,
  p_event      events,
  p_confirm_by timestamptz
) returns text
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select replace(replace(replace(replace(replace(replace(p_template,
    '{name}', p_name),
    '{event}', p_event.title),
    '{date}', to_char(p_event.occurred_on, 'FMDay, FMMonth FMDD')),
    '{time}', case
                when p_event.starts_at is null then 'time TBA'
                else to_char(p_event.starts_at at time zone 'America/New_York', 'FMHH12:MI AM')
                     || ' to '
                     || to_char(p_event.ends_at at time zone 'America/New_York', 'FMHH12:MI AM')
              end),
    '{location}', coalesce(p_event.location, 'location TBA')),
    '{confirm_by}', to_char(p_confirm_by at time zone 'America/New_York', 'FMDay, FMMonth FMDD, FMHH12:MI AM'))
$$;

revoke all on function fn_signup_email_default_subject() from public, anon;
revoke all on function fn_signup_email_default_body() from public, anon;
revoke all on function fn_signup_email_render(text, text, events, timestamptz) from public, anon, authenticated;
grant execute on function fn_signup_email_default_subject() to authenticated;
grant execute on function fn_signup_email_default_body() to authenticated;

-- A confirmation email on its way. One row per sign-up while its email is
-- claimed and not yet acknowledged: the raw token and the deadline printed in
-- the email live here, readable by service_role alone (no staff policy, no
-- grant), and are deleted the moment delivery is acknowledged or fails. A
-- claim whose run died is reclaimed after ten minutes with the SAME token,
-- deadline and delivery id, which the Edge Function sends as Resend's
-- Idempotency-Key: a lost response is never a second, different email.
create table signup_deliveries (
  signup_id  uuid primary key references event_signups on delete cascade,
  id         uuid not null unique default gen_random_uuid(),
  token      text not null,
  email      citext not null,
  confirm_by timestamptz not null,
  -- The email exactly as first sent. A reclaim resends these bytes, never a
  -- re-render: Resend refuses a reused Idempotency-Key with a changed body.
  subject    text not null,
  body       text not null,
  claimed_at timestamptz not null default now(),
  claims     int not null default 1
);

alter table signup_deliveries enable row level security;
revoke all on signup_deliveries from public, anon, authenticated;
grant all on signup_deliveries to service_role;

-- Every held sign-up whose email is due and not already on its way, at most
-- p_limit. Rows locked by a concurrent run are skipped. The send instant is
-- fn_signup_email_at(), or the sign-up itself for one made after it. A
-- member's address is read from the roster NOW, so a corrected address is
-- the one used; a guest's is the one they typed.
create function signup_due_emails(p_limit int default 100)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_row      record;
  v_delivery signup_deliveries;
  v_confirm  timestamptz;
  v_out      jsonb := '[]'::jsonb;
begin
  for v_row in
    select s.id, s.name, e as event,
           case when s.member_id is not null then m.email else s.email end as recipient
    from event_signups s
    join events e on e.id = s.event_id
    left join members m on m.id = s.member_id
    left join signup_deliveries d on d.signup_id = s.id
    where s.status = 'held'
      and s.emailed_at is null
      and s.email_attempts < 5
      and case when s.member_id is not null then m.email else s.email end is not null
      and (d.signup_id is null or (d.claimed_at < now() - interval '10 minutes' and d.claims < 5))
      and fn_signup_email_at(e.occurred_on, e.signup_email_days_before, e.signup_email_time) <= now()
      and fn_signup_closes_at(null, e.starts_at, e.occurred_on) > now()
    order by s.created_at
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update of s skip locked
  loop
    select * into v_delivery from signup_deliveries where signup_id = v_row.id for update;

    if v_delivery.signup_id is not null and v_delivery.email = v_row.recipient then
      -- A run died after claiming this one: the same email again.
      update signup_deliveries
      set claimed_at = now(), claims = claims + 1
      where signup_id = v_row.id
      returning * into v_delivery;
    else
      delete from signup_deliveries where signup_id = v_row.id;
      v_confirm := least(now() + make_interval(hours => (v_row.event).signup_confirm_hours),
                         fn_signup_closes_at(null, (v_row.event).starts_at, (v_row.event).occurred_on));
      insert into signup_deliveries (signup_id, token, email, confirm_by, subject, body)
      values (v_row.id, encode(gen_random_bytes(24), 'hex'), v_row.recipient, v_confirm,
              fn_signup_email_render(
                coalesce((v_row.event).signup_email_subject, fn_signup_email_default_subject()),
                v_row.name, v_row.event, v_confirm),
              fn_signup_email_render(
                coalesce((v_row.event).signup_email_body, fn_signup_email_default_body()),
                v_row.name, v_row.event, v_confirm))
      returning * into v_delivery;
      -- event_signups.email is not rewritten here: a corrected roster address
      -- can equal a guest's address on the same event, and the unique index
      -- would then refuse the whole run. The view shows the roster address.
      update event_signups
      set token_hash = digest(v_delivery.token, 'sha256'),
          email_attempts = email_attempts + 1
      where id = v_row.id;
    end if;

    v_out := v_out || jsonb_build_object(
      'signup_id',   v_row.id,
      'delivery_id', v_delivery.id,
      'token',       v_delivery.token,
      'email',       v_delivery.email,
      'subject',     v_delivery.subject,
      'body',        v_delivery.body
    );
  end loop;
  return v_out;
end
$$;

revoke all on function signup_due_emails(int) from public, anon, authenticated;
grant execute on function signup_due_emails(int) to service_role;

comment on function signup_due_emails(int) is
  'service_role only (the send-signup-emails Edge Function, every five minutes). Claims the confirmation emails now due and returns each with its delivery id, raw token, address, subject and message. Nothing counts as sent until signup_email_sent().';

-- Delivered: the confirm window starts, at the deadline the email printed.
create function signup_email_sent(p_signup_id uuid, p_delivery_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_delivery signup_deliveries;
begin
  delete from signup_deliveries
  where signup_id = p_signup_id and id = p_delivery_id
  returning * into v_delivery;
  if v_delivery.signup_id is null then
    return;
  end if;
  update event_signups
  set emailed_at = now(),
      confirm_by = v_delivery.confirm_by
  where id = p_signup_id and status <> 'cancelled';
end
$$;

revoke all on function signup_email_sent(uuid, uuid) from public, anon, authenticated;
grant execute on function signup_email_sent(uuid, uuid) to service_role;

-- Not delivered: back in the queue for the next run with a fresh token, up to
-- five attempts.
create function signup_email_failed(p_signup_id uuid)
returns void
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  delete from signup_deliveries where signup_id = p_signup_id;
  update event_signups
  set token_hash = null
  where id = p_signup_id and status = 'held' and emailed_at is null;
$$;

revoke all on function signup_email_failed(uuid) from public, anon, authenticated;
grant execute on function signup_email_failed(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The link in the email
-- ---------------------------------------------------------------------------
-- Anonymous, by token. 192 bits of secret; the stored side is a sha256.
create function fn_signup_by_token(p_token text)
returns uuid
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select s.id from event_signups s
  where p_token ~ '^[0-9a-f]{48}$'
    and s.token_hash = digest(p_token, 'sha256')
$$;

revoke all on function fn_signup_by_token(text) from public, anon, authenticated;

create function fn_signup_view(p_signup_id uuid)
returns jsonb
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'state',             v.state,
    'reply',             v.reply,
    'waitlist_position', v.waitlist_position,
    'confirm_by',        v.confirm_by,
    'name',              v.name,
    'event', jsonb_build_object(
      'id',          e.id,
      'title',       e.title,
      'occurred_on', e.occurred_on,
      'starts_at',   e.starts_at,
      'ends_at',     e.ends_at,
      'location',    e.location,
      'attire',      e.attire,
      'past',        e.occurred_on < (now() at time zone 'America/New_York')::date
    )
  )
  from v_event_signups v
  join events e on e.id = v.event_id
  where v.id = p_signup_id
$$;

revoke all on function fn_signup_view(uuid) from public, anon, authenticated;

create function portal_signup(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id uuid := fn_signup_by_token(p_token);
begin
  if v_id is null then
    raise exception 'Link not valid.' using errcode = 'PDS21';
  end if;
  return fn_signup_view(v_id);
end
$$;

-- Confirming keeps the spot. Allowed until confirm_by; after that the sign-up
-- has been dropped and its place given to the waitlist.
create function portal_signup_confirm(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id     uuid := fn_signup_by_token(p_token);
  v_signup event_signups;
begin
  if v_id is null then
    raise exception 'Link not valid.' using errcode = 'PDS21';
  end if;

  select * into v_signup from event_signups where id = v_id for update;

  if v_signup.status = 'held' then
    -- A null confirm_by is an email delivered whose acknowledgement has not
    -- landed yet: the link in hand is current, so it confirms.
    if v_signup.confirm_by <= now() then
      raise exception 'Confirmation window passed.' using errcode = 'PDS21';
    end if;
    update event_signups
    set status = 'confirmed', confirmed_at = now()
    where id = v_id;
  end if;

  return fn_signup_view(v_id);
end
$$;

create function portal_signup_cancel(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id     uuid := fn_signup_by_token(p_token);
  v_signup event_signups;
  v_event  events;
begin
  if v_id is null then
    raise exception 'Link not valid.' using errcode = 'PDS21';
  end if;

  select * into v_signup from event_signups where id = v_id for update;
  select * into v_event from events where id = v_signup.event_id;

  if v_signup.status <> 'cancelled' then
    if v_event.occurred_on < (now() at time zone 'America/New_York')::date then
      raise exception 'This event has passed.' using errcode = 'PDS19';
    end if;
    update event_signups
    set status = 'cancelled', cancelled_at = now(), cancelled_by = 'self'
    where id = v_id;
  end if;

  return fn_signup_view(v_id);
end
$$;

revoke all on function portal_signup(text) from public, anon, authenticated;
revoke all on function portal_signup_confirm(text) from public, anon, authenticated;
revoke all on function portal_signup_cancel(text) from public, anon, authenticated;
grant execute on function portal_signup(text) to anon, authenticated, service_role;
grant execute on function portal_signup_confirm(text) to anon, authenticated, service_role;
grant execute on function portal_signup_cancel(text) to anon, authenticated, service_role;

comment on function portal_signup(text) is
  'Public, by emailed token. The holders own sign-up state and the event. Never an address.';
comment on function portal_signup_confirm(text) is
  'Public, by emailed token. Confirms a held sign-up before its confirm_by. Idempotent.';
comment on function portal_signup_cancel(text) is
  'Public, by emailed token. Cancels the holders own sign-up before the event day. Idempotent.';

-- ---------------------------------------------------------------------------
-- Officer: remove a sign-up
-- ---------------------------------------------------------------------------
create function remove_event_signup(p_signup_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_signup event_signups;
begin
  perform fn_assert_officer();

  update event_signups
  set status = 'cancelled', cancelled_at = now(), cancelled_by = 'officer'
  where id = p_signup_id and status <> 'cancelled'
  returning * into v_signup;

  if v_signup.id is null then
    if not exists (select 1 from event_signups where id = p_signup_id) then
      raise exception 'Unknown sign-up.' using errcode = 'PDS03';
    end if;
    return jsonb_build_object('id', p_signup_id, 'status', 'cancelled');
  end if;

  perform fn_audit('remove_event_signup', 'event', v_signup.event_id,
                   jsonb_build_object('signup_id', v_signup.id));
  return jsonb_build_object('id', v_signup.id, 'status', v_signup.status);
end
$$;

revoke all on function remove_event_signup(uuid) from public, anon;
grant execute on function remove_event_signup(uuid) to authenticated;

comment on function remove_event_signup(uuid) is
  'Officer only and audited. Cancels one sign-up. The waitlist moves up on its own.';

-- ---------------------------------------------------------------------------
-- Officer: add a sign-up by hand
-- ---------------------------------------------------------------------------
-- For somebody who signed up in person. Confirmed at once, with no email and
-- no token anybody holds, and it takes its place in line like any other.
-- Spots, members only and the close time are not checked: an officer adding
-- somebody past them is deciding to.
create function add_event_signup(
  p_event_id  uuid,
  p_member_id uuid,
  p_name      text,
  p_email     text,
  p_answers   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_member members;
  v_name   text;
  v_email  citext;
  v_id     uuid;
begin
  perform fn_assert_officer();

  if not exists (select 1 from events where id = p_event_id) then
    raise exception 'Unknown event.' using errcode = 'PDS03';
  end if;

  if p_member_id is not null then
    select * into v_member from members
    where id = p_member_id and archived_at is null and merged_into_id is null;
    if v_member.id is null then
      raise exception 'Unknown member.' using errcode = 'PDS03';
    end if;
    v_name := v_member.display_name;
    v_email := v_member.email;
  else
    v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
    v_email := nullif(btrim(coalesce(p_email, '')), '')::citext;
    if v_name = '' or length(v_name) > 200 then
      raise exception 'Type a name.' using errcode = 'PDS03';
    end if;
    if v_email is not null and v_email::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Type a valid email.' using errcode = 'PDS03';
    end if;
  end if;

  if exists (
    select 1 from event_signups s
    where s.event_id = p_event_id and s.status <> 'cancelled'
      and ((v_member.id is not null and s.member_id = v_member.id)
           or (v_email is not null and s.email = v_email))
  ) then
    raise exception 'Already signed up.' using errcode = 'PDS18';
  end if;

  -- Officer answers are kept as typed, with only unknown questions dropped:
  -- a required question nobody asked in person is not a reason to refuse.
  insert into event_signups (event_id, member_id, name, email, answers, status,
                             confirmed_at, added_by_officer)
  values (p_event_id, v_member.id, v_name, v_email,
          coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(p_answers, '{}'::jsonb)) a(k, v)
                    where exists (select 1 from event_signup_questions q
                                  where q.event_id = p_event_id and q.id::text = a.k)), '{}'::jsonb),
          'confirmed', clock_timestamp(), true)
  returning id into v_id;

  perform fn_audit('add_event_signup', 'event', p_event_id, jsonb_build_object('signup_id', v_id));
  return jsonb_build_object('id', v_id);
end
$$;

revoke all on function add_event_signup(uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function add_event_signup(uuid, uuid, text, text, jsonb) to authenticated;

comment on function add_event_signup(uuid, uuid, text, text, jsonb) is
  'Officer only and audited. Adds a confirmed sign-up by hand, with no email sent.';

-- ---------------------------------------------------------------------------
-- Roster addresses
-- ---------------------------------------------------------------------------
-- The roster import carries an email column now. Each row is applied on its
-- own, so one address already used by somebody else does not lose the rest.
create function set_member_emails(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_row    jsonb;
  v_member uuid;
  v_email  citext;
  v_out    jsonb := '[]'::jsonb;
begin
  perform fn_assert_secretary_director();

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'The rows are not valid.' using errcode = 'PDS03';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    begin
      v_member := (v_row ->> 'member_id')::uuid;
      v_email := nullif(btrim(coalesce(v_row ->> 'email', '')), '')::citext;
      if v_email is not null and v_email::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        v_out := v_out || jsonb_build_object('member_id', v_member, 'error', 'Not an email address');
        continue;
      end if;
      update members set email = v_email where id = v_member;
      if not found then
        v_out := v_out || jsonb_build_object('member_id', v_member, 'error', 'Unknown member');
      else
        v_out := v_out || jsonb_build_object('member_id', v_member, 'email', v_email);
      end if;
    exception
      when unique_violation then
        v_out := v_out || jsonb_build_object('member_id', v_member, 'error', 'Email used by another member');
      when invalid_text_representation then
        v_out := v_out || jsonb_build_object('member_id', v_row ->> 'member_id', 'error', 'Unknown member');
    end;
  end loop;

  perform fn_audit('set_member_emails', 'member', null,
                   jsonb_build_object('rows', jsonb_array_length(p_rows)));
  return v_out;
end
$$;

revoke all on function set_member_emails(jsonb) from public, anon;
grant execute on function set_member_emails(jsonb) to authenticated;

comment on function set_member_emails(jsonb) is
  'Secretary Director. Sets or clears roster addresses, row by row. The address is where a member sign-up confirmation goes.';

-- ---------------------------------------------------------------------------
-- portal_member_names: the sign-up autocomplete
-- ---------------------------------------------------------------------------
-- This years active roster, names and ids only. portal_leaderboard() already
-- hands every one of these out with totals attached; this is the same list
-- without computing anybody's points, so the sign-up form can filter it as a
-- member types.
create function portal_member_names()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object('member_id', m.id, 'display_name', m.display_name, 'joined_on', me.joined_on)
           order by m.display_name, me.joined_on), '[]'::jsonb)
  from members m
  join member_enrollments me
    on me.member_id = m.id
   and me.academic_year_id = fn_portal_year()
   and me.status = 'active'
  where m.archived_at is null
    and m.merged_into_id is null
$$;

revoke all on function portal_member_names() from public, anon, authenticated;
grant execute on function portal_member_names() to anon, authenticated, service_role;

comment on function portal_member_names() is
  'Public. This years active roster for the sign-up autocomplete: id, display name and join date. The same names portal_leaderboard() lists, with no totals.';

-- ---------------------------------------------------------------------------
-- portal_events: sign-ups, members only, and when it was released
-- ---------------------------------------------------------------------------
-- Migration 29's definition plus: members_only, released_at (the New ribbon),
-- and, when the form is on, the sign-up block: whether it is open, spots,
-- how many are going and waiting, and the questions. Counts only: never a
-- name, an address or an answer.
create or replace function portal_events()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_year   uuid := fn_portal_year();
  v_auto   boolean := fn_setting_bool('events_auto_publish', true);
  v_events jsonb;
begin
  if v_year is null then
    raise exception 'No academic year is set up yet.' using errcode = 'PDS03';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',           e.id,
             'title',        e.title,
             'occurred_on',  e.occurred_on,
             'starts_at',    e.starts_at,
             'ends_at',      e.ends_at,
             'location',     e.location,
             'attire',       e.attire,
             'signup',       case when e.signups_enabled then null else e.signup end,
             'description',  e.description,
             'members_only', e.members_only,
             'released_at',  least(
                               case when e.is_published then e.published_at end,
                               case when v_auto and e.release_at <= now() then e.release_at end),
             'signups',      case when e.signups_enabled then jsonb_build_object(
                               'open',      now() < fn_signup_closes_at(e.signup_closes_at, e.starts_at, e.occurred_on),
                               'closes_at', fn_signup_closes_at(e.signup_closes_at, e.starts_at, e.occurred_on),
                               'capacity',  e.signup_capacity,
                               -- When the confirmation email goes out, so the
                               -- form can say so beside the name.
                               'email_at',          fn_signup_email_at(e.occurred_on, e.signup_email_days_before, e.signup_email_time),
                               'email_days_before', e.signup_email_days_before,
                               'confirm_hours',     e.signup_confirm_hours,
                               'going',     coalesce(counts.going, 0),
                               'waitlist',  coalesce(counts.waitlist, 0),
                               'questions', coalesce(questions.items, '[]'::jsonb)
                             ) end,
             'categories',   coalesce(categories.items, '[]'::jsonb)
           )
           order by e.occurred_on asc, e.starts_at asc nulls last, e.title
         ), '[]'::jsonb)
    into v_events
  from events e
  left join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'id',           c.id,
               'name',         c.name,
               'credit_mode',  ec.credit_mode,
               'fixed_credit', ec.fixed_credit
             ) order by c.sort_order, c.name
           ) as items
    from event_categories ec
    join categories c on c.id = ec.category_id
    where ec.event_id = e.id
  ) categories on true
  left join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'id',       q.id,
               'kind',     q.kind,
               'prompt',   q.prompt,
               'required', q.is_required,
               'options',  to_jsonb(q.options)
             ) order by q.position
           ) as items
    from event_signup_questions q
    where q.event_id = e.id and e.signups_enabled
  ) questions on true
  left join lateral (
    select count(*) filter (where v.state = 'going')    as going,
           count(*) filter (where v.state = 'waitlist') as waitlist
    from v_event_signups v
    where v.event_id = e.id and e.signups_enabled
  ) counts on true
  where e.academic_year_id = v_year
    and fn_event_is_visible(e.is_published, e.release_at)
    and e.occurred_on >= (now() at time zone 'America/New_York')::date;

  return jsonb_build_object(
    'year', (select jsonb_build_object('id', y.id, 'label', y.label)
             from academic_years y where y.id = v_year),
    'events', v_events
  );
end
$$;

comment on function portal_events() is
  'Public, no name required. Every visible event of the current academic year dated today or later: the facts the /events page shows, its categories, whether it is members only, when it was released, and its sign-up form with counts. No member, no attendance, no note, no token, no sign-up name or answer, and no unpublished event.';

revoke all on function portal_events() from public, anon, authenticated;
grant execute on function portal_events() to anon, authenticated, service_role;

commit;
