# The officer passcode: the decision and what it costs

Supersedes an unbuilt design for Google sign-in, which was written and then dropped in
favour of this. Magic-link sign-in is gone with it.

## What was asked

> Just make the admin login a passcode: no email supabase auth, just a passcode. Make the
> admin login page extremely discreet, no logo, literally just a text box, no prompt.
> purge all the unneeded infrastructure.

All of that is built. The one thing done differently is where the passcode is checked,
and that is the whole of the next section.

## The passcode is checked by the server, not by the page

This was not a preference. On this architecture there is no other option that keeps the
product working.

`points.pdsaucf.com` is a static site on GitHub Pages, served out of a **public**
repository, and `web/config.js` publishes the Supabase URL and anon key deliberately
(see the README's security paragraph). Every officer screen reads and writes ordinary
tables, and what stops the world reading them is RLS keyed on the `authenticated` JWT:
`fn_current_role()` reads `profiles.role` for `auth.uid()`, and `anon` holds no grant on
any table at all.

So a passcode compared in JavaScript fails twice over:

1. The comparison ships as readable source at a public URL. Anybody can open it.
2. Much worse, without a JWT there is no `authenticated` role, so the admin screens would
   only function if `anon` were granted the officer surface. That is 355 members'
   records, plus every attendance row and every category, readable **and writable** by
   anyone who opens the site. The passcode would be a JavaScript `if` in front of an open
   database, and removing the `if` is one line in the browser's console.

What is built instead: the box posts the passcode to GoTrue's password grant
(`POST /auth/v1/token?grant_type=password`) against one shared account. GoTrue compares
it to a bcrypt hash in `auth.users` and returns a real JWT. The officer sees one box and
types one thing. No email is sent, no link is opened, no address is typed, and no
identity provider is involved. Every policy in migration 11 keeps working untouched,
because as far as the database is concerned nothing about authentication changed.

The passcode itself is never in this repository. It lives as a hash in `auth.users` and
is set with `scripts/set_officer_passcode.sql`.

## What a shared account costs

Worth writing down, because these are consequences of one shared passcode and no
implementation avoids them.

- **The audit trail records an action, not a person.** `reviewed_by`, `performed_by` and
  `actor_user_id` all become the same user id on every row. The system can say a check-in
  was approved and when; it can no longer say by which officer. Everything else about the
  audit trail (what changed, when, in what order) is unaffected.
- **Rotation is manual and is everybody at once.** When somebody leaves the board, the
  passcode changes for the whole board. The script has the two statements this needs, and
  the second one (clearing live sessions) is the one that actually removes access from
  somebody already signed in.
- **A passcode spreads.** It gets texted, it goes in a group chat, and it outlives the
  officer who was given it. That is the trade being made for one box and no email.
- **Roles still exist and still work.** `admin`, `officer` and `viewer` are unchanged in
  the database. The shared account is one `admin` profile. If per-officer accounts are
  ever wanted again, nothing in the schema has to move: it is more rows in `profiles` and
  a way to sign in to them.

## The screen

`web/admin/index.html`, view 2. One `type="password"` field, centred on an empty page.
No wordmark, no emblem, no heading, no label, no button, no helper text. The page paints
nothing at all until the JavaScript has decided which state it is in, so a stranger who
loads `/admin/` never sees a flash of anything that names the club.

Three things are deliberately kept, and `verify-admin.mjs` checks all three:

- a `visually-hidden` label, so the field is not an unexplained box to a screen reader
- a `visually-hidden` live region, which is where "Incorrect passcode." is said
- a `visually-hidden` submit button, so Enter submits everywhere rather than relying on
  the single-input implicit-submission default

The only visible signal is the box itself: refused, it turns red. **Including its focus
ring.** Submitting is Enter, so the field is always focused when it is refused, and a 3px
focus ring outside a 1px red border reads as an ordinary focused box. On a screen with no
text on it that left nothing at all saying the passcode was wrong. That was caught in the
browser rather than in review, and there is now a check for it.

## What was purged

- `sendMagicLink()`, `parseAuthRedirect()`, and `captureRedirect()`: the whole
  email-link flow, including the redirect fragment parsing and the `create_user`
  argument that used to be the officer/member difference.
- The sign-in screen's email field, submit button, sent and error states, and their copy.
  `describeSignIn()` went from six GoTrue outcomes to four short lines.
- The lockup: `pdsa-logo-360.png` is deleted, and `.brand-lockup`, `.lockup` and
  `.brand-mark` are gone from `admin.css`. Nothing in the product loads it now.
- The mock's magic-link machinery: the `magicLinks` map, the `/__mock/magic-link` route,
  the `/auth/v1/otp` endpoint, and `newAccounts` (which only the `create_user` path ever
  wrote to).
- Four identical copies of `signInAs()` across the verify files, now one
  `web/mock/sign-in.mjs`.

Kept, because the session is still a session: storage, the expiry skew, the
single-flight refresh, and `signOut()`.

## Setting it up

1. Supabase dashboard, Authentication > Users > Add user. Address as in
   `OFFICER_ACCOUNT_EMAIL` (`web/config.js`), any password, **Auto Confirm User ticked**.
   An unconfirmed account cannot use the password grant, and nothing will ever mail that
   address to confirm it.
2. Give it a role:
   ```sql
   insert into profiles (user_id, role, full_name)
   select id, 'admin', null from auth.users where email = 'officers@pdsaucf.com';
   ```
   Without this the passcode signs in and then reads nothing, which is the guard working
   rather than a fault.
3. Set the passcode with `scripts/set_officer_passcode.sql`, pasting it at the prompt.
4. Turn off open signups in Supabase (Authentication > Sign In / Providers, disable email
   signup). The password grant never creates an account, so this is not what protects the
   product, but leaving `/auth/v1/signup` open lets anybody mint a roleless `auth.users`
   row with the public anon key, and there is no reason to allow it.

## Worth revisiting

Not now, and not part of this change:

- **Rate limiting.** There is one account and one passcode, so every guess in the world
  lands on the same target. GoTrue rate limits per address, which here means per product.
  Worth checking what that limit actually is in the project's settings, because the
  default was written for a service where an attacker has to guess the address too.
- **A passcode that is not a word plus a year.** Whatever is chosen, it is guessable in
  proportion to how memorable it is, and this one is shared with everybody who has ever
  been on the board.
