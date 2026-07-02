# lavish-axi fork — feature PRD

_Fork: `will-sargent-dbtlabs/lavish-axi` · Status: all three features shipped_

---

## Context

This PRD covers three planned features for the `will-sargent-dbtlabs/lavish-axi` fork. The fork tracks upstream (`kunchenguid/lavish-axi`) via `git fetch upstream` + periodic merges; changes are isolated as new files or small additive diffs where possible so merges stay cheap.

All three features (theme switcher, annotate-off-by-default, print/PDF) have shipped and merged to `main`. See each feature's own "Status" section below for the branch/PR it landed through.

---

## Feature 1 — lavish-light as default theme + UI theme switcher ✅ DONE

### Status

Implemented on branch `feat/chrome-theme-switcher` (commit `d508d63`).

### What was built

- Three chrome themes — `lavish-light` (default), `midnight` (the original dark palette), `swiss` — as `:root[data-lavish-theme="..."]` CSS custom-property overrides in `src/chrome.css`, captured from the matching bundled artifact themes in `will-sargent-dbtlabs/lavish-themes`.
- Theming applies only to the chrome (bar, overflow menu, sidebar), never the artifact iframe, resolving the design tension recorded below.
- `CHROME_THEMES` / `resolveChromeTheme(query, env)` in a new `src/chrome-themes.js` (flag → env → `lavish-light` default).
- `--theme <id>` CLI flag and `LAVISH_AXI_THEME` env var, mirroring `--annotate`/`LAVISH_AXI_ANNOTATE`.
- A "Theme" row of swatch buttons in the overflow menu; clicking one updates `document.documentElement.dataset.lavishTheme` and a `sessionStorage` entry (never `~/.lavish-axi/state.json`) — session-only by design, so it resets on a fresh open but survives a same-tab reload.

### Problem

The lavish skill currently defaults to the DaisyUI `luxury` theme when no explicit design system is present. That theme is dark and heavy. The `lavish-light` theme (a softened version of SWISS: dark-gray ink on near-white, hairline rules, light-gray code blocks) already exists in the `will-sargent-dbtlabs/lavish-themes` fork as a standalone HTML shell, but lavish-axi has no way to apply it automatically, and the chrome has no UI control for switching themes.

### Goals

1. Use `lavish-light` (or any bundled theme shell) as the default look for the artifact view.
2. Let the user switch themes from the chrome's overflow menu without re-running the agent.

### Design tensions

- **Portability constraint:** `src/html-transform.js` documents that "artifacts stay byte-identical (apart from the SDK script tag)" so they remain portable when opened directly. Wrapping the artifact in a theme shell — or injecting theme CSS into it — would break that contract.
- **Recommended resolution:** The theme applies only to the chrome, not the artifact. The chrome renders the artifact in its `<iframe>` as-is; the theme styles the surrounding masthead/sidebar/colophon frame. This keeps the artifact byte-identical. The lavish-themes HTML shells are _chrome_ templates, not artifact wrappers.

### Proposed approach

1. Add a `--theme <name>` CLI flag and `LAVISH_AXI_THEME` env var (mirrors the annotate pattern).
2. `createChromeHtml()` accepts a `theme` option; resolves to a bundled shell or the default `lavish-light`.
3. The chrome client renders the selected theme shell as the outer page structure, with the `<iframe>` sandboxed inside it as today.
4. The overflow menu gains a "Theme" sub-menu listing bundled themes; selection updates the chrome via a `lavish:setTheme` postMessage or a simple page-level CSS variable swap.
5. Theme choice is stored in `~/.lavish-axi/state.json` per-session so reload restores it.

### Files to touch

| File                      | Change                                                                      |
| ------------------------- | --------------------------------------------------------------------------- |
| `src/cli.js`              | Add `resolveThemeFlag()`, include `theme` in POST body                      |
| `src/server.js`           | `shouldResolveTheme()`, `createChromeHtml({ theme })`, serve bundled shells |
| `src/chrome-client.js`    | Theme switcher UI logic                                                     |
| `src/chrome.css`          | Theme-agnostic structural chrome CSS; theme shells own their own palette    |
| `test/server.test.js`     | TDD: default theme, `--theme lavish-light`, env override                    |
| `test/cli-output.test.js` | TDD: `resolveThemeFlag`                                                     |

