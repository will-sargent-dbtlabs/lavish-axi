# VCS-native diff review (`lavish-axi review`)

- **Date:** 2026-07-06
- **Repo:** `will-sargent-dbtlabs/lavish-axi` (fork of `kunchenguid/lavish-axi`)
- **Status:** Design / spec — not yet implemented
- **Fork feature #:** 6 (follows the five shipped features documented in `docs/prd-fork-features.md`)

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
  merge-base, including uncommitted work.
- Diff-line annotations reach the agent as precise `file:line:side`.
- Reuse the existing open → serve → poll pipeline untouched; keep the artifact
  portable/printable/themeable; keep the change additive and low-risk for upstream
  merges (mirror the `/print` feature's isolation).

## Non-goals (YAGNI)

- jj / Sapling support — git only for v1 (Crit has these; defer).
- Automatic round-to-round delta tracking / persistent cross-round threads —
  re-running `review` regenerates the current diff; that is sufficient for v1.
  Persistent cross-round threads is a separate future feature.
- Crit's "Live mode" localhost proxy — unrelated to diffs, out of scope.

## Decisions (settled during brainstorming)

1. **Render owner:** lavish generates a real artifact **file**, then delegates to
   the existing session pipeline. (Not a live server-rendered route — keeps the
   session=file invariant and minimizes upstream-merge risk.)
2. **Default diff:** branch vs auto-detected default branch's merge-base, plus
   uncommitted changes. Explicit ref/range overrides.
3. **Annotation anchoring (option C):** emit `data-file` / `data-line` /
   `data-side` attributes on rendered diff lines; the SDK reads them into the
   annotation `target`. **No change to the shared normalization** —
   `session-store.js` `normalizeTarget` (`:207`) deep-clones `target` as-is, so a
   `{type:"diff-line", file, line, side}` object flows through to `poll` untouched.

## Architecture

`review` is a thin front-end: a **git-diff-to-file preprocessing step** in front of
the existing `openCommand` flow. It produces `.lavish/review-<branch>.html`, then
hands that file to the unchanged session-creation + serve + browser-open + poll
pipeline. Nothing downstream (`poll`, `end`, `stop`, `/print`, themes) knows the
file came from git.

Two new isolated modules, each with one clear purpose and independently testable:

- **`src/git-diff.js`** — resolves the ref range, shells out to git, returns
  **structured diff data** (no HTML). Testable with fixture repos, zero DOM.
- **`src/diff-artifact.js`** — turns diff data into a self-contained HTML artifact
  via `@pierre/diffs`. Testable with fixture data, zero git.

This split is the key isolation boundary: git logic never touches the DOM, and the
renderer never touches git.

### 1. Command surface — `src/cli.js`

```
lavish-axi review [<ref-or-range>] [flags]
```

- No args → branch-vs-merge-base + uncommitted.
- `review main` → diff against that ref's merge-base with HEAD.
- `review abc123..def456` → explicit range passed to git.
- Flags reuse existing resolvers and flow straight into the open path:
  `--theme`, `--no-gate`, `--no-open`, `--no-annotate`.
- New flag `--name <slug>` → controls the artifact filename (default derived from
  the current branch name, sanitized).

Wiring (same pattern as every other command):

- Add `"review"` to the `COMMANDS` set (`src/cli.js:17`).
- Add `review: reviewCommand` to the dispatch map (`src/cli.js:53-62`).
- `async function reviewCommand(args)`: parse flags via `flagValue` (`:769`) /
  `args.includes(...)`; call `resolveRange(args)` → `readDiff()` (git-diff.js) →
  `renderDiffArtifact()` (diff-artifact.js) → write file → delegate to the same
  session/open logic `openCommand` uses.
- Add `review` to `TOP_LEVEL_HELP` (`:785`) and `COMMAND_HELP` (`:787`).
- Bad input throws `AxiError(msg, "VALIDATION_ERROR", [hints])` (import at `:8`).

`reviewCommand` shares the open path with `openCommand` — extract the post-file
open logic into a small shared helper if it isn't already callable, rather than
duplicating it.

### 2. Git integration — `src/git-diff.js` (new)

First VCS shell-out in the product. Uses `node:child_process` `spawnSync` with
**argument arrays** (never string interpolation — no shell-injection surface),
matching the existing `spawnSync("lsof"...)` / `spawnSync("ps"...)` idiom in
`cli.js`.

Range resolution (no-arg default):

1. Detect default branch: `origin/HEAD` (via
   `git symbolic-ref refs/remotes/origin/HEAD`) → else `main` → else `master`.
2. `git merge-base HEAD <base>` → `<mb>`.
3. Collect committed changes `git diff <mb>...HEAD` **and** uncommitted
   `git diff HEAD`, merged per file (uncommitted hunks layered on top).

Explicit arg: if it looks like a range (`a..b` / `a...b`) pass through; otherwise
treat as a base ref and merge-base against HEAD.

Return shape (plain data):

```js
[
  {
    path: "src/foo.js",
    oldPath: "src/foo.js",   // differs on rename
    status: "modified",       // added | modified | deleted | renamed | binary
    hunks: [
      { oldStart, newStart, lines: [ { side, lineNo, content } ] }
    ]
  }
]
```

`side ∈ { "old", "new", "context" }`; `lineNo` is the line number on that side.

Guardrails (all `AxiError` with actionable hints):

- Not a git repo → `"not a git repository"`.
- git not installed / not on PATH → clear error.
- Bad ref/range → surface git's trimmed stderr plus the attempted range.
- Empty diff → friendly `"no changes to review between <base> and HEAD"`; exit
  without opening a surface.

### 3. Rendering — `src/diff-artifact.js` (new)

Turns diff data into a self-contained HTML artifact using the **same
`@pierre/diffs` ESM approach the `code` playbook already mandates**
(`https://esm.sh/@pierre/diffs@1.2.10?bundle`, `File`/`FileDiff`), so output is
consistent with hand-authored code artifacts and works with `/print`, themes, and
direct-open portability.

- Build `@pierre/diffs` `oldFile` / `newFile` inputs from hunk data per file.
- **Stamp `data-file` / `data-line` / `data-side` on each rendered diff line**
  (the option-C mechanism).
  - **Spike first:** determine whether `@pierre/diffs` exposes a per-line render
    hook / annotation API for attributes. If not, post-process its rendered output
    to inject the attrs (contained fallback). This spike is the one real unknown;
    it does not change scope, only implementation tactics.
- Wrap in a real theme shell (default `lavish-light`, honoring `--theme`), with a
  multi-file file-list header. Keep the `lavish-design: off` contract of the theme
  shells intact (no Tailwind layering).
- Binary / pathological files: list as "binary — not shown"; a per-file render
  failure degrades to an in-artifact notice rather than aborting the whole review.

### 4. Annotation flow (option C)

- **`src/artifact-sdk.js`** (element-annotation capture, ~`:158`/`:185`): when the
  annotated element or its nearest ancestor carries `data-file`, read
  `data-file` / `data-line` / `data-side` and attach
  `target: { type: "diff-line", file, line, side }` to the annotation payload.
- **`src/session-store.js`:** **no change.** `normalizeTarget` (`:207`)
  deep-clones `target`, so the `diff-line` target flows through
  `queuePrompts` → `takeFeedback` → `poll` untouched. (This is the entire reason
  option C is cheap; verify the deep-clone behavior holds before relying on it.)
- **`poll` output:** the agent already receives `prompts[].target`. Diff
  annotations arrive as `target.type === "diff-line"` with `file` / `line` /
  `side` — e.g. "src/foo.js:42 (new): tighten this guard" — no snapshot inference.
- Text-range and element annotations on the same artifact keep working exactly as
  before; `diff-line` is purely additive.

### 5. Playbook amendment — `src/playbooks.js:118-178`

The `code` playbook is **amended, not replaced**. Add a leading note: when the code
to review is a real git working state, prefer `lavish-axi review` (it reads the
diff for you) over hand-authoring; hand-author only for synthetic / illustrative
snippets or non-git code. The `@pierre/diffs` guidance stays valid for the
illustrative case.

## Error handling

All failures surface as `AxiError` with actionable hints (codebase idiom):

- Not a git repo / git absent → validation error with hint.
- Bad ref/range → git stderr (trimmed) + attempted range.
- Empty diff → friendly message, no surface opened.
- Per-file render failure (binary, huge, malformed) → skip that file with an
  in-artifact notice; never abort the whole review.

## Testing (`node:test`, per repo convention; `LAVISH_AXI_STATE_DIR` + ephemeral ports for server tests)

- **`test/git-diff.test.js`** (new) — build throwaway fixture repos in a temp dir
  (`git init`, commit, branch, edit); assert range resolution (merge-base,
  `origin/HEAD` → `main` → `master` fallback) and parsed hunk structure. Pure, no
  browser.
- **`test/diff-artifact.test.js`** (new) — feed fixture diff data; assert emitted
  HTML carries correct `data-file` / `data-line` / `data-side` and multi-file
  structure. No git.
- **`test/cli-output.test.js`** (extend) — `review` in a non-repo → validation
  error; empty diff → friendly message; `--no-open` returns the expected object.
- **`test/artifact-sdk.test.js`** (extend) — annotating an element with `data-*`
  attrs → assert `target:{type:"diff-line",...}` is produced.
- **`test/server.test.js`** (extend) — a diff artifact serves and polls end-to-end
  through the unchanged pipeline (proves delegation).
- Full `npm run check` before push (build + eslint + prettier + `tsc` checkJs +
  test + skill freshness). Because we add a command and touch the `code` playbook,
  `npm run build:skill` regenerates `skills/lavish/SKILL.md`; `check` fails on
  drift.

## Files touched

| File | Change |
| --- | --- |
| `src/git-diff.js` | **new** — range resolution + git shell-out → diff data |
| `src/diff-artifact.js` | **new** — diff data → `@pierre/diffs` HTML artifact |
| `src/cli.js` | add `review` command (registry, dispatch, handler, help) |
| `src/artifact-sdk.js` | capture `data-file/line/side` into `diff-line` target |
| `src/playbooks.js` | amend `code` playbook to point at `review` |
| `skills/lavish/SKILL.md` | regenerated via `build:skill` |
| `test/git-diff.test.js` | **new** |
| `test/diff-artifact.test.js` | **new** |
| `test/cli-output.test.js` | extend |
| `test/artifact-sdk.test.js` | extend |
| `test/server.test.js` | extend |

`src/session-store.js` and `src/server.js` are intentionally **not** modified —
the whole point of the design is that neither the shared data model nor the serving
pipeline needs to change.

## Open risks

1. **`@pierre/diffs` per-line attribute hook** — may require DOM post-processing
   fallback. Implementation tactic, not scope. Spike first.
2. **`normalizeTarget` deep-clone assumption** — verify it truly passes arbitrary
   `target` objects through before relying on the no-change claim for
   `session-store.js`.
3. **Merge-base default-branch detection** — repos without `origin/HEAD` and
   without `main`/`master` need a clear error rather than a silent wrong base.
4. **Uncommitted + committed hunk merge** — layering uncommitted changes on top of
   the committed range must not double-count or mis-number lines; covered by
   `git-diff.test.js` fixtures.
