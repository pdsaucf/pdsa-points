-- ===========================================================================
-- 13. CONFIGURATION SEED FOR 2026-2027
-- ===========================================================================
-- This is configuration, not data. It contains no people, no events and no
-- attendance. The system starts empty of members: load a roster with
-- scripts/import_roster.py before the first event.
--
-- Everything here is editable from the admin UI once it exists, and editable
-- with plain SQL until then. Nothing in the application code knows any of
-- these names, units or numbers.
--
-- The UUIDs are fixed rather than generated so this file is idempotent and so
-- the rows are easy to refer to from a console. They carry no meaning.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- >>> OFFICERS: CHECK THESE TWO DATES AND THE FOUR TERM DATES BELOW <<<
--
-- These are placeholders based on a typical UCF calendar. If your year runs
-- differently, correct them here before applying, or update the rows
-- afterwards. Term dates matter if you ever write a per-semester rule; the
-- year dates are what the UI uses to label things.
-- ---------------------------------------------------------------------------
--   academic year 2026-2027 : 2026-08-17  ..  2027-05-07
--   Fall 2026               : 2026-08-17  ..  2026-12-11
--   Spring 2027             : 2027-01-11  ..  2027-05-07
-- ---------------------------------------------------------------------------

insert into academic_years (id, label, starts_on, ends_on, is_current) values
  ('a0000000-0000-4000-a000-000000000001', '2026-2027', date '2026-08-17', date '2027-05-07', true)
on conflict (label) do nothing;

insert into terms (id, academic_year_id, label, starts_on, ends_on, sort_order) values
  ('b0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000001',
   'Fall 2026',   date '2026-08-17', date '2026-12-11', 1),
  ('b0000000-0000-4000-a000-000000000002', 'a0000000-0000-4000-a000-000000000001',
   'Spring 2027', date '2027-01-11', date '2027-05-07', 2)
on conflict (academic_year_id, label) do nothing;


-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
-- Thirteen, not twelve. The brief and docs/00-spreadsheet-findings.md both say
-- "12 categories in active use", but the workbook needs thirteen to represent:
-- nine non-editorial categories (GBMs, Volunteering, Clinical Workshops,
-- Non-Clinical Workshops, Socials, Dental School Visits, Fundraising, Partial
-- Proceeds, Tabling) plus the four editorial ones that the compound Speaking
-- and Writing rules are built from (Journal Club, PDSA Post, Media Speaking,
-- Media Writing). Nine plus four is thirteen. The Total tab likewise carries
-- thirteen category columns.
--
-- Volunteering is the only category measured in hours, and the only one that
-- does not count toward the point total. That combination is what reproduced
-- the old Total column exactly: hours are required for Honorary but are not a
-- point. Note that these are two independent flags, not one rule about units.
-- ---------------------------------------------------------------------------

insert into categories (id, slug, name, unit, unit_label, counts_toward_point_total, sort_order) values
  ('c0000000-0000-4000-a000-000000000001', 'gbms',                   'GBMs',                   'event_count', null,   true,  10),
  ('c0000000-0000-4000-a000-000000000002', 'volunteering',           'Volunteering',           'hours',       'hour', false, 20),
  ('c0000000-0000-4000-a000-000000000003', 'clinical-workshops',     'Clinical Workshops',     'event_count', null,   true,  30),
  ('c0000000-0000-4000-a000-000000000004', 'non-clinical-workshops', 'Non-Clinical Workshops', 'event_count', null,   true,  40),
  ('c0000000-0000-4000-a000-000000000005', 'socials',                'Socials',                'event_count', null,   true,  50),
  ('c0000000-0000-4000-a000-000000000006', 'dental-school-visits',   'Dental School Visits',   'event_count', null,   true,  60),
  ('c0000000-0000-4000-a000-000000000007', 'fundraising',            'Fundraising',            'event_count', null,   true,  70),
  ('c0000000-0000-4000-a000-000000000008', 'partial-proceeds',       'Partial Proceeds',       'event_count', null,   true,  80),
  ('c0000000-0000-4000-a000-000000000009', 'tabling',                'Tabling',                'event_count', null,   true,  90),
  ('c0000000-0000-4000-a000-00000000000a', 'journal-club',           'Journal Club',           'event_count', null,   true, 100),
  ('c0000000-0000-4000-a000-00000000000b', 'pdsa-post',              'PDSA Post',              'event_count', null,   true, 110),
  ('c0000000-0000-4000-a000-00000000000c', 'media-speaking',         'Media Speaking',         'event_count', null,   true, 120),
  ('c0000000-0000-4000-a000-00000000000d', 'media-writing',          'Media Writing',          'event_count', null,   true, 130)
on conflict (slug) do nothing;


