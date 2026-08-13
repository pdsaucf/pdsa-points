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
-- one creates version + 1 instead. Migration 11 enforces this in RLS: nobody
-- writes the nodes of a set that is no longer a draft, and publishing goes
-- through publish_requirement_set() in migration 10.
--
-- One published set per YEAR, not per year and name. fn_published_requirement_set()
-- takes a year and returns one id, and v_member_status judges every member by
-- whatever it returns, so a year holding two published sets has no meaning:
-- one of them silently decides who is honorary. publish_requirement_set()
-- archives the outgoing set in the same transaction, and this index is what
-- makes that the only reachable state rather than merely the intended one.
create unique index one_published_set_per_year
  on requirement_sets (academic_year_id) where status = 'published';

-- ---------------------------------------------------------------------------
-- The tree has to actually be a tree
-- ---------------------------------------------------------------------------
-- parent_id references this same table, and nothing above stops a node from
-- becoming its own ancestor. An officer dragging rows around in the editor is
-- one UPDATE away from it, and RLS lets them make that update on a draft.
--
-- What a cycle does today, measured rather than assumed:
--
--   * It does not hang the evaluator. Its recursive CTE descends from nodes
--     with a null parent, and a node inside a cycle always has a parent inside
--     the cycle, so a cycle is never reachable from the anchor. The walk
--     terminates.
--   * It silently produces the wrong answer, which is worse. Nodes pulled into
--     a cycle vanish from their group's child count, so a rule everybody was
--     failing quietly stops being counted. If the ROOT joins a cycle the set
--     has no null-parent node at all, the evaluator returns zero rows, and
--     v_member_status reports is_honorary = false for the entire club with no
--     error anywhere.
--
-- validate_requirement_set() reports cycles, but validation runs when somebody
-- asks. This trigger is the part that cannot be skipped.
--
-- It also enforces that a parent and its children live in the same set. That
-- is not tidiness: fn_member_requirement_status counts a group's children, and
-- a node in ANOTHER set pointing at this set's group inflates that count. A
-- draft with a stray parent link can therefore change who qualifies under the
-- PUBLISHED set, which is exactly the leak a clone must never spring.
--
-- AFTER, not BEFORE, so a statement that inserts a whole tree at once sees
-- every row of it. Row triggers of an AFTER trigger fire once the statement
-- has finished, so parents inserted alongside their children are already
-- there.
-- ---------------------------------------------------------------------------

create or replace function fn_requirement_node_tree_guard()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_parent_set uuid;
  v_loops      boolean;
  v_depth      int;
begin
  if new.parent_id = new.id then
    raise exception 'A requirement cannot sit inside itself.' using errcode = 'PDS11';
  end if;

  if new.parent_id is not null then
    select n.requirement_set_id into v_parent_set
    from requirement_nodes n
    where n.id = new.parent_id;

    -- A missing parent is the foreign key's business, not ours.
    if v_parent_set is not null and v_parent_set <> new.requirement_set_id then
      raise exception 'A requirement must sit in the same ruleset as the group above it.'
        using errcode = 'PDS11';
    end if;
  end if;

  if exists (
    select 1 from requirement_nodes k
    where k.parent_id = new.id
      and k.requirement_set_id <> new.requirement_set_id
  ) then
    raise exception 'A requirement must sit in the same ruleset as everything under it.'
      using errcode = 'PDS11';
  end if;

  -- Walk up. The cap is what makes this terminate on a cycle that does not
  -- pass through this row, and 64 levels of nested groups is far past anything
  -- an officer could mean.
  with recursive up as (
    select n.id, n.parent_id, 1 as depth
    from requirement_nodes n
    where n.id = new.id
    union all
    select p.id, p.parent_id, up.depth + 1
    from requirement_nodes p
    join up on p.id = up.parent_id
    where up.depth < 64
  )
  select bool_or(up.id = new.id and up.depth > 1), max(up.depth)
    into v_loops, v_depth
  from up;

  if coalesce(v_loops, false) then
    raise exception 'That would put a requirement inside itself.' using errcode = 'PDS11';
  end if;

  if coalesce(v_depth, 0) >= 64 then
    raise exception 'Requirements cannot nest more than 64 groups deep.'
      using errcode = 'PDS11';
  end if;

  return null;
end
$$;

create trigger requirement_nodes_tree_guard_insert
  after insert on requirement_nodes
  for each row execute function fn_requirement_node_tree_guard();

create trigger requirement_nodes_tree_guard_update
  after update on requirement_nodes
  for each row
  when (new.id                 is distinct from old.id
     or new.parent_id          is distinct from old.parent_id
     or new.requirement_set_id is distinct from old.requirement_set_id)
  execute function fn_requirement_node_tree_guard();

comment on function fn_requirement_node_tree_guard() is
  'Keeps requirement_nodes a forest of trees inside one ruleset: no node is its own ancestor, and a parent and its children always belong to the same set.';

comment on table requirement_nodes is
  'The rule tree. A multi-category threshold (Speaking = Journal Club + Media Speaking >= 1) is the same node type as a single-category one.';
comment on column requirement_nodes.term_id is
  'Optional. When set, only credit from events dated inside that terms range counts toward this threshold.';
comment on column requirement_nodes.min_children_passing is
  'Group nodes only. Null means every child must pass. Setting the root to 8 turns "all 10" into "any 8 of 10".';