### Open questions

- Where do bundled theme shells live in the dist bundle? Options: inline as template strings in `server.js`, or served from `dist/themes/`.
- Does the theme switcher rewrite `state.json` (persists across reloads) or is it session-only (lost on server restart)?

### Size estimate

Large — touches the chrome's rendering pipeline and requires a new asset-serving path. Likely 2–3 sessions.

---

## Feature 2 — annotate off by default ✅ DONE

### Status

Implemented on branch `feat/annotate-off-by-default` (commit `3bd3df1`). **Not yet pushed to origin.**

### What was built

- Default changed from `annotate = true` to `annotate = false`.
- `--annotate` / `--no-annotate` per-open CLI flags.
- `LAVISH_AXI_ANNOTATE=on` env override.
- `shouldEnableAnnotate(query, env)` resolver in `server.js` (flag → env → false).
- `resolveAnnotateFlag(args)` exported from `cli.js`.
- Bootstrap JSON includes `annotate` field; `chrome-client.js` reads it on init.
- `aria-pressed` on the Annotate button now reflects the actual initial state.
- 9 new/modified tests; `pnpm run check` exits 0.

### Pending

Push branch + open PR on the fork before merging to `main`.

---

## Feature 3 — multi-page PDF / print ✅ DONE

### Status

Implemented and merged to `main` via PR #4.

### What was built

Built close to the original proposal below, with two deliberate deviations found better during implementation:

