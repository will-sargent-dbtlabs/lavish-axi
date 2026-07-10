---
name: loupe
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can annotate and send feedback on, using the Loupe CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
argument-hint: <what the artifact should show>
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, review, artifacts, visualization]
    category: productivity
---

# Loupe

Loupe helps agents turn rich HTML artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Loupe. First generate an interactive HTML artifact according to user request, then run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs poll`.

This skill runs a **local customized fork build** (`will-sargent-dbtlabs/loupe`, a fork of `kunchenguid/lavish-axi`), not the published npm package - always invoke it as `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs <html-file>`. The fork adds VCS-native diff review, the bundled themes, full-artifact print/PDF, and live content re-theming. If the fork source changes, rebuild it with `pnpm run build` in that repo so `dist/cli.mjs` is current.
If lavish-axi output shows a follow-up command starting with `lavish-axi`, run it as `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs ...` instead.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lavish` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

Use Loupe when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop

## Themes

This skill bundles a small library of self-contained HTML theme shells in `themes/` (next to this file, e.g. `~/.codex/skills/loupe/themes/`). They are JS-free, render standalone, and each declares `<meta name="lavish-design" content="off">`. The **default is `loupe-aurora`** - the dark aurora brand surface (deep navy under an orange→purple→blue glow) shown in a midnight chrome, carrying the Fivetran + dbt co-brand lockup in the masthead; it auto-prints light. Its light / print-first sibling is `loupe-aurora-light`.

Pick by content, falling back to the default when nothing fits clearly better:

| Content | Theme |
| --- | --- |
| Briefs, plans, reports, general use — **everyday default, all uses** (dark aurora + midnight chrome, co-branded, auto-prints light) | **`loupe-aurora`** (default) |
| Bold high-contrast Swiss light | `swiss` |
| Soft low-contrast Swiss light (former default) | `lavish-light` |
| Research / analytical / academic briefs | `latex` |
| Postmortems, runbooks, RFCs, ops/technical | `terminal` |
| General-purpose, calm, auto dark/light | `water` |
| Personal notes, casual writing | `handwritten` |
| Launches, manifestos, loud announcements | `zine` |
| Light / print-first brand deliverable (same palette on light paper) | `loupe-aurora-light` |

**Brand pair:** `loupe-aurora` (dark, glow-forward) and `loupe-aurora-light` (light, print-first) share one palette — deep navy `#0a1122` under an orange→purple→blue aurora, brand accent gradient `#2f6bff → #8a4dff → #ff6a1a`. They're a content-theme-switch pair (Light ⇄ Aurora), and `loupe-aurora` flips to the light palette on print so dark screen surfaces still hand off clean PDFs.

**Presentation branding (standard).** Both aurora themes carry the official **Fivetran + dbt (Newco) co-brand lockup** in the masthead — the pill mark (white on dark, gradient color pill on light/print) with **Loupe** as the subtitle beside it. The Loupe review **chrome** shows this same lockup on every session automatically (built into `dist/cli.mjs`), so any surface reviewed in Loupe is co-branded regardless of theme. Because `loupe-aurora` (dark, midnight chrome, auto-prints light) is now the everyday default for all artifacts, the co-brand lockup appears **on-page everywhere** and matches the midnight chrome around it; use `loupe-aurora-light` when you specifically want a light / print-first surface. Kit location, variant map, and wiring: agent-memory note `newco-cobrand-assets`.

A theme the user names always wins over auto-fit. Tie or unsure → `loupe-aurora`.

**To use a theme:** copy the shell into your artifact location, then replace its sample body prose with the real content while keeping the theme's structural markup intact (e.g. `loupe-aurora`/`loupe-aurora-light`/`lavish-light`/`swiss` use a `masthead → main(article + aside) → colophon` grid; `latex` wraps in `<article>`). Keep the `lavish-design` meta tag.

```sh
cp ~/.codex/skills/loupe/themes/loupe-aurora.html .lavish/<name>.html
# then edit .lavish/<name>.html: swap the sample content for yours, keep the structure
```

Because the shells set `lavish-design: off`, do **not** also apply Tailwind/DaisyUI when using a theme - they are mutually exclusive. Tier-2 themes (`loupe-aurora`, `loupe-aurora-light`, `lavish-light`, `swiss`, `handwritten`, `zine`) load Google Fonts via CDN (fine when online; embed fonts before offline/client delivery — see below); the rest are fully offline. `loupe-aurora` and `loupe-aurora-light` are Loupe-owned themes kept in this skill. Shared non-aurora themes can be refreshed from the `will-sargent-dbtlabs/lavish-themes` fork with `bash ~/.codex/skills/loupe/themes/refresh.sh`; refresh must not overwrite the Loupe-owned aurora pair.

**Content theme switching (optional).** If you want the reviewer to be able to live-switch the artifact's own look (not just the Loupe chrome around it) and export a themed standalone copy, declare a `#lavish-content-themes` JSON manifest and one `:root[data-lavish-content-theme="<id>"]` CSS override block per alternate palette, using the exact variable names your base `:root` already declares. `lavish-light.html`/`swiss.html` are the reference pair - copy their pattern rather than inventing a new one. This only works between themes that already share a variable scheme and structural markup; don't promise a live switch between two bundled themes that weren't built as a compatible pair.

## Workflow

