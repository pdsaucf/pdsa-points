-- ===========================================================================
-- 04. CATEGORIES
-- ===========================================================================
-- `slug` is the identity and is never reused. `name` is a label an officer can
-- rename freely without rewriting anything.
--
-- Categories archive, they never delete. Every reference to categories is
-- `on delete restrict`, which is what makes the spreadsheets #REF! failure
-- mode unrepresentable here.
-- ===========================================================================

create type unit_type as enum ('event_count', 'hours', 'points');

create table categories (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique,
  name                      text not null,
  unit                      unit_type not null default 'event_count',
  unit_label                text,               -- 'hour', so the UI can say "25 hours"
  counts_toward_point_total boolean not null default true,
  sort_order                int not null default 0,
  created_at                timestamptz not null default now(),
  archived_at               timestamptz,
  check (length(btrim(slug)) > 0),
  check (slug = lower(slug))
);

create index categories_active on categories (sort_order) where archived_at is null;

comment on column categories.counts_toward_point_total is
  'Whether this categorys credit is added into v_member_status.point_total. False for Volunteering, whose hours are a requirement but not a point.';
comment on column categories.unit is
  'What the number means. It changes labelling, never arithmetic: every category sums credit the same way.';
