# Bundled Loupe themes

Nine self-contained HTML theme shells — no JS, no build step, no CDN dependency
at view time (except Google Fonts for the hand-built tier-2 themes). Open any
file in a browser and it renders. Used by the `loupe` skill as design sources
for artifacts.

| File | Aesthetic | Best for |
| --- | --- | --- |
| `loupe-aurora.html` | **Default.** Dark Loupe/Newco aurora surface, prints light. | Briefs, plans, reports, general default |
| `loupe-aurora-light.html` | Light / print-first sibling of the aurora theme. | Client-ready or print-first deliverables |
| `lavish-light.html` | Softened Swiss — dark gray on near-white, hairline rules, light code blocks. | Decisive product/strategy briefs and plans when a quieter light surface fits |
| `swiss.html` | International typographic. Black/red/white grid, heavy rules. | Same as above, when you want bold high contrast |
| `latex.html` | Academic paper, Latin Modern. | Research / analytical / academic briefs |
| `terminal.html` | Monospace terminal stationery. | Postmortems, runbooks, RFCs |
| `water.html` | Neutral classless, auto dark/light. | General-purpose, calm |
| `handwritten.html` | Lined exercise book, Caveat + Permanent Marker. | Personal notes, casual writing |
| `zine.html` | Yellow/black/magenta, Anton, hard shadows. | Launches, manifestos, loud announcements |

Every shell carries `<meta name="lavish-design" content="off">` — that tells
Loupe not to inject DaisyUI auto-styling on top. When you use a theme,
do **not** also apply Tailwind/DaisyUI; they're mutually exclusive.

## Source of truth

The Loupe-specific aurora pair is owned here, in the Loupe skill:

- `loupe-aurora.html`
- `loupe-aurora-light.html`

Do not source or overwrite those files from `lavish-themes`.

The remaining shared themes are a pinned snapshot of the **fork**:
<https://github.com/will-sargent-dbtlabs/lavish-themes>

To change a shared non-aurora theme, edit it in the fork, then re-sync:

```sh
bash ~/.codex/skills/loupe/themes/refresh.sh
```

`THIRD-PARTY-NOTICES.md` carries upstream license attribution for the tier-1
shells (latex/terminal/water), which inline third-party CSS.