1. Create the HTML artifact (default location `.lavish/<name>.html` in the working directory) - start from a bundled theme (see ## Themes; default `loupe-aurora`) unless the design-direction priority below points elsewhere.
2. Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs <html-file>` to open or resume a review session in the browser.
3. Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs poll <html-file>` to long-poll for the user's annotations, queued prompts, and browser-reported `layout_warnings`.
   The poll stays silent until the user acts or the real browser reports fresh layout warnings - leave it running, never kill it.
   If your harness limits how long a foreground command may run, run the poll as a background task; if it gets killed or times out anyway, just re-run it - queued feedback is never lost.
4. If poll returns `layout_warnings`, fix overflow, clipped text, or overlapping unreadable content and re-check before involving the human.
5. Apply human feedback, then poll again with `--agent-reply "<message>"` to reply in the browser and keep the loop going.
6. Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs end <html-file>` when the review is finished.

## Visual guidance

- Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance
- Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose
- Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view
- Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately
- Long paths, commands, hashes, and inline `code` spans should be allowed to wrap (`overflow-wrap:anywhere` or equivalent), especially inside sidebars and narrow grid columns

## Client delivery (standalone handoff)

When an artifact is going to a client/customer — not just internal review — deliver the **artifact file itself**, never the Loupe page. A Loupe artifact is a single self-contained HTML file (bundled themes are JS-free, all CSS inline), so it opens standalone in any browser with no server, no internet, and no Loupe.

- **Hand over the file, not the Loupe tab.** The page at `http://127.0.0.1:8700/session/...` wraps the artifact in review chrome (conversation panel, annotation UI); a browser "Save As" there captures that chrome. Send the `.html` artifact file directly.
- **Make it fully self-contained (zero external calls).** Bundled themes load Google Fonts via CDN, so a fresh artifact still phones home for fonts. Before handoff, run:
  ```sh
  python3 ~/.codex/skills/loupe/scripts/embed_fonts.py <artifact.html>
  ```
  It inlines the woff2 subsets (latin + latin-ext) as base64 and strips the CDN `<link>`/`<preconnect>` tags, so the file renders pixel-perfect **offline** and makes **no network requests** — important for locked-down / corporate environments. Verify: `grep -oE 'https?://[^" )]+' <artifact.html> | grep -v base64` should print nothing. (Cost: ~+700KB–1MB in the file.)
- **Add a print-hidden "Save as PDF" button** so the client can export a static copy in one click:
  ```html
  <button class="pdfbtn" onclick="window.print()">&#x2913; Save as PDF</button>
  ```
  with `@media print{.pdfbtn{display:none}}` (also hide on mobile). Combined with a theme's `@media print` rules (tabs stack, chrome hidden), Cmd/Ctrl-P yields a clean, chrome-free PDF. The single inline `onclick` is the only JS; it stays a portable file.
- **Deliverable = one HTML file + a one-click PDF path.** Nothing to install on the client side.

## Playbooks

Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs playbook <id>` for focused, detailed guidance on any of these.
One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox; open the diagram playbook and use Mermaid unless SVG is needed for richly annotated nodes.

- `diagram` - Map relationships, flows, state, and architecture
- `table` - Turn dense records into scan-friendly review surfaces
- `comparison` - Show options, tradeoffs, and current vs target behavior
- `plan` - Explain a product or technical plan before implementation
- `code` - Render source code, code files, patches, PR diffs, and before/after code inside Loupe artifacts
- `input` - Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact
- `slides` - Create a deliberate presentation when slides are requested

## Commands & rules

- Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs <html-file>` to open or resume a Loupe session
- Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs review [<ref-or-range>]` to review a **real git diff** as an annotatable surface - lavish reads the working tree for you (no hand-authored diff HTML). No ref diffs this branch against its merge-base with the default branch, including uncommitted and untracked work. The user clicks or selects a diff line and you get precise `file:line` feedback back through `poll`. Prefer this over the `code` playbook whenever the code under review is real git state
- Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`
- Loupe serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work
- Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs poll <html-file>` to wait for user feedback or browser-reported layout_warnings. It long-polls and stays silent until the user sends feedback, ends the session, or the real browser reports fresh layout_warnings, so leave it running - never kill it. Fix layout_warnings before involving the human. If your harness limits how long a foreground command may run, run the poll as a background task; if it gets killed or times out anyway, just re-run it - queued feedback is never lost
- Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs end <html-file>` to end a session
- Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected)
- Run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs playbook <playbook_id>` for focused artifact guidance. One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
- Loupe does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without Loupe running. Before writing any HTML, decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look, named a design system, or named one of the bundled themes (see ## Themes), use that; (2) if the artifact previews, proposes, or mocks a specific app's UI, inspect that project - the subject or product whose UI it represents, which may differ from your current working directory - and match its design system (Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages) so it faithfully shows the product, even when you are running in a different repo; (3) otherwise - the common case for briefs, plans, comparisons, reports, and docs - use a bundled theme from `themes/`, auto-fitting by content type and defaulting to `loupe-aurora` (see ## Themes); (4) only as a last resort, when the artifact genuinely needs interactive component styling no static theme provides, use the Loupe-recommended Tailwind CSS browser runtime v4 + DaisyUI v5 via CDN - run `node ~/code/will-sargent-dbtlabs/loupe/dist/cli.mjs design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference. When using a bundled theme, do not also layer on Tailwind/DaisyUI (the shells set `lavish-design: off`). When you deliver the artifact, state which design source you used and why (e.g. `theme: loupe-aurora`).
- Use Loupe when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop
