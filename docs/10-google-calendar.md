# The Member Calendar

Every event that goes live on `/events` is posted to the club's public Google Calendar,
kept in step when an officer edits it, and taken off when it is unpublished or deleted.
The secretary team no longer copies events across by hand. Migration 31
(`20260930110000_google_calendar.sql`), the `sync-calendar` Edge Function, and
Settings, Connections.

## Built to be handed over

Each board makes a new calendar for its year, with whatever level of comfort with
Google Cloud it happens to have. So:

- **Which calendar is a setting** (`google_calendar_id` in `app_settings`), changed on
  Settings, Connections by pasting a Calendar ID. No deploy, no secret, no terminal.
- **The service account is set up once** and outlives every board: its key is the one
  server secret, and its address is shown on the Connections page to share calendars
  with.
- **The steps are on the screen**, not only in this file: connecting a calendar,
  switching to next year's, what gets posted, and the one-time server setup.
- **The page says whether it is working**: Connected, Off, Switching, Problem (with the
  reason, such as a calendar not shared with the service account), or Not running when
  no run has reported in 20 minutes.

## What gets posted, and when

An event is posted when it is live on `/events` (published by hand, or the Monday
drop), for the current academic year, dated today or later. The calendar event carries
the title (with `(Members only)` for paid-member events), the time (all day when the
event has none), location, description, attire, and a link to the event on `/events`
(`#event-<id>`), labelled `Sign up` when the form is on.

Edits reach the calendar within five minutes; any saved change bumps `config_version`,
which is what the sync compares. Unpublishing takes it off. Deleting takes it off
through `calendar_removals`, written by a trigger because the event row is gone.
Events already in the past are never touched.

Switching calendars moves upcoming events to the new one and leaves past events on the
old one as that year's record. Turning posting off stops posting and leaves what is
already on the calendar.

Do not edit these events in Google Calendar: the next change on the site overwrites
them.

## How the sync works

`calendar_sync_plan()` (service_role) computes, every run, what should change: live
events not yet on the chosen calendar or changed since (`calendar_posted_to`,
`calendar_synced_version`), and events on a calendar that are no longer live or were
deleted. Nothing is queued, so a run that dies halfway is finished by the next one.
Google event ids are derived from the event id (`pdsa` plus the uuid without dashes,
which is valid base32hex), so posting twice updates rather than duplicates, and a
previously deleted id is revived by the update.

Removals owed are rows in `calendar_removals`, one per event and calendar, kept until
Google confirms them: a deleted event, or the old calendar after a switch (written by
`calendar_sync_posted()` when the new post is acknowledged). Before each write the sync
records an intent in `calendar_pending`; an intent never acknowledged (the run died
after Google accepted) becomes a removal owed after ten minutes, or at once if the event
is deleted, and a live event is simply posted again.

The function signs in to Google as the service account (a JWT signed with Web Crypto,
no library), checks it can see the calendar, does the deletes and then the upserts, and
reports to `calendar_status`: ok, the service account address, calendar name, counts,
the first error.

## Server setup, once

1. Google Cloud Console: a project, the Google Calendar API enabled, a service account
   (no roles), and a JSON key for it.
2. Secret and deploy:

   ```bash
   supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat key.json)"
   supabase functions deploy sync-calendar
   ```

   Then delete the downloaded key file.
3. The timer, alongside the email one (see docs/09-event-signups.md for the Vault
   secret):

   ```sql
   select cron.schedule('sync-calendar', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://psvodlthrxeimlezvmlq.supabase.co/functions/v1/sync-calendar',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                         where name = 'service_role_key')),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000)
   $$);
   ```

4. Within five minutes, Settings, Connections shows the service account address. Share
   the calendar with it (Make changes to events), paste the Calendar ID, tick Post live
   events, Save.
