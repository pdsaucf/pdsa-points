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

### Inter, self-hosted

**Inter is the typeface throughout**, for the admin UI, the check-in page and the member
portal. Self-host the woff2 files from the repo with `font-display: swap`. Do not link
Google Fonts or any CDN: the site is static and must carry no external font dependency.

```css
font-family: Inter, ui-sans-serif, system-ui, sans-serif;
```

Use `font-variant-numeric: tabular-nums` wherever digits line up in columns, which is
most of this product.

## Architectural invariants

Breaking any of these reintroduces a problem the design exists to solve:

1. **Nothing is hardcoded about categories, thresholds, or the Honorary rule.** They are
   rows. A category name, a threshold, which categories exist, and the overall pass rule
   all change from the admin UI with no deploy.
2. **Honorary status is computed in Postgres**, never in client JS.
3. **The anonymous check-in page touches no table.** It calls `SECURITY DEFINER` RPCs
   only. An anonymous caller can never set `status`.
4. **Categories archive, never delete.** Every reference is `on delete restrict`.
5. **An event is defined once.** Categories attach via `event_categories`. Never add a
   `category_id` column to `events`.
6. **No auto-approval.** Every attendance record is approved by a person. The triaged
   queue makes that cheap; it does not skip the step.
7. **Photos are never deleted on a timer.** Purging is an operator action, and only
   reviewed records are eligible.

## Multi-agent workflow

Per the global CLAUDE.md: orchestrator plans, `implementer` subagent builds,
`/codex:adversarial-review` and `/codex:rescue` check the work. Nobody signs off on
their own work.
