# Public Sans goes here

**These files are not in the repo yet.** The `@font-face` rule in
`web/assets/css/checkin.css` and `web/assets/css/admin.css` already points at
them, and until they exist the pages fall back to
`ui-sans-serif, system-ui, sans-serif`. That fallback is deliberate, not a bug:
`font-display: swap` means the text is readable from the first paint either
way, and nothing on the page moves when the font finally arrives.

## What to add

One file, the variable weight axis:

```
web/assets/fonts/public-sans/PublicSans-VariableFont.woff2
```

That single file covers every weight the pages use (400, 500, 600, 700), which
is why the rule declares `font-weight: 100 900` rather than shipping four
static cuts. If a later screen needs italics, add
`PublicSans-Italic-VariableFont.woff2` and a second `@font-face` block with
`font-style: italic`.

## Where to get it

From the Public Sans release on GitHub: `uswds/public-sans`, Releases page,
the `fonts/webfonts/PublicSans-VariableFont.woff2` file in the release zip (or
build the variable woff2 from source with the repo's own build script if a
prebuilt one is not offered in the release you pick). Public Sans is licensed
under the SIL Open Font License 1.1, the same terms as Inter, so self-hosting
and redistribution in this repo are both fine. Put the license text next to
the font as `OFL.txt` when you add it.

## Why Public Sans, not Inter

Inter is what nearly every AI-generated interface reaches for by default, to
the point that it now reads as a tell rather than a neutral choice. Public
Sans is the U.S. federal government's open-source system typeface, built for
exactly this kind of civic and administrative software: plain, legible, and
not associated with any product demo aesthetic.

## What not to do

- Do not link Google Fonts or any CDN. The site is static on GitHub Pages and
  carries no external dependency, which is a house rule in `CLAUDE.md`.
- Do not add a `<link rel="preload">` for a file that is not committed yet: it
  costs a 404 on every page load at an event.