- A `/print/:key` route family mirrors the existing `/artifact/:key` URL shape (`/print/:key`, `/print/:key/index.html`, `/print/:key/<path>`) instead of rewriting relative asset URLs to absolute — sibling assets resolve for free through the same `resolveArtifactAsset` helper the artifact route already uses.
- A new `injectPrintScript(html)` in `src/html-transform.js`, separate from `injectLavishSdk` (rather than a `{ sdk: false }` option on it) — the print route never calls `injectLavishSdk` at all, so there's no SDK/annotation/layout-audit machinery to strip.
- CSS-only-tabs dashboard artifacts needed a second, independent fix: printing doesn't change which tab's radio is checked, so an `@media print` override is now required in each such artifact (documented in the `dashboard` playbook's `design_rules` in `src/playbooks.js`).

### Problem

Clicking browser Print (Cmd+P) on the lavish-axi chrome page captures only the first viewport of the sandboxed `<iframe>`. The iframe sandbox (`allow-scripts allow-forms allow-popups allow-downloads`, no `allow-same-origin`) prevents the browser from paginating iframe content. Result: long artifacts are truncated in print/PDF output.

### Goals

Produce a full-content PDF of the artifact — all pages, all content — without adding a heavy headless-browser dependency (no Puppeteer, no Playwright).

### Proposed approach

**New `/print/:key` route** that serves the artifact HTML directly in a top-level browser tab (not inside an iframe). When the user clicks "Print / Save PDF" in the chrome's overflow menu:

1. Chrome opens `http://127.0.0.1:PORT/print/:key` in a new tab via `window.open()`.
2. The `/print/:key` route serves the artifact HTML with the SDK script tag stripped (no annotation, no layout audit needed) and a thin `<script>` that calls `window.print()` after `DOMContentLoaded`.
3. The browser's native print dialog opens on the full top-level document — all pages paginate correctly.
4. The tab can be closed after print, or the user closes it manually.

**Why this works:** The same-origin constraint that blocks iframe print doesn't apply to a top-level document served from the same local server. The browser paginates the full DOM tree.

**SDK stripping:** `src/html-transform.js` already injects the SDK tag; the `/print` route needs a `stripLavishSdk()` helper (or passes a `{ sdk: false }` option to the existing transform) to produce a clean artifact.

### Files to touch

| File                          | Change                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `src/server.js`               | New `GET /print/:key` route; `stripLavishSdk()` or option in `injectLavishSdk` |
| `src/html-transform.js`       | `{ inject: false }` option, or a new `stripLavishSdk()` export                 |
| `src/chrome-client.js`        | "Print / Save PDF" action in overflow menu → `window.open('/print/:key')`      |
| `test/server.test.js`         | TDD: `/print/:key` returns stripped HTML; auto-print script present            |
| `test/html-transform.test.js` | TDD: SDK not present when inject=false                                         |

### Edge cases

- Artifact with relative asset paths: `/print/:key` must serve sibling assets via the existing `/artifact/:key/<path>` route, or rewrite relative URLs to absolute. The simplest fix: rewrite `src=` and `href=` relative paths to `http://127.0.0.1:PORT/artifact/:key/...` in the print transform.
- Session not found: return 404, same as `/session/:key`.

### Size estimate

Medium — self-contained new route + a one-option change to the transform. Likely 1 session.

---

## Feature 4 — live content re-theming + standalone export ✅ DONE

### Status

Implemented on branch `feat/content-theme-switcher`.

### What was built

Content theming is an **opt-in contract**, not a lavish-axi-side registry — the tool has no hardcoded knowledge of any theme's palette. An artifact declares its own swappable palettes via a `#lavish-content-themes` JSON manifest plus `:root[data-lavish-content-theme="..."]` CSS override blocks (the same technique proven in `src/chrome.css` for the chrome itself). `src/artifact-sdk.js` detects the manifest and reports it to the chrome, applies switches by setting a `data-lavish-content-theme` attribute inside the sandboxed iframe, and replies to an export request with a full `outerHTML` snapshot with its own injected `sdk.js` script tag stripped out (found and fixed during live verification — otherwise the "standalone" export still depended on a running Lavish server). `src/chrome-client.js` renders a "Content Theme" menu section only when an artifact opts in, remembers the pick in `sessionStorage` (never `state.json`), and offers "Export standalone copy" — a client-side `Blob` download, no server route involved. `lavish-light` and `swiss` in `will-sargent-dbtlabs/lavish-themes` are the first reference implementation, since they already share a compatible variable scheme. Verified live: content theme switches independently of the chrome's own theme, survives an artifact reload via `sessionStorage`, and the exported file renders identically when opened standalone with no server running.

## Feature 5 — dark content themes for the rest of the bundled library ✅ DONE

### Status

Implemented directly in `will-sargent-dbtlabs/lavish-themes` (no lavish-axi changes — the switcher mechanism from Feature 4 is already fully generic).

### What was built

The originally-sketched idea (rename all 8 bundled themes onto one shared variable scheme so any theme could switch to any other) turned out not to hold up: `terminal`/`water`/`latex` are vendored third-party CSS frameworks with their own variable conventions, and `handwritten`/`zine` have bespoke visual identities built from CSS rules that don't exist in the `lavish-light`/`swiss` structure at all — a rename wouldn't make them cross-compatible, since the actual layout/rules differ, not just the variable names. `dbt-brief`/`dbt-brief-dashboard` already share an identical palette with each other, but as the same look in two layouts, not two looks to switch between.

What shipped instead: every remaining bundled theme got its own single-file `dark` sibling, each built the way that theme's structure called for — `latex` and `water` reuse a dark palette the theme already shipped but never exposed outside a dormant CSS class or an OS preference; `terminal` (which turned out to have no existing dark support at all, contrary to the initial assumption), `handwritten`, `zine`, and `dbt-brief`/`dbt-brief-dashboard` needed a hand-designed dark palette from scratch. `zine`'s dark variant swaps the values of its `--yellow`/`--black` variables rather than rewriting each of the ~7 selectors that already alternate between them — the whole page flips from yellow-dominant to black-dominant for free. Two more hardcoded-background contrast bugs (in the same family as the one already fixed for `lavish-light`) were found and fixed along the way — `dbt-brief`'s cards/tables/nav were entirely hardcoded `white`/light-gray rather than variable-driven, which would have gone illegible under a dark `--ink`. A separate, unrelated bug was also found and fixed during implementation: the manifest `<script type="application/json" id="lavish-content-themes">` tag must live outside any `<style>` element, not textually nested inside one (a `<style>` element's content model is raw text until the literal `</style>`, so a `<script>` tag placed inside it never becomes a real DOM element — it silently gets treated as inert CSS text instead).

---

## Pending before any feature merge

- [x] Push `feat/annotate-off-by-default` to `origin` and open PR (merged via PR #3)
- [ ] Decide: repoint lavish skill from `npx -y lavish-axi@0.1.31` to fork via `npm link` (all three planned features have now landed)
- [ ] Periodic upstream sync: `git fetch upstream && git log upstream/main ^HEAD --oneline` to review new commits

---

_Last updated: 2026-07-01_
