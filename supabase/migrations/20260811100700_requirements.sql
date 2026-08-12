-- ===========================================================================
-- 07. THE REQUIREMENTS ENGINE (storage)
-- ===========================================================================
-- Two node types cover every rule the 2025-2026 spreadsheet actually
-- implemented, and every extension the brief anticipates.
--
--   threshold  SUM(credit) over one or more categories >= min_value
--   group      passes when at least min_children_passing children pass
--              (null means every child must pass)
--
-- "All 10 categories" becoming "any 8 of 10" is one integer update, not a
-- deploy. The evaluator lives in migration 09.
-- ===========================================================================

create type node_type_t as enum ('group', 'threshold');

create table requirement_sets (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years on delete cascade,
  name             text not null default 'Honorary Member',
  version          int  not null default 1,
  status           text not null default 'draft',
  root_node_id     uuid,                       -- FK added below, the reference is circular
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (academic_year_id, name, version),
  check (status in ('draft', 'published', 'archived'))
);

create table requirement_nodes (
  id                   uuid primary key default gen_random_uuid(),
  requirement_set_id   uuid not null references requirement_sets on delete cascade,
  parent_id            uuid references requirement_nodes on delete cascade,
  type                 node_type_t not null,
  label                text not null,
  sort_order           int not null default 0,

  -- group nodes
  min_children_passing int,

  -- threshold nodes
  min_value            numeric(6,2),
  term_id              uuid references terms on delete restrict,

  check ((type = 'threshold' and min_value is not null and min_children_passing is null)
      or (type = 'group'     and min_value is null)),
  check (min_children_passing is null or min_children_passing >= 0)
);

alter table requirement_sets
  add constraint requirement_sets_root_node_fkey
  foreign key (root_node_id) references requirement_nodes (id) on delete set null;

create index requirement_nodes_set    on requirement_nodes (requirement_set_id);
create index requirement_nodes_parent on requirement_nodes (parent_id);

create table requirement_node_categories (
  node_id     uuid not null references requirement_nodes on delete cascade,
  category_id uuid not null references categories        on delete restrict,
  primary key (node_id, category_id)
);

create index requirement_node_categories_category on requirement_node_categories (category_id);

-- A published set is the record of what people were judged against. Editing
-- one creates version + 1 instead. Migration 11 enforces this in RLS: an
-- officer cannot write a published set at all, and only an admin can.
create unique index one_published_set_per_year_name
  on requirement_sets (academic_year_id, name) where status = 'published';

comment on table requirement_nodes is
  'The rule tree. A multi-category threshold (Speaking = Journal Club + Media Speaking >= 1) is the same node type as a single-category one.';
comment on column requirement_nodes.term_id is
  'Optional. When set, only credit from events dated inside that terms range counts toward this threshold.';
comment on column requirement_nodes.min_children_passing is
  'Group nodes only. Null means every child must pass. Setting the root to 8 turns "all 10" into "any 8 of 10".';
