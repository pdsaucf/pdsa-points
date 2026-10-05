# Event sign-ups

Sign-ups move off Google Forms and onto `/events`. An officer builds the form on the
event itself, members sign up on the public page, and officers read the responses as a
sheet on the event's own screen. Migration 30 (`20260930100000_event_signups.sql`).

## What an officer sets, on the event form

Under **Sign-ups**:

- **Paid members only.** Only this year's active roster may sign up. The public card
  shows a purple `Members only` badge either way; open events show `Open to all`.
- **Sign-up form on the events page.** When off, the older `Sign-up link or note` field
  (`events.signup`) is shown instead, exactly as before.
- **Spots** (blank is no limit) and **Sign-ups close** (blank closes at the event start).
- **Questions**: short answer, paragraph, multiple choice, checkboxes; required or not;
  reordered with the arrows. Name is always asked, and email for guests.
- **Confirmation email**: how many days before the event, at what time, how many hours
  people have to confirm, and the subject and message, with placeholders
  `{name} {event} {date} {time} {location} {confirm_by}` and a live preview.

Everything saves with the event in one call, `save_event()`, which is
`save_event_config()` plus the form in the same transaction and revision check.

## How a sign-up works

```
member picks their roster name (autocomplete)        guest types name + email
                 │                                         │ (open events only)
                 └─────────────► portal_signup_submit() ◄──┘
                                       │
                         spot held at once, ranked by time
                         (Going, or Waitlist n), nothing sent
                                       │
            at the officer's time (days before, time of day), within 5 minutes:
            send-signup-emails emails everybody in line the officer's message
                                       │
               ┌───────────────────────┼─────────────────────────┐
           Confirm spot           Cancel sign-up           no reply by confirm_by
               │                       │                         │
          Confirmed              cancelled, line           Dropped, line moves up
                                  moves up
```

A sign-up after the email time has passed is emailed on the next run, within five
minutes. The confirm window never runs past the start of the event.

**The address is never one somebody typed beside a member's name.** A member's email is
the one on the roster (`members.email`). Somebody who picks another member's name holds
a spot until the email goes out, and the real member holds the link: they can confirm
or cancel it, and an unconfirmed spot drops. The form says this beside the name, with
the officer's schedule: `Confirmation email Monday, October 5, 9:00 AM, 2 days before,
to the paid-member email on file`. A guest typing a roster member's address becomes
that member. A member with no address on file is told so and cannot sign up until an
officer adds one.

The button reads `Add to headcount` on an open event with no spot limit (anyone may
come, the count is for planning), and `Sign up`, or `Join waitlist` when full, wherever
a spot is needed.

## Spots and drops are computed

`v_event_signups` is the one place state is decided. Live sign-ups (held or confirmed,
not dropped) are ranked by `created_at`; rank within `signup_capacity` is `going`, past
it is `waitlist`. A held sign-up past its `confirm_by` is `dropped`. Nothing runs to
move the waitlist: a cancellation, a drop, or a raised capacity moves everybody behind
it at the next read. `reply` is `confirmed`, `awaiting` (emailed, inside the window) or
`scheduled` (email not sent yet).

A dropped person may sign up again, at the back of the line.

## The officer's sheet

On the event's own screen, above Attendance: one row per sign-up with place in line,
name (and a `Guest` tag), status, confirmation, whether they actually came (`Attended`,
`To review`, `No-show` once the event has passed), when they signed up, one column per
question, and email. Filters: All, Going, Waitlist, Dropped, Cancelled. `Export CSV`,
`Add sign-up` (somebody who signed up in person: confirmed at once, no email) and
`Remove` (`remove_event_signup()`, audited). The event list card shows
`12 of 20 signed up, 3 on waitlist, 8 attended`.

An event with any sign-up, cancelled ones included, cannot be deleted
(`on delete restrict`, like attendance).

## Surfaces

| Function | Who | What |
| --- | --- | --- |
| `portal_events()` | anon | adds `members_only`, `released_at`, and `signups`: open, closes_at, capacity, going and waitlist counts, the email schedule, the questions. Never a name, address or answer |
| `portal_member_names()` | anon | this year's active roster, id, name and join date: the leaderboard's names without totals |
| `portal_signup_submit()` | anon | holds a spot; returns state and when the email goes out, never an address |
| `portal_signup()`, `portal_signup_confirm()`, `portal_signup_cancel()` | anon, by emailed token | the holder's own sign-up |
| `signup_due_emails()`, `signup_email_failed()` | service_role | the timer's queue: raw tokens and addresses |
| `save_event()`, `add_event_signup()`, `remove_event_signup()` | officer | |
| `set_member_emails()` | Secretary Director | roster addresses from the CSV import |

Tokens are 192 random bits, stored on the sign-up only as a sha256. While an email is
on its way, `signup_deliveries` (service_role only, no staff policy) holds its raw token,
the deadline it prints, and the subject and message exactly as first rendered. Nothing
counts as sent until `signup_email_sent()` acknowledges delivery, which is when the
confirm window starts. A run that dies, or a send whose outcome is unknown (no answer, a
5xx, a rate limit), is reclaimed after ten minutes with the same token, the same bytes
and the same delivery id as Resend's `Idempotency-Key`, so a member is never sent two
different links. Only a definite rejection withdraws the token and retries fresh, up to
five times. A member's address is read from the roster when the email is claimed, so a
corrected address is the one used. Sign-ups must close, and the email must be due,
before the event starts; `save_event()` refuses either otherwise.

## Roster addresses

The roster CSV import reads an optional `email` (or `email_address`) column and saves
it after the rows land. A member's Edit dialog has an Email field. An address used by
another member is refused for that row and reported; a malformed one stops the file and
names the row.

## Server setup, once

1. Resend: sign up with the club email (`pdsa.ucf@gmail.com`), add `pdsaucf.com`, add
   the DNS records Resend lists, and create an API key.
2. Secrets and deploy:

   ```bash
   supabase secrets set RESEND_API_KEY=re_xxx SIGNUP_EMAIL_FROM="PDSA UCF <events@pdsaucf.com>"
   supabase functions deploy send-signup-emails
   ```

3. The timer. In the SQL editor, with `pg_cron` and `pg_net` enabled under
   Database, Extensions, and the service role key stored once in Vault:

   ```sql
   select vault.create_secret('<service role key>', 'service_role_key');

   select cron.schedule('send-signup-emails', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://psvodlthrxeimlezvmlq.supabase.co/functions/v1/send-signup-emails',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                         where name = 'service_role_key')),
       body := '{}'::jsonb,
       timeout_milliseconds := 30000)
   $$);
   ```

Settings, Connections shows whether the job is running, from the status it reports
after every run (`email_status`).

## What this changes elsewhere

Invariant 8 is narrowed: members have an email address on the roster, read by
`signup_due_emails()` alone to decide where a confirmation goes, and shown only to
officers. Invariant 9 gains the sign-up surfaces above; `test/privileges.test.mjs`
lists them. The privacy policy says what is collected and why.
