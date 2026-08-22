# Public Sans

The self-hosted Public Sans variable Roman font and its license are in this
directory. The `@font-face` rules in `web/assets/css/checkin.css`,
`web/assets/css/admin.css`, and `web/assets/css/portal.css` load the WOFF2 file
with `font-display: swap` and retain the
`ui-sans-serif, system-ui, sans-serif` fallback.

## Included files

- `PublicSans-VariableFont.woff2`: variable Roman, weight axis 100 through 900
- `OFL.txt`: the SIL Open Font License 1.1 distributed with Public Sans v2.001

The variable font covers every weight the pages use (400, 500, 600, 700), which
is why the rule declares `font-weight: 100 900` rather than shipping four
static cuts. If a later screen needs italics, add
`PublicSans-Italic-VariableFont.woff2` and a second `@font-face` block with
`font-style: italic`.

## Source

This is Public Sans v2.001 from the official `uswds/public-sans` repository.
The release does not include a variable WOFF2, so the WOFF2 here is a lossless
web repackaging of the release's variable Roman TTF:

`https://raw.githubusercontent.com/uswds/public-sans/v2.001/fonts/variable/PublicSans%5Bwght%5D.ttf`

The license is the release's `OFL.txt`, with trailing whitespace normalized:

`https://raw.githubusercontent.com/uswds/public-sans/v2.001/OFL.txt`

The font metadata reports `Version 2.001` and a `wght` axis from 100 to 900.

## Why Public Sans, not Inter

Inter is what nearly every AI-generated interface reaches for by default, to
the point that it now reads as a tell rather than a neutral choice. Public
Sans is the U.S. federal government's open-source system typeface, built for
exactly this kind of civic and administrative software: plain, legible, and
not associated with any product demo aesthetic.

## What not to do

- Do not link Google Fonts or any CDN. The site is static on GitHub Pages and
  carries no external dependency, which is a house rule in `CLAUDE.md`.
