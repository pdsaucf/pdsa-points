# Events page

Public route `/events`, on the same static site. It replaces the live Notion page that
today shows only the "Visible Events" database, and the manual step where officers add
to a Queued database and the secretary pastes rows across.

Members open it and read what is coming up. There is no name to type, no lookup, and no
personalization: `/me` already answers "what did I attend", and this page answers "what
is happening". Eight facts per event, and nothing else:

```
Date · Time · Location · Attire · Sign-ups · Points · Title · Description
```

## What has to be added

Three of those eight facts have nowhere to live today.

`events.location` was dropped in migration 25, on the stated grounds that the club does
not use it. The club uses it. It comes back as `text`.

`attire` and `signup` are new `text` columns. `signup` holds whatever the Notion column
holds now: a form URL, a line like `Sign up at GBM`, or nothing. A value parsing as an
`http(s)` URL renders as a `Sign up` button, anything else renders as text, and null
renders as nothing at all.

`description` is a new `text` column and is member-facing. `events.notes` is not reused.
`notes` is officer-side, RLS-protected, and a public page reading it would leak an
internal note the first time somebody typed one there.

Points come from `event_categories` and are not a new column. The page shows the sum of
`fixed_credit` across the event's categories, with each category named. An event whose
category is `credit_mode = 'from_submission'` shows `Varies` for that category, because
the member types the number at check-in and no fixed figure exists to promise.

## Queued and visible

Two things make an event visible, and they are independent.

**Manual.** `events.is_published` becomes the officer's publish flag. Its default flips
from `true` to `false`, so a new event is queued. Existing rows are backfilled to `true`
by the migration, which keeps `/me` showing exactly what it shows today. Any officer can
publish, not only the secretary.

**The Monday drop.** Every Monday at 8:00 AM America/New_York, queued events dated within
the next 14 days become visible. Sign-ups are limited, so events dropping at the same
hour every week is a fairness rule, not a convenience. It is one global toggle in
`app_settings`, not a per-event checkbox: an event cannot be exempted from the drop,
because an exemptible fairness rule is not one.

### The drop is computed, not scheduled

No cron job flips anything. A pure function returns the instant an event becomes
visible, and the read compares it to `now()`:

```
fn_event_release_at(occurred_on, created_at) =
  max(
    first Monday 08:00 America/New_York on or after (occurred_on - 14 days),
    first Monday 08:00 America/New_York strictly after created_at
  )
```

The second term is what stops an event created today for a date three months out from
appearing instantly, and what stops a backdated event from being released retroactively.

```
fn_event_is_visible(e) =
  e.is_published
  or (auto_publish_enabled and now() >= fn_event_release_at(e.occurred_on, e.created_at))
```

Three reasons this is a function and not a job. `pg_cron` is not enabled on this project.
A GitHub Actions cron, which is the pattern `keepalive.yml` already uses, fires 10 to 60
minutes late on the free tier and skips silently when it fails, so the one property the
rule exists for (everything drops at the same time) is the property it would not have.
And a computed release cannot drift: 8:00:00 means 8:00:00, including the week the
Supabase project is paused.

Turning the toggle off stops the drop for every queued event at once, immediately, with
no stored per-event state to reinterpret.

### Events the drop will miss

An event created after a Monday drop, and dated before the next one, has a release
instant later than its own date. It is not published automatically and it is not
published silently. The admin list marks it:

```
Not visible
Sep 12 Give Kids A Smile · Publishes after the event
[ Publish ]
```

## Admin

The event form gains Location, Attire, Sign-up and Description, and a Publish control.
The list distinguishes the two states without reading a label: a queued event's card has
a dashed border, a visible event's card has a solid one. Queued cards also carry the
release instant, so an officer knows when it goes out.

```
Publishes Mon Sep 7, 8:00 AM
```

The auto-publish toggle is one row in the Events panel, above the list, not on the event
form. There is no Settings screen in this admin, and the toggle belongs beside the list it
governs.

## Reads

Invariant 3 holds: `/events` touches no table. One new `SECURITY DEFINER` function,
`portal_events()`, returns published events of the current academic year dated today or
later, ascending, each with the eight facts and its categories. It returns no member, no
attendance, no note, no token, and no unpublished event.

`portal_attendance()` widens further than a straight switch from `is_published` to
`fn_event_is_visible()`: a member's own attendance on an event that has already happened
is visible even when the event itself was never published or auto-released, because the
credit views (`v_attendance_credit`, `v_member_category_totals`, `v_member_status`) never
gated on publish state, so the points were already counting toward that member's total
either way. That exception is bounded to events whose date has passed: `portal_attendance()`
is callable anonymously by member id, and an unbounded exception would leak next week's
queued event to anyone who happens to know who checked into it, ahead of the Monday drop.
A future, unannounced event a member has already checked into stays hidden, from
everyone, until it happens.

The check-in path is a separate decision and does not read `is_published` at all, in any
form. `fn_checkin_event()` resolves a check-in purely by token: the check-in token is 64
bits of secret printed on the QR code at the venue, `checkin_opens_at` and
`checkin_closes_at` are what bound when it works, and `is_published` never actually gated
anything, because the admin form has never written it and every event that has ever
existed carried it `true`. So a queued or unpublished event's QR code works exactly the
way a published one's does; the worst case is a pending attendance row an officer still
has to approve, which invariant 6 already requires regardless of publish state.

Two things that follow from the token being the gate, worth being explicit about.
Unpublishing an event, or simply never publishing it, deliberately does not rotate its
`checkin_token`: the token is a fact about the event, not about its announcement state,
and rotating it on every publish toggle would break a QR code already printed and taped
to a wall for no security benefit. Cancelling an event outright, so that a token which
already exists should stop working entirely, is a separate concern nobody has asked for
yet.

## How members find this page, and what that is not

Nothing links here. The main club website links to `/me`, so the member portal is open to
anyone who follows it, and this page is meant for members, so its address goes out in the
weekly email instead. The `Events` link that briefly sat beside the emblem on `/me` was
removed for that reason: it would have handed this address to every visitor the main site
sends.

**Said plainly, because the distinction matters: this makes the page unlisted, not
member-only.** `portal_events()` is granted to `anon`, the page carries no login, and
anybody who has the address, or who is forwarded the weekly email, can open it and keep
opening it. Nothing here checks who is asking. That is the same decision `/me` already
makes, and it is the right one while what the page carries is announcements the club is
about to make anyway. It stops being the right one the moment this page carries something
the club would not put on a poster.

The page does carry `noindex`, so it stays out of search results, which is what keeps
"unlisted" meaningful rather than decorative.

Making it genuinely member-only is a different feature and a large one: there are no
member accounts and no email addresses on file (invariant 8), so it would mean either a
shared passphrase, per-member links the club has to distribute and rotate, or building
accounts. None of that is worth doing for an upcoming-events list, and it should not be
started without deciding what threat it is for.
