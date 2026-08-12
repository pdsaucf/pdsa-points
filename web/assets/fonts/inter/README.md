# Inter goes here

**These files are not in the repo yet.** The `@font-face` rule in
`web/assets/css/checkin.css` already points at them, and until they exist the page
falls back to `ui-sans-serif, system-ui, sans-serif`. That fallback is deliberate,
not a bug: `font-display: swap` means the text is readable from the first paint
either way, and nothing on the page moves when the font finally arrives.

## What to add

One file, the variable weight axis:

```
web/assets/fonts/inter/InterVariable.woff2
```

That single file covers every weight the check-in page uses (400, 500, 600, 700),
which is why the rule declares `font-weight: 100 900` rather than shipping four
static cuts. If a later screen needs italics, add `InterVariable-Italic.woff2` and
a second `@font-face` block with `font-style: italic`.

## Where to get it

From the Inter release, `Inter-*.zip`, in the `web/` folder of the archive
(rsms.me/inter, or the GitHub releases page for `rsms/inter`). Inter is licensed
under the SIL Open Font License 1.1, so self-hosting and redistribution in this
repo are both fine. Put the license text next to the font as `OFL.txt` when you
add it.

## What not to do

- Do not link Google Fonts or any CDN. The site is static on GitHub Pages and
  carries no external dependency, which is a house rule in `CLAUDE.md`.
- Do not add a `<link rel="preload">` for a file that is not committed yet: it
  costs a 404 on every page load at an event.
