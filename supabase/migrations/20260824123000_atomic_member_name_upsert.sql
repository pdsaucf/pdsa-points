-- Normalised name is the last identity tier for roster imports. The lookup
-- and insert need a transaction-scoped lock on that logical identity, or two
-- simultaneous no-email imports can both see no row and create duplicates.

create or replace function upsert_member_and_enroll(
  p_first_name        text,
  p_last_name         text,
  p_email             citext,
  p_ucf_nid           citext,
  p_academic_year_id  uuid,
  p_matched_member_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_first    text;
  v_last     text;
  v_email    citext;
  v_nid      citext;
  v_name     text;
  v_member   uuid;
  v_next     uuid;
  v_created  boolean := false;
  v_enrolled boolean := false;
  v_rows     int;
begin
  if not coalesce(fn_is_officer(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  v_first := btrim(coalesce(p_first_name, ''));
  v_last := btrim(coalesce(p_last_name, ''));
  if v_first = '' or v_last = '' then
    raise exception 'A member needs a first name and a last name.' using errcode = 'PDS03';
  end if;
  if p_academic_year_id is null or not exists (
    select 1 from academic_years y where y.id = p_academic_year_id
  ) then
    raise exception 'Unknown academic year.' using errcode = 'PDS03';
  end if;

  v_email := nullif(btrim(coalesce(p_email::text, '')), '')::citext;
  v_nid := nullif(btrim(coalesce(p_ucf_nid::text, '')), '')::citext;
  v_name := fn_normalise_name(v_first || ' ' || v_last);

  if p_matched_member_id is not null then
    select id into v_member from members where id = p_matched_member_id;
    if v_member is null then
      raise exception 'Unknown member.' using errcode = 'PDS03';
    end if;
  else
    -- Hash collisions only serialize unrelated names. They cannot make the
    -- result incorrect. The lock lasts through member creation and enrollment.
    perform pg_advisory_xact_lock(hashtextextended('member-name:' || v_name, 724601));

    if v_email is not null then
      select id into v_member from members where email = v_email;
    end if;
    if v_member is null and v_nid is not null then
      select id into v_member from members where ucf_nid = v_nid;
    end if;
    if v_member is null and v_name is not null then
      select id into v_member
      from members
      where archived_at is null
        and merged_into_id is null
        and (fn_normalise_name(display_name) = v_name
             or fn_normalise_name(first_name || ' ' || last_name) = v_name)
      order by created_at, id
      limit 1;
    end if;
  end if;

  for i in 1..10 loop
    exit when v_member is null;
    select merged_into_id into v_next from members where id = v_member;
    exit when v_next is null;
    v_member := v_next;
  end loop;

  if v_member is not null and exists (
    select 1 from members where id = v_member and archived_at is not null
  ) then
    raise exception 'That member is archived.' using errcode = 'PDS03';
  end if;

  if v_member is null then
    insert into members (first_name, last_name, email, ucf_nid)
    values (v_first, v_last, v_email, v_nid)
    returning id into v_member;
    v_created := true;
  end if;

  insert into member_enrollments (member_id, academic_year_id)
  values (v_member, p_academic_year_id)
  on conflict (member_id, academic_year_id) do nothing;
  get diagnostics v_rows = row_count;
  v_enrolled := v_rows > 0;

  perform fn_audit(
    'upsert_member_and_enroll',
    'member',
    v_member,
    jsonb_build_object('academic_year_id', p_academic_year_id,
                       'was_created', v_created,
                       'was_enrolled', v_enrolled)
  );

  return jsonb_build_object('member_id', v_member,
                            'was_created', v_created,
                            'was_enrolled', v_enrolled);
end
$$;

comment on function upsert_member_and_enroll(text, text, citext, citext, uuid, uuid) is
  'Officer only. Atomically finds or creates a member and enrolls them. No-email name resolution is serialized by normalized name so concurrent imports converge on one row.';
