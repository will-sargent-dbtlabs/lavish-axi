# VCS-native diff review (`lavish-axi review`)

- **Date:** 2026-07-06
- **Repo:** `will-sargent-dbtlabs/lavish-axi` (fork of `kunchenguid/lavish-axi`)
- **Status:** Design / spec — not yet implemented
- **Fork feature #:** 6 (follows the five shipped features documented in `docs/prd-fork-features.md`)
- **Revision:** v2 — folds in adversarial review (2026-07-06). Changes from v1:
  self-rendered diff markup instead of `@pierre/diffs`; single-`git diff` range
  model; annotate-on default; corrected annotation-capture scope (handles the
  text-selection gesture); `openCommand` refactor made explicit.

## Problem

Lavish reviews rich HTML artifacts the agent authors. For code review, the `code`
playbook (`src/playbooks.js:118-178`) instructs the agent to **hand-author**
`@pierre/diffs` HTML — it pastes the code it believes changed into
`oldFile.contents` / `newFile.contents`. Three costs follow:

1. **Effort** — the agent reconstructs a diff view by hand every round.
2. **Fidelity risk** — the hand-authored diff can drift from the real working
   tree; the agent can misrepresent what actually changed.
3. **No line-precise feedback loop** — annotations anchor to DOM selectors / text
   ranges, so "fix `src/foo.js:42`" round-trips as fuzzy selected-text rather than
   a precise file/line the agent can act on.

