# What the real spreadsheet actually says

Everything below was derived from `Member Points 2025-2026.xlsx` and **verified against
all 355 member rows**. These are measured facts, not assumptions. They set the
requirements the new schema has to satisfy exactly.

## Scale (this is a small dataset)

| Thing | Count |
|---|---|
| Members on the roster | 355 |
| Members currently Honorary | 45 (12.7%) |
| Distinct event instances (all categories) | 134 |
| Attendance marks for the year | 4,811 |
| Categories in active use | 13 (+ 1 dead tab) |

4,811 rows/year is nothing for Postgres. **Nothing here is a performance problem**.
Correctness, auditability and admin ergonomics are the entire game.

(Thirteen, not twelve: nine non-editorial categories plus the four editorial ones
the Speaking and Writing thresholds are built from. The `Total` tab carries thirteen
category columns. An earlier draft of this document said twelve, which was a
miscount on my part.)

## The workbook is a rollup, not a system

Every category tab is an `IMPORTRANGE(...)` from a *separate* Google Sheet. So there
are ~13 independent spreadsheets, each fed by its own Form, stitched together by
formula. That's the root cause of the drift described in the brief: there is no single
place where an event is defined once.

## Verified rules (0 mismatches across 355 members)

Per-category thresholds, confirmed by recomputing every cell:

| Category | Unit | Threshold | Members passing |
|---|---|---|---|
| GBMs | events | ≥ 9 | 63 |
| Volunteering | **hours** | ≥ 25 | 66 |
| Clinical Workshops | events | ≥ 5 | 56 |
| Non-Clinical Workshops | events | ≥ 5 | 56 |
| Socials | events | ≥ 6 | 61 |
| Dental School Visits | events | ≥ 5 | 65 |
| Fundraising | events | ≥ 5 | 61 |
| Partial Proceeds | events | ≥ 5 | 64 |
| Tabling | events | ≥ 2 | 58 |
| Editorial → Speaking | events | ≥ 1 | 74 |
| Editorial → Writing | events | ≥ 1 | 76 |

And three structural rules, each verified with zero mismatches:

1. **Speaking** = `Journal Club + Media Speaking ≥ 1`, a threshold over a *set* of
   categories, not one category.
2. **Writing** = `PDSA Post + Media Writing ≥ 1`, the same shape.
3. **Honorary** = all 11 requirements pass (a plain AND, but see the engine design;
   this is modelled as "N of N", so "any 8 of 10" is a data change).
4. **Total points** = sum of all category counts **excluding Volunteering hours**.
   (Abigail Catto: 45 points, with 29.5 volunteering hours not included.) So
   "counts toward the point total" is a per-category flag, not a rule about units.

## Evidence for many-to-many events

**"Soap Carving"** appears in both `Clinical Workshops` and `Socials`, with **69
attendees in each and a 69/69 overlap**. It is one real event, hand-copied into two
tabs. This is the concrete case for `event_categories` being a join table rather than
a `category_id` column on the event.

## Observed drift (what the new system must make impossible)

- `President Workshops`: a hidden tab whose entire content is `#REF!`. A category was
  deleted out from under a live formula.
- `PDSA Post`: its 11 event columns are still named `Fall GBM 2 … Spring GBM 6`,
  copy-pasted from the GBMs tab and never renamed. The data underneath is real
  (6 people credited on "Fall GBM 2", only 5 of whom attended that GBM), so the labels
  are simply wrong, and nothing says so.
- The `Total` tab labels editorial columns `Podcast Guest` / `Podcast Script`, but
  those columns are fed by tabs named `Media Speaking` / `Media Writing`, and
  `Media Speaking` actually contains an **Instagram** credit. Three names for one
  concept, none authoritative.
- `Volunteering` has **no per-event columns at all**, just a typed-in hours total per
  member (110 members with hours, values as fine as 0.5, max 250). There is no record
  of *what* anyone volunteered at. Hours have no provenance today.

## Roster hygiene is currently fine

All 14 tabs carry exactly the same 355 names with zero exact duplicates and zero
case/whitespace variants, because they're all `IMPORTRANGE`d from one master list.
That's the one thing the current setup gets right, and the new roster + autocomplete
must preserve it (member selection by ID, never free text).
