# PDSA Points System

Replacing PDSA UCF's Google Sheets point tracking with a static frontend on
GitHub Pages (points.pdsaucf.com) backed by Supabase.

Design docs, signed off before implementation:

- [docs/00-spreadsheet-findings.md](docs/00-spreadsheet-findings.md) - what the real
  spreadsheet does, verified against all 355 member rows
- [docs/01-data-model.md](docs/01-data-model.md) - tables, views, RLS, RPCs
- [docs/02-storage.md](docs/02-storage.md) - photo storage decision
- [docs/03-admin-ui.md](docs/03-admin-ui.md) - officer screens and build phasing
- [docs/04-member-ui.md](docs/04-member-ui.md) - member portal

## House rules

These are not stylistic preferences, they are requirements. Check them in review.

### No em dashes

**Never use an em dash (U+2014) anywhere in this project.** Not in UI copy, button
labels, empty states, error messages, email templates, seed data, code comments, commit
messages, or documentation. Use a colon, a comma, parentheses, or a second sentence.

Reviewers, this must return nothing. It matches the UTF-8 bytes for U+2014, so the
check itself contains no em dash and works in bash and zsh alike:

```bash
grep -rn $'\xe2\x80\x94' . --exclude-dir=.git --exclude-dir=node_modules
```

Do not substitute `printf '\u2014'`; it is not portable, and when it fails it expands to
an empty pattern that matches every line, which reads as a catastrophic failure rather
than a clean pass.

### Public Sans, self-hosted

**Public Sans is the typeface throughout**, for the admin UI, the check-in page and the
member portal. Not Inter: Inter is the reflexive default for AI-generated interfaces to
the point of being a tell, and Public Sans (the U.S. federal government's open-source
system typeface) reads as plain civic software instead. Self-host the woff2 files from
the repo with `font-display: swap`. Do not link Google Fonts or any CDN: the site is
static and must carry no external font dependency.

```css
font-family: 'Public Sans', ui-sans-serif, system-ui, sans-serif;
```

Use `font-variant-numeric: tabular-nums` wherever digits line up in columns, which is
most of this product.

### UI copy style

**Never imitate Claude or chatbot prose in UI copy. This should sound like software,
not like an assistant explaining itself.**

Before adding or changing any user-facing text, apply this test:

> Does the user need this sentence to understand the state or make the next decision?

If not, cut it. When uncertain, default to less copy.

Default is no explanatory prose at all. A heading, a button, and metadata should
carry the screen on their own. Add a helper line only for a fact the interface
cannot otherwise convey (a hidden constraint, a reason a state looks ambiguous),
and prefer deleting a line over shortening it.

Order information as: **what happened**, then **why it was flagged** only if the reason
is not obvious, then **what to do**. Then stop.

**Structure**

- Headings name the state or issue. They are not sentences about a person.
  Write `Duplicate photo`, not `Marcus Bell sent the same photo as another event`.
- Names, event titles, dates and times go in metadata or subtext, not inside the
  heading: `Marcus Bell · Aug 10 Soap Carving · 3:10 PM`.
- Descriptions are one sentence, ideally under 15 words. Omit them entirely when the
  heading and metadata already say it.
- Buttons are 1 to 3 words.
- Never repeat information already visible elsewhere in the same component.
- Never add prose to make a card feel more complete.

**Do not**

- Narrate application logic, or explain what a button obviously does.
- Speculate about why somebody did something unless it changes the decision.
- Chain causes with "so", "therefore", "rather than", "which means".
- Use several sentences where a status line works.
- Sound conversational, apologetic or legalistic.

**Established terms, used consistently**

`Approve` · `Decline` · `Edit` · `Remove` · `Link member` · `Compare photos` ·
`Try again` · `Late check-in` · `Duplicate photo` · `Previously declined` ·
`Member not matched` · `Needs review`

Avoid conversational labels such as `Approve anyway`, `Turn it down` or
`Yes, continue`. Use `Approve anyway` only where overriding a specific rule genuinely
needs the emphasis.

**Concise is not lossy.** Keep whatever is needed to tell members apart, identify the
event, show the check-in time, state the actual validation failure, surface a previous
decline reason, and identify a conflict or duplicate. Restructure those facts into
heading, metadata and a short description; do not delete them.

If a message can lose a sentence without changing the officer's decision, remove that
sentence.

```
Late check-in
Grace Okonkwo · Aug 9 Give Kids A Smile · 7:40 PM
Check-in closed at 7:35 PM.
[ Approve ]  [ Decline ]
```

## Architectural invariants

Breaking any of these reintroduces a problem the design exists to solve:

1. **Nothing is hardcoded about categories, thresholds, or the Honorary rule.** They are
   rows. A category name, a threshold, which categories exist, and the overall pass rule
   all change from the admin UI with no deploy. A category is a name and an order: there
   is one unit, it is points, and every category's credit counts toward the total.
   Whether a member types the number is `event_categories.credit_mode`, per event.
2. **Honorary status is computed in Postgres**, never in client JS.
3. **The anonymous pages touch no table.** The check-in page and the member portal call
   `SECURITY DEFINER` RPCs only. An anonymous caller can never set `status`.
4. **Categories archive, never delete.** Every reference is `on delete restrict`.
5. **An event is defined once.** Categories attach via `event_categories`. Never add a
   `category_id` column to `events`.
6. **No auto-approval.** Every attendance record is approved by a person. The triaged
   queue makes that cheap; it does not skip the step.
7. **Photos are never deleted on a timer.** Purging is an operator action, and only
   reviewed records are eligible.
8. **A member has no email address, and the member portal is not an account.** Somebody
   types their name and reads their own points. Nothing collects an address anywhere in
   the product; `members.email` is a column holding history that nothing reads.
9. **What the portal exposes is club-facing figures, plus a member's own event-by-event
   attendance for the current year, and nothing else.** Category totals, point totals,
   the honorary verdict, the published rules, and (through `portal_attendance()`) every
   published event of the year with that member's own status against it: attended,
   waiting, declined, upcoming, or nothing. Never an address, a student id, a note, an
   officer's decline reason, a photo, or anybody else's records. The portal has no login,
   so this is readable by anyone who can open the site and type a name, the same
   decision the leaderboard already makes. Widening that surface further means editing
   the written-out list in `test/privileges.test.mjs` on purpose.

## Multi-agent workflow

Per the global CLAUDE.md: orchestrator plans, `implementer` subagent builds,
`/codex:adversarial-review` and `/codex:rescue` check the work. Nobody signs off on
their own work.
