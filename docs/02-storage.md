# Photo storage: the decision and the arithmetic

The brief asked for a deliberate decision here rather than Supabase's default. Here it
is, with the numbers it rests on.

## Sizing, from the real data

Of 4,811 attendance marks in 2025-26, the ones that would plausibly carry a photo are
shirt-photo categories (GBMs 1,273 · Socials 644) and receipt categories
(Partial Proceeds 502). Call it **~2,400 photos/year**, and round up to 3,000 for
growth.

| | Per photo | Per year | Fills Supabase free tier (1 GB) in |
|---|---|---|---|
| Raw phone photo | ~3.5 MB | ~10.5 GB | 3 weeks |
| Client-compressed (1280px, JPEG q0.7) | ~150-250 KB | **0.45-0.75 GB** | ~1.5 years |

So: **client-side compression is not an optimization, it's the difference between
working and not working**. Even with it, Supabase Storage alone busts the free
tier inside two years. That settles the question of whether an archival path is needed.

## Decision

**Stay on Supabase Storage. Clear photos by hand at 12 months. Google Drive archival is
designed but not built.**

1. **Upload path:** browser compresses → requests a one-shot signed upload URL via
   `create_evidence_upload()` → PUTs straight to a private Supabase Storage bucket.
   No secret in client JS, no proxy in the hot path.
2. **Retention: 12 months, cleared by hand.** Photos older than the window become
   *eligible* to purge; an officer or director then clears them from a screen in the
   admin UI. **Nothing deletes itself on a timer.** The attendance record is permanent;
   the photo is not. Less student photography held forever is a feature, not a
   compromise.
3. **Google Drive is deferred, not discarded.** `attendance_evidence.provider` and
   `drive_file_id` stay in the schema from day one, so adding the archival path later is
   an Edge Function plus a backfill, with no migration of existing rows and no reader
   changes.

### The headroom, stated plainly

Hand-clearing at 12 months holds the working set to roughly one year of photos, which is
**0.45-0.75 GB against a 1 GB free tier**. That works, but the margin is thin at the top
of the range: a year where more event types require photos, or a bigger cohort, puts you
against the cap.

So the deferral needs a tripwire rather than optimism. Two exist:

- The storage screen warns at **75% of the tier**, and keeps warning.
- If clearing at 12 months stops being enough to get back under it, that is the signal to
  build the Drive path (or shorten the retention window, which is a dropdown).

Neither is a silent failure. The failure mode of a full bucket is upload errors at an
event, which is exactly the moment you cannot afford them, so this is worth watching
rather than assuming.

### Why the purge is a button, not a cron job

A scheduled deletion is the one background job whose failure mode is silent and
unrecoverable. It runs at 3am, an edge case in the eligibility query is slightly
wrong, and evidence for a live dispute is gone with nobody in the room. Making it an
explicit action means a person sees the count and the affected events before anything
is destroyed, and the run is attributed in `purge_runs`.

The trade-off is that a button nobody presses lets storage fill up. That's handled by
surfacing it rather than automating it: once eligible photos pass a threshold, or
storage passes 75%, the dashboard says so until someone acts. Reminder, not autopilot.

Eligibility is deliberately narrow. A photo can only be purged when it is:

- attached to a record that has been **reviewed** (`approved` or `rejected`, never
  `pending`), and
- attached to an event whose date is older than the retention window.

So an unreviewed submission can never be purged out from under the queue, no matter how
old it gets.

## If and when Drive gets built

The rest of this document is the design for that path, kept because the tripwire above
may well fire and because two of its constraints are easy to get wrong under time
pressure.

## Why not upload straight to Drive

The brief already identified that a static frontend can't hold a long-lived Drive
credential. Agreed, but the alternative of proxying *every* upload through an Edge
Function is also wrong, for an operational reason: 60 people scan a QR code in the same
90 seconds on venue wifi. That's exactly when you want the shortest, most retryable
path to a CDN-backed object store, not a cold-starting function holding an OAuth token.
Archival is the right place for the proxy, because it's asynchronous and a retry costs
nothing.

## The Shared Drive gotcha (worth catching now)

A Google service account has **no storage quota of its own**. Files it creates in a
"My Drive" context are owned by the service account and do not draw on the secretary's
100 GB, a well-known trap that surfaces as mysterious quota errors months later.

The correct setup is a **Shared Drive** (owned by the PDSA Workspace org, not a
person), with the service account added as Content Manager. That also satisfies the
brief's org-owned-not-personal rule by construction: a Shared Drive survives the
secretary graduating, a personal My Drive folder does not.

## Compression spec

- Longest edge 1280px, JPEG quality 0.7, EXIF stripped except orientation.
- Done via `createImageBitmap` + `OffscreenCanvas`, with a `<canvas>` fallback.
- Hard client-side reject above ~8 MB pre-compression, with a clear message.
- Store `byte_size` and `sha256` post-compression; the hash cheaply catches one photo
  submitted against two events.

## Consequences for the schema

None beyond what's already in [01-data-model.md](01-data-model.md): `provider`,
`object_path`, `drive_file_id`, `archived_at`, `purged_at` on `attendance_evidence`
were put there for exactly this. Storage location is a row value; no reader hardcodes
a backend.