-- ---------------------------------------------------------------------------
-- The 2026-2027 requirement set
-- ---------------------------------------------------------------------------
-- >>> OFFICERS: THESE THRESHOLDS ARE CARRIED OVER FROM 2025-2026. <<<
--
-- They are last year's numbers, seeded so the system is usable on day one.
-- They are expected to be reviewed and edited before the first event of the
-- year. Editing them is a data change, not a deploy: change min_value on a
-- node, or min_children_passing on the root, and every member's status
-- recomputes on the next read.
--
--   group  "Honorary Member"                (all children must pass)
--   |- threshold "GBMs"                     [GBMs]                          >= 9
--   |- threshold "Volunteering"             [Volunteering]                  >= 25 hours
--   |- threshold "Clinical Workshops"       [Clinical Workshops]            >= 5
--   |- threshold "Non-Clinical Workshops"   [Non-Clinical Workshops]        >= 5
--   |- threshold "Socials"                  [Socials]                       >= 6
--   |- threshold "Dental School Visits"     [Dental School Visits]          >= 5
--   |- threshold "Fundraising"              [Fundraising]                   >= 5
--   |- threshold "Partial Proceeds"         [Partial Proceeds]              >= 5
--   |- threshold "Tabling"                  [Tabling]                       >= 2
--   \- group     "Editorial Points"         (all children must pass)
--      |- threshold "Speaking"              [Journal Club, Media Speaking]  >= 1
--      \- threshold "Writing"               [PDSA Post, Media Writing]      >= 1
--
-- Speaking and Writing are the compound editorial rule. They are the same
-- node type as every other threshold; the only difference is that they
-- measure two categories instead of one.
-- ---------------------------------------------------------------------------

insert into requirement_sets (id, academic_year_id, name, version, status, published_at) values
  ('d0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000001',
   'Honorary Member', 1, 'published', now())
on conflict (academic_year_id, name, version) do nothing;

insert into requirement_nodes
  (id, requirement_set_id, parent_id, type, label, sort_order, min_children_passing, min_value)
values
  -- root
  ('e0000000-0000-4000-a000-000000000000', 'd0000000-0000-4000-a000-000000000001', null,
   'group', 'Honorary Member', 0, null, null),

  ('e0000000-0000-4000-a000-000000000001', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'GBMs',                   10, null,  9),
  ('e0000000-0000-4000-a000-000000000002', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Volunteering',           20, null, 25),
  ('e0000000-0000-4000-a000-000000000003', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Clinical Workshops',     30, null,  5),
  ('e0000000-0000-4000-a000-000000000004', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Non-Clinical Workshops', 40, null,  5),
  ('e0000000-0000-4000-a000-000000000005', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Socials',                50, null,  6),
  ('e0000000-0000-4000-a000-000000000006', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Dental School Visits',   60, null,  5),
  ('e0000000-0000-4000-a000-000000000007', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Fundraising',            70, null,  5),
  ('e0000000-0000-4000-a000-000000000008', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Partial Proceeds',       80, null,  5),
  ('e0000000-0000-4000-a000-000000000009', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'threshold', 'Tabling',                90, null,  2),

  ('e0000000-0000-4000-a000-00000000000a', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-000000000000', 'group',     'Editorial Points',      100, null, null),
  ('e0000000-0000-4000-a000-00000000000b', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-00000000000a', 'threshold', 'Speaking',              110, null,  1),
  ('e0000000-0000-4000-a000-00000000000c', 'd0000000-0000-4000-a000-000000000001',
   'e0000000-0000-4000-a000-00000000000a', 'threshold', 'Writing',               120, null,  1)
on conflict (id) do nothing;

update requirement_sets
set root_node_id = 'e0000000-0000-4000-a000-000000000000'
where id = 'd0000000-0000-4000-a000-000000000001'
  and root_node_id is null;

insert into requirement_node_categories (node_id, category_id) values
  ('e0000000-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001'), -- GBMs
  ('e0000000-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000002'), -- Volunteering
  ('e0000000-0000-4000-a000-000000000003', 'c0000000-0000-4000-a000-000000000003'), -- Clinical Workshops
  ('e0000000-0000-4000-a000-000000000004', 'c0000000-0000-4000-a000-000000000004'), -- Non-Clinical Workshops
  ('e0000000-0000-4000-a000-000000000005', 'c0000000-0000-4000-a000-000000000005'), -- Socials
  ('e0000000-0000-4000-a000-000000000006', 'c0000000-0000-4000-a000-000000000006'), -- Dental School Visits
  ('e0000000-0000-4000-a000-000000000007', 'c0000000-0000-4000-a000-000000000007'), -- Fundraising
  ('e0000000-0000-4000-a000-000000000008', 'c0000000-0000-4000-a000-000000000008'), -- Partial Proceeds
  ('e0000000-0000-4000-a000-000000000009', 'c0000000-0000-4000-a000-000000000009'), -- Tabling
  -- Speaking measures two categories at once
  ('e0000000-0000-4000-a000-00000000000b', 'c0000000-0000-4000-a000-00000000000a'), -- Journal Club
  ('e0000000-0000-4000-a000-00000000000b', 'c0000000-0000-4000-a000-00000000000c'), -- Media Speaking
  -- and so does Writing
  ('e0000000-0000-4000-a000-00000000000c', 'c0000000-0000-4000-a000-00000000000b'), -- PDSA Post
  ('e0000000-0000-4000-a000-00000000000c', 'c0000000-0000-4000-a000-00000000000d')  -- Media Writing
on conflict do nothing;
