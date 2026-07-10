# Third-party notices

The Tier 1 theme shells in this repo inline CSS from upstream projects so each shell is portable and offline-capable. Each upstream source retains its own copyright and licence; this file records the attributions.

If you derive a new tier-1 shell, run `python3 _vendor_tier1.py` to refresh and add the source + licence here.

## tier1/latex.html

- **Source**: [`latex.css`](https://github.com/vincentdoerig/latex-css) by Vincent Dörig
- **Licence**: MIT
- **Inlined assets**: Latin Modern woff2 fonts, base64-encoded

## tier1/terminal.html

- **Source**: [`terminal.css`](https://github.com/Gioni06/terminal.css) by Jonas Duri / Gioni06, v0.7.4
- **Licence**: MIT

## tier1/water.html

- **Source**: [`water.css`](https://github.com/kognise/water.css) by Kognise, v2
- **Licence**: MIT

---

Tier 2 themes (`swiss`, `handwritten`, `zine`) are original work in this repo. They reference Google Fonts via `<link>` tags at view time; Google Fonts are served under the SIL Open Font License — see [fonts.google.com/attribution](https://fonts.google.com/attribution) for individual font licences.