Crit (<https://crit.md>) solves this by reading the real VCS diff and rendering a
PR-style review surface — "point at the line, tell the agent." This feature brings
the strongest part of that model into the fork while keeping Lavish's artifact,
theming, and portability advantages.

## Goals

- `lavish-axi review` reads the real `git diff` and renders it as a Lavish artifact
  — the agent authors **nothing**.
- Default range matches the PR mental model: this branch's changes vs its
  merge-base, including uncommitted and untracked work.
- Diff-line annotations reach the agent as precise `file:line:side`, whether the
  user clicks a line or drags to select it.
- The artifact renders **offline** (no CDN dependency) and is testable as static
  HTML in Node.
- Reuse the existing open → serve → poll pipeline; keep the artifact
  portable/printable/themeable; keep the change additive and low-risk for upstream
  merges (mirror the `/print` feature's isolation).

## Non-goals (YAGNI)

- jj / Sapling support — git only for v1 (Crit has these; defer).
- Automatic round-to-round delta tracking / persistent cross-round threads —
  re-running `review` regenerates the current diff; that is sufficient for v1.
  (Re-running overwrites the same file → same session key → chokidar reloads the
  iframe; any un-polled prompts referencing old line numbers go stale, which is
  acceptable for v1.)
- Crit's "Live mode" localhost proxy — unrelated to diffs, out of scope.
- Visual parity with the hand-authored `code` playbook's `@pierre/diffs` output —
  `review` uses its own simpler diff markup (see Decisions #4).

## Decisions (settled during brainstorming + adversarial review)

1. **Render owner:** lavish generates a real artifact **file**, then delegates to
   the existing session pipeline. (Not a live server-rendered route — keeps the
   session=file invariant and minimizes upstream-merge risk.)
2. **Default diff:** a single `git diff <merge-base>` (merge-base of HEAD and the
   auto-detected default branch, vs the working tree), which in one coherent
   old→new numbering covers committed-since-merge-base + staged + unstaged.
   Untracked files are surfaced separately (see §2). Explicit ref/range overrides.
3. **Annotation anchoring (option C):** emit `data-file` / `data-line` /
   `data-side` attributes on rendered diff lines; the SDK resolves the annotated
   line via the nearest `[data-file]` ancestor and attaches
   `{type:"diff-line", file, line, side}` to the annotation `target`. **No change
   to the shared normalization** — `session-store.js` `normalizeTarget` (`:207`)
   is a pure `JSON.parse(JSON.stringify(target))` deep-clone with no whitelist, so
   the custom target flows through to `poll` untouched (verified: the existing
   `text-range` target rides the identical path).
4. **Diff renderer:** `review` **self-renders** its own diff markup in Node —
   **not** `@pierre/diffs`. Rationale (from adversarial review): `@pierre/diffs` is
   browser/CDN-only (loaded from esm.sh, renders into the live DOM), so it cannot
   render or stamp `data-*` attributes server-side and cannot be asserted in a
   static-HTML Node test. Because lavish (not the agent) owns rendering here, we
   emit plain semantic markup we fully control — which makes attribute-stamping
   trivial, works offline, and is unit-testable. Trade-off: `review` diffs will not
   look byte-identical to hand-authored `code`-playbook diffs. Accepted.

## Architecture

`review` is a thin front-end: a **git-diff-to-file preprocessing step** in front of
the existing open flow. It produces `.lavish/review-<branch>.html`, then hands that
file to the unchanged session-creation + serve + browser-open + poll pipeline.
Nothing downstream (`poll`, `end`, `stop`, `/print`, themes) knows the file came
from git.

Two new isolated modules, each with one clear purpose and independently testable:

- **`src/git-diff.js`** — resolves the ref range, shells out to git, returns
  **structured diff data** (no HTML). Testable with fixture repos, zero DOM.
- **`src/diff-artifact.js`** — turns diff data into a self-contained HTML string
  (our own markup). Testable with fixture data, zero git, zero browser.

This split is the key isolation boundary: git logic never touches the DOM, and the
renderer never touches git.

### 1. Command surface — `src/cli.js`

```
lavish-axi review [<ref-or-range>] [flags]
```

- No args → `git diff <merge-base>` (+ untracked), annotation **on**.
- `review main` → diff against merge-base of HEAD and `main`.
- `review abc123..def456` → explicit range passed to git.
- Flags reuse existing resolvers: `--theme`, `--no-gate`, `--no-open`,
  `--annotate` / `--no-annotate`.
- New flag `--name <slug>` → controls the artifact filename (default derived from
  the current branch name, **sanitized**: `/` → `-`; detached HEAD → short SHA).

**Annotate default (adversarial finding 4):** this fork ships annotation OFF by
default (`shouldEnableAnnotate` returns `false` when unset, `src/server.js:729`).
`review`'s entire value is annotating lines, so `reviewCommand` **defaults
`annotate: true`**, still honoring an explicit `--no-annotate`. This is the one
place `review` deliberately diverges from `open`'s flag defaults.

Wiring (same pattern as every other command):

- Add `"review"` to the `COMMANDS` set (`src/cli.js:17`).
- Add `review: reviewCommand` to the dispatch map (`src/cli.js:53-62`).
- `async function reviewCommand(args)`: parse flags via `flagValue` (`:769`) /
  `args.includes(...)`; `resolveRange(args)` → `readDiff()` (git-diff.js) →
  `renderDiffArtifact()` (diff-artifact.js) → write file → delegate to the shared
  open helper below with `annotate` defaulted true.
- Add `review` to `TOP_LEVEL_HELP` (`:785`) and `COMMAND_HELP` (`:787`).
- Bad input throws `AxiError(msg, "VALIDATION_ERROR", [hints])` (import at `:8`).

**`openCommand` refactor (adversarial finding 7):** `openCommand`
(`src/cli.js:165-186`) currently derives the file and `noGate/annotate/theme`
straight from `args` (`:166`, `:172-174`), so `reviewCommand` cannot call
`openCommand(args)` (its args are a ref/range, and the file is generated). Extract
the reusable tail (`ensureServer → postJson /api/sessions → open →
createOpenOutput`, `:175-185`) into a small helper
`openResolved({ absolute, noGate, annotate, theme, noOpen })` that both
`openCommand` and `reviewCommand` call. `openCommand` keeps parsing args then calls
the helper; behavior is unchanged.

### 2. Git integration — `src/git-diff.js` (new)

First VCS shell-out in the product. Uses `node:child_process` `spawnSync` with
**argument arrays** (never string interpolation — no shell-injection surface),
matching the existing `spawnSync("lsof"...)` / `spawnSync("ps"...)` idiom.

Range resolution (no-arg default):

1. Detect default branch: `git symbolic-ref refs/remotes/origin/HEAD` → else
   `main` → else `master`. If none resolve → `AxiError` (do not silently pick a
   wrong base).
2. `<mb> = git merge-base HEAD <base>`.
3. **Single diff:** `git diff <mb>` — merge-base tree vs working tree — one
   coherent old→new line numbering covering committed-since-`<mb>` + staged +
   unstaged. (v1 explicitly does **not** merge two diffs; the v1-draft
   committed-plus-uncommitted layering double-counted and mis-numbered lines.)
4. **Untracked files:** `git diff` alone omits them. Enumerate via
   `git ls-files --others --exclude-standard` and render each as an all-added file
   (or run the diff with `--intent-to-add` staging in a throwaway index — decide in
   implementation; the enumerate-and-synthesize approach avoids mutating the
   user's index and is preferred).

Explicit arg: if it looks like a range (`a..b` / `a...b`) pass through; otherwise
treat as a base ref and merge-base against HEAD.

Return shape (plain data):

```js
[
  {
    path: "src/foo.js",
    oldPath: "src/foo.js", // differs on rename
    status: "modified", // added | modified | deleted | renamed | untracked | binary
    hunks: [{ oldStart, newStart, lines: [{ side, lineNo, content }] }],
  },
];
```

`side ∈ { "old", "new", "context" }`; `lineNo` is the line number on that side.

Guardrails (all `AxiError` with actionable hints):

- Not a git repo → `"not a git repository"`.
- git not installed / not on PATH → clear error.
- No default branch resolvable (no `origin/HEAD`, no `main`/`master`) → error
  naming what was tried.
- Bad ref/range → surface git's trimmed stderr plus the attempted range.
- Empty diff (no tracked changes and no untracked files) → friendly
  `"no changes to review between <base> and HEAD"`; exit without opening a surface.

### 3. Rendering — `src/diff-artifact.js` (new)

Turns diff data into a self-contained HTML string using **our own diff markup** (no
`@pierre/diffs`, no CDN — see Decisions #4). Renders in Node; asserts as static
HTML.

- Emit one block per file with a file header, then a table/rows of lines. Each line
  element carries `data-file`, `data-line`, and `data-side` (the option-C
  mechanism), plus a class for add/remove/context styling. HTML-escape all line
  content.
- To keep drag-select from producing a fuzzy text-range (adversarial finding 2),
  make each rendered line a discrete element whose nearest `[data-file]` ancestor
  is unambiguous, so the SDK can resolve line identity from either a click or a
  text selection (see §4).
- Wrap in a real theme shell (default `lavish-light`, honoring `--theme`), with a
  multi-file file-list header. Keep the theme shells' `lavish-design: off` contract
  (no Tailwind layering).
- Binary files: rendered as "binary — not shown". A per-file render failure
  (malformed/huge) degrades to an in-artifact notice rather than aborting the whole
  review.
- Syntax highlighting is **out of scope for v1** (plain monospace, add/remove
  coloring only) — keeping the renderer dependency-free and offline. Highlighting
  can be a follow-up.

### 4. Annotation flow (option C)

Adversarial findings 2 and 6 reshaped this section. Two facts from the code:

- Element annotations attach **no `target`** today: `context()`
  (`src/artifact-sdk.js:155-162`) returns only `{uid, selector, tag, text}`, and the
  click path (`showAnnotationCard(event.target)` → `queuePrompt`) never sets a
  target. So diff-line capture is **net-new SDK logic**, not "read an existing
  field."
- A drag-select fires the `mouseup`/`textSelectionContext` path
  (`~:818-836`, `:202-219`) which builds a `text-range` target and sets
  `ignoreNextClick`, so the click path is skipped. Hooking only the click path
  would miss the most natural gesture.

Design — one small resolver, hooked into **both** paths:

- Add `resolveDiffLine(el)` in `src/artifact-sdk.js`: walk `el.closest('[data-file]')`
  and, if found, read `data-file` / `data-line` / `data-side` → return
  `{type:"diff-line", file, line:Number(...), side}` (else `null`).
- **Click path:** in `showAnnotationCard`/`context` for an element inside a
  `[data-file]`, attach the resolved `diff-line` target to the queued prompt.
- **Text-range path:** in `textSelectionContext`, resolve the diff line from the
  selection's `commonAncestorContainer` (or its element parent) via
  `resolveDiffLine`; when it resolves, attach the `diff-line` target **in addition
  to** the existing text-range fields (so the agent gets precise `file:line` and
  the selected text). When it doesn't resolve (non-diff artifacts), behavior is
  exactly as today.
- **`src/session-store.js`:** **no change** (finding 5 confirmed the deep-clone
  passthrough).
- **`poll` output:** the agent receives `prompts[].target`; diff annotations arrive
  with `target.type === "diff-line"` and `file`/`line`/`side` — e.g. "src/foo.js:42
  (new): tighten this guard".
- Non-diff artifacts are entirely unaffected; `diff-line` is purely additive.

### 5. Playbook amendment — `src/playbooks.js:118-178`

The `code` playbook is **amended, not replaced**. Add a leading note: when the code
to review is a real git working state, prefer `lavish-axi review` (it reads the
diff for you) over hand-authoring; hand-author with `@pierre/diffs` only for
synthetic / illustrative snippets or non-git code. The existing `@pierre/diffs`
guidance stays valid for that illustrative case.

## Error handling

All failures surface as `AxiError` with actionable hints (codebase idiom):

- Not a git repo / git absent → validation error with hint.
- No resolvable default branch → error naming what was tried.
- Bad ref/range → git stderr (trimmed) + attempted range.
- Empty diff → friendly message, no surface opened.
- Per-file render failure (binary, huge, malformed) → skip that file with an
  in-artifact notice; never abort the whole review.

## Testing (`node:test`, per repo convention; `LAVISH_AXI_STATE_DIR` + ephemeral ports for server tests)

- **`test/git-diff.test.js`** (new) — build throwaway fixture repos in a temp dir
  (`git init`, commit, branch, edit, add an untracked file); assert range
  resolution (merge-base; `origin/HEAD` → `main` → `master` fallback; no-default
  error), correct old→new line numbering from a single `git diff <mb>`, and that
  untracked files appear as all-added. Pure, no browser.
- **`test/diff-artifact.test.js`** (new) — feed fixture diff data; assert the
  emitted **static HTML** carries correct `data-file` / `data-line` / `data-side`
  per line, multi-file structure, HTML-escaping, and the binary/notice fallbacks.
  Now feasible because rendering is server-side (Decisions #4). No git, no browser.
- **`test/artifact-sdk.test.js`** (extend) — `resolveDiffLine` returns the right
  target from a `[data-file]` ancestor; both the click path and the text-selection
  path attach a `diff-line` target; non-diff selections are unchanged.
- **`test/cli-output.test.js`** (extend) — `review` in a non-repo → validation
  error; empty diff → friendly message; `--no-open` returns the expected object;
  annotate defaults on unless `--no-annotate`.
- **`test/server.test.js`** (extend) — a generated diff artifact serves and polls
  end-to-end through the unchanged pipeline (proves delegation) and a `diff-line`
  target survives to poll output.
- Full `npm run check` before push (build + eslint + prettier + `tsc` checkJs +
  test + skill freshness). Because we add a command and touch the `code` playbook,
  `npm run build:skill` regenerates `skills/lavish/SKILL.md`; `check` fails on
  drift.

## Files touched

| File                         | Change                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `src/git-diff.js`            | **new** — range resolution + git shell-out → diff data (single `git diff <mb>` + untracked) |
| `src/diff-artifact.js`       | **new** — diff data → self-rendered HTML with `data-*` line attrs                           |
| `src/cli.js`                 | add `review` command; extract `openResolved(...)` helper shared with `openCommand`          |
| `src/artifact-sdk.js`        | add `resolveDiffLine`; attach `diff-line` target on click **and** text-range paths          |
| `src/playbooks.js`           | amend `code` playbook to point at `review`                                                  |
| `skills/lavish/SKILL.md`     | regenerated via `build:skill`                                                               |
| `test/git-diff.test.js`      | **new**                                                                                     |
| `test/diff-artifact.test.js` | **new**                                                                                     |
| `test/cli-output.test.js`    | extend                                                                                      |
| `test/artifact-sdk.test.js`  | extend                                                                                      |
| `test/server.test.js`        | extend                                                                                      |

`src/session-store.js` and `src/server.js` are intentionally **not** modified — the
shared data model (deep-clone passthrough, finding 5) and the serving pipeline both
work unchanged.

## Resolved risks (from adversarial review)

1. **`@pierre/diffs` server-side rendering/stamping** — resolved by self-rendering
   our own markup (Decisions #4). The former "stamping spike" is gone.
2. **Drag-select bypassing capture** — resolved by hooking `resolveDiffLine` into
   the text-range path as well as the click path (§4).
3. **Committed+uncommitted double-count** — resolved by a single `git diff <mb>`
   (§2). Untracked files handled explicitly.
4. **Annotate off by default** — `review` defaults `annotate: true` (§1).
5. **`normalizeTarget` passthrough** — verified true; `session-store.js` unchanged.
6. **`openCommand` not callable** — addressed by the `openResolved` extraction (§1).

## Remaining open risks

1. **Untracked-file rendering approach** — enumerate-and-synthesize vs
   `--intent-to-add` in a throwaway index. Prefer enumerate-and-synthesize (no
   mutation of the user's index); confirm during implementation.
2. **Rename/copy detection** — `git diff -M` semantics and how `oldPath`/`status`
   map into our markup; cover with a rename fixture.
3. **Very large diffs** — v1 renders everything; if artifact size becomes a
   problem, add a per-file collapse or a line cap (follow-up, not v1).
4. **Filename edge cases** — branch names with `/`, detached HEAD (short SHA),
   duplicate slugs across runs (overwrite is intended).
