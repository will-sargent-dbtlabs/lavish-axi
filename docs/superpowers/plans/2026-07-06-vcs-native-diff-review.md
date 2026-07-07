# VCS-native diff review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `lavish-axi review` command that reads the real `git diff` and renders it as a self-contained, annotatable Lavish artifact, so the agent never hand-authors a code diff.

**Architecture:** `review` is a thin front-end over the existing open→serve→poll pipeline: `git-diff.js` shells out to git and returns structured diff data, `diff-artifact.js` renders that data to self-contained HTML carrying `data-*` line attributes, and `cli.js` writes the file then delegates to a new shared `openResolved()` helper. The SDK gains a small `resolveDiffLine()` that turns a clicked/selected diff line into a `{type:"diff-line",file,line,side}` annotation target — which flows to `poll` untouched because `session-store.js` deep-clones targets.

**Tech Stack:** Node ≥22 ESM, `node:test`, `node:child_process` `spawnSync`, esbuild build → `dist/cli.mjs`, eslint + prettier + tsc(checkJs).

## Global Constraints

- Node ESM only (`"type":"module"`); source is `.js` validated by `tsc --noEmit` (checkJs). Use JSDoc types where the codebase does.
- No new runtime dependencies. `git-diff.js` uses `node:child_process` `spawnSync` with **argument arrays only** (never string interpolation / shell).
- The diff artifact must be **self-contained** (own inline CSS, no CDN, renders offline) and set `<meta name="lavish-design" content="off">` so no Tailwind is injected.
- Do **not** modify `src/session-store.js` or `src/server.js`.
- TDD: failing test first, then minimal code. Tests use `node --test`; server/CLI tests set `LAVISH_AXI_STATE_DIR` and ephemeral ports.
- Run against dev build with `npm run build` then `node dist/cli.mjs`. Full gate before ship: `npm run check`.
- Brand/copy: lowercase `dbt` etc. do not apply here (technical identifiers only).

---

### Task 1: Unified-diff parser (`src/git-diff.js`, pure function)

**Files:**

- Create: `src/git-diff.js`
- Test: `test/git-diff.test.js`

**Interfaces:**

- Produces: `parseUnifiedDiff(text: string): FileDiff[]` where
  `FileDiff = { path, oldPath, status, hunks: Hunk[] }`,
  `Hunk = { oldStart, newStart, lines: Line[] }`,
  `Line = { side: "old"|"new"|"context", lineNo: number, content: string }`.

- [ ] **Step 1: Write the failing test**

```js
// test/git-diff.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../src/git-diff.js";

const SAMPLE = `diff --git a/src/foo.js b/src/foo.js
index e69de29..4b825dc 100644
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

test("parseUnifiedDiff: single modified file with add/remove/context", () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/foo.js");
  assert.equal(files[0].status, "modified");
  const lines = files[0].hunks[0].lines;
  // context a=1 (old1/new1), remove b=2 (old2), add b=3 (new2), add c=4 (new3), context d=5
  assert.deepEqual(
    lines.map((l) => [l.side, l.lineNo, l.content]),
    [
      ["context", 1, "const a = 1;"],
      ["old", 2, "const b = 2;"],
      ["new", 2, "const b = 3;"],
      ["new", 3, "const c = 4;"],
      ["context", 5, "const d = 5;"],
    ],
  );
});

test("parseUnifiedDiff: added and deleted files carry status", () => {
  const added = parseUnifiedDiff(
    `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
`,
  );
  assert.equal(added[0].status, "added");
  const deleted = parseUnifiedDiff(
    `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`,
  );
  assert.equal(deleted[0].status, "deleted");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/git-diff.test.js`
Expected: FAIL — `parseUnifiedDiff` not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

```js
// src/git-diff.js

/**
 * @typedef {{ side: "old"|"new"|"context", lineNo: number, content: string }} DiffLine
 * @typedef {{ oldStart: number, newStart: number, lines: DiffLine[] }} Hunk
 * @typedef {{ path: string, oldPath: string, status: string, hunks: Hunk[] }} FileDiff
 */

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse `git diff` unified output into structured per-file data.
 * @param {string} text
 * @returns {FileDiff[]}
 */
export function parseUnifiedDiff(text) {
  /** @type {FileDiff[]} */
  const files = [];
  /** @type {FileDiff | null} */
  let file = null;
  /** @type {Hunk | null} */
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of text.split("\n")) {
    const gitHeader = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gitHeader) {
      file = { path: gitHeader[2], oldPath: gitHeader[1], status: "modified", hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from") || raw.startsWith("rename to")) {
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    if (raw.startsWith("index ") || raw.startsWith("Binary ")) {
      if (raw.startsWith("Binary ")) file.status = "binary";
      continue;
    }
    const h = raw.match(HUNK_RE);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ side: "new", lineNo: newNo, content });
      newNo += 1;
    } else if (marker === "-") {
      hunk.lines.push({ side: "old", lineNo: oldNo, content });
      oldNo += 1;
    } else if (marker === " ") {
      hunk.lines.push({ side: "context", lineNo: oldNo, content });
      oldNo += 1;
      newNo += 1;
    }
    // "\ No newline at end of file" and blank trailing line: ignore
  }
  return files;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/git-diff.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/git-diff.js test/git-diff.test.js
git commit -m "feat(review): unified diff parser"
```

---

### Task 2: git integration in `src/git-diff.js`

**Files:**

- Modify: `src/git-diff.js`
- Test: `test/git-diff.test.js`

**Interfaces:**

- Consumes: `parseUnifiedDiff` (Task 1).
- Produces:
  - `resolveRange(args: string[], cwd: string): { base: string|null, range: string|null }`
  - `readDiff({ cwd, base, range }): FileDiff[]` — resolves default branch + merge-base when `base`/`range` absent, shells out to git, appends untracked files as all-added `FileDiff`s. Throws `AxiError` on git errors.

Note: `AxiError` is imported from `axi-sdk-js`.

- [ ] **Step 1: Write the failing test** (fixture repo helper + cases)

```js
// append to test/git-diff.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readDiff } from "../src/git-diff.js";

function git(cwd, ...a) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "lavish-diff-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("readDiff: branch changes vs merge-base include uncommitted", () => {
  const dir = makeRepo();
  try {
    git(dir, "checkout", "-q", "-b", "feat");
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n"); // uncommitted edit
    const files = readDiff({ cwd: dir, base: null, range: null });
    const a = files.find((f) => f.path === "a.txt");
    assert.ok(a, "a.txt present");
    assert.ok(a.hunks[0].lines.some((l) => l.side === "new" && l.content === "TWO"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDiff: untracked files appear as added", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    const files = readDiff({ cwd: dir, base: "main", range: null });
    const n = files.find((f) => f.path === "new.txt");
    assert.ok(n, "untracked file present");
    assert.equal(n.status, "added");
    assert.ok(n.hunks[0].lines.some((l) => l.side === "new" && l.content === "fresh"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDiff: throws outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "lavish-nogit-"));
  try {
    assert.throws(() => readDiff({ cwd: dir, base: null, range: null }), /not a git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/git-diff.test.js`
Expected: FAIL — `readDiff` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/git-diff.js`)

```js
import { spawnSync } from "node:child_process";
import { AxiError } from "axi-sdk-js";

function runGit(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error && /** @type {any} */ (r.error).code === "ENOENT") {
    throw new AxiError("git is not installed or not on PATH", "VALIDATION_ERROR", ["Install git and retry"]);
  }
  return r;
}

function assertRepo(cwd) {
  const r = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (r.status !== 0 || r.stdout.trim() !== "true") {
    throw new AxiError("not a git repository", "VALIDATION_ERROR", [
      "Run `lavish-axi review` from inside a git repository",
    ]);
  }
}

function detectDefaultBranch(cwd) {
  const sym = runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (sym.status === 0 && sym.stdout.trim()) {
    return sym.stdout.trim().replace(/^refs\/remotes\//, "");
  }
  for (const b of ["main", "master"]) {
    if (runGit(cwd, ["rev-parse", "--verify", "--quiet", b]).status === 0) return b;
  }
  throw new AxiError("could not determine a default branch", "VALIDATION_ERROR", [
    "No origin/HEAD, main, or master found. Pass an explicit ref, e.g. `lavish-axi review <ref>`",
  ]);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ base: string|null, range: string|null }}
 */
export function resolveRange(args, cwd) {
  const positional = args.find((a) => !a.startsWith("-"));
  if (!positional) return { base: null, range: null };
  if (positional.includes("..")) return { base: null, range: positional };
  return { base: positional, range: null };
}

/**
 * @param {{ cwd: string, base: string|null, range: string|null }} opts
 * @returns {import("./git-diff.js").FileDiff[]}
 */
export function readDiff({ cwd, base, range }) {
  assertRepo(cwd);
  let diffArg;
  if (range) {
    diffArg = range;
  } else {
    const b = base || detectDefaultBranch(cwd);
    const mb = runGit(cwd, ["merge-base", "HEAD", b]);
    if (mb.status !== 0) {
      throw new AxiError(`could not find a merge-base with ${b}`, "VALIDATION_ERROR", [mb.stderr.trim()]);
    }
    diffArg = mb.stdout.trim();
  }
  const diff = runGit(cwd, ["diff", "--no-color", "-M", "-U3", diffArg]);
  if (diff.status !== 0) {
    throw new AxiError(`git diff failed for ${diffArg}`, "VALIDATION_ERROR", [diff.stderr.trim()]);
  }
  const files = parseUnifiedDiff(diff.stdout);

  // Untracked files: enumerate and synthesize as all-added (do not mutate the index).
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.status === 0) {
    for (const rel of untracked.stdout.split("\n").filter(Boolean)) {
      const emptyToFile = runGit(cwd, ["diff", "--no-color", "--no-index", "/dev/null", rel]);
      const parsed = parseUnifiedDiff(
        emptyToFile.stdout.replace(/^diff --git a\/dev\/null b\/(.+)$/m, "diff --git a/$1 b/$1"),
      );
      for (const f of parsed) {
        f.path = rel;
        f.oldPath = rel;
        f.status = "added";
        files.push(f);
      }
    }
  }
  return files;
}
```

Note on `--no-index` header: git emits `diff --git a/dev/null b/<file>` for untracked; the regex normalizes the path so `parseUnifiedDiff` records the real file path. Verify against the fixture and adjust the normalization if git's exact header differs on the target platform.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/git-diff.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/git-diff.js test/git-diff.test.js
git commit -m "feat(review): git range resolution + readDiff with untracked files"
```

---

### Task 3: Diff artifact renderer (`src/diff-artifact.js`)

**Files:**

- Create: `src/diff-artifact.js`
- Test: `test/diff-artifact.test.js`

**Interfaces:**

- Consumes: `FileDiff[]` (Task 1/2 shape).
- Produces: `renderDiffArtifact(files: FileDiff[], opts?: { title?: string }): string` — a complete HTML document string. Each diff line is a `<div class="dl dl-<side>" data-diff-line data-file="..." data-line="N" data-side="old|new|context">`.

- [ ] **Step 1: Write the failing test**

```js
// test/diff-artifact.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDiffArtifact } from "../src/diff-artifact.js";

const FILES = [
  {
    path: "src/foo.js",
    oldPath: "src/foo.js",
    status: "modified",
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { side: "context", lineNo: 1, content: "const a = 1;" },
          { side: "new", lineNo: 2, content: "const b = 3; // <script>" },
        ],
      },
    ],
  },
];

test("renderDiffArtifact: emits data-* line attrs and escapes content", () => {
  const html = renderDiffArtifact(FILES, { title: "Review" });
  assert.match(html, /<meta name="lavish-design" content="off">/);
  assert.match(html, /data-diff-line/);
  assert.match(html, /data-file="src\/foo\.js"/);
  assert.match(html, /data-line="2"/);
  assert.match(html, /data-side="new"/);
  // HTML escaped
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/i); // no raw injection from content
});

test("renderDiffArtifact: binary file shows a notice, not lines", () => {
  const html = renderDiffArtifact([{ path: "img.png", oldPath: "img.png", status: "binary", hunks: [] }]);
  assert.match(html, /binary — not shown/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/diff-artifact.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/diff-artifact.js

/** @param {string} s */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** @param {import("./git-diff.js").FileDiff} file */
function renderFile(file) {
  const header = `<h2 class="df-head">${esc(file.path)}<span class="df-status">${esc(file.status)}</span></h2>`;
  if (file.status === "binary") {
    return `<section class="df">${header}<p class="df-binary">binary — not shown</p></section>`;
  }
  const rows = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const sign = line.side === "new" ? "+" : line.side === "old" ? "-" : " ";
      rows.push(
        `<div class="dl dl-${line.side}" data-diff-line data-file="${esc(file.path)}" data-line="${line.lineNo}" data-side="${line.side}">` +
          `<span class="dl-no">${line.lineNo}</span><span class="dl-sign">${sign}</span>` +
          `<span class="dl-code">${esc(line.content)}</span></div>`,
      );
    }
  }
  return `<section class="df">${header}<div class="df-body">${rows.join("")}</div></section>`;
}

/**
 * @param {import("./git-diff.js").FileDiff[]} files
 * @param {{ title?: string }} [opts]
 * @returns {string}
 */
export function renderDiffArtifact(files, opts = {}) {
  const title = opts.title || "Diff review";
  const fileList = files.map((f) => `<li>${esc(f.path)}</li>`).join("");
  const body = files.map(renderFile).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="lavish-design" content="off">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --add:#e6ffed; --del:#ffeef0; --add-fg:#22863a; --del-fg:#b31d28; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; color:#1b1f24; background:#fff; }
  main { max-width:1000px; margin:0 auto; padding:24px; }
  h1 { font-size:20px; }
  .df-files { color:#57606a; font-size:13px; }
  .df { border:1px solid #d0d7de; border-radius:8px; margin:16px 0; overflow:hidden; }
  .df-head { display:flex; justify-content:space-between; margin:0; padding:8px 12px; font:600 13px ui-monospace,monospace; background:#f6f8fa; border-bottom:1px solid #d0d7de; }
  .df-status { color:#57606a; font-weight:400; }
  .df-binary { padding:12px; color:#57606a; }
  .df-body { font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .dl { display:grid; grid-template-columns:48px 16px 1fr; white-space:pre-wrap; word-break:break-word; }
  .dl-no { color:#8c959f; text-align:right; padding-right:8px; user-select:none; }
  .dl-sign { user-select:none; }
  .dl-new { background:var(--add); } .dl-new .dl-sign { color:var(--add-fg); }
  .dl-old { background:var(--del); } .dl-old .dl-sign { color:var(--del-fg); }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<ul class="df-files">${fileList}</ul>
${body}
</main>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/diff-artifact.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diff-artifact.js test/diff-artifact.test.js
git commit -m "feat(review): self-contained diff artifact renderer"
```

---

### Task 4: `review` command + `openResolved` refactor (`src/cli.js`)

**Files:**

- Modify: `src/cli.js` — `COMMANDS` set (`:17`), dispatch map (`:53-62`), extract `openResolved`, add `reviewCommand`, `TOP_LEVEL_HELP` (`:785`), `COMMAND_HELP` (`:787`).
- Test: `test/cli-output.test.js`

**Interfaces:**

- Consumes: `readDiff`, `resolveRange` (git-diff.js); `renderDiffArtifact` (diff-artifact.js); existing `ensureServer`, `postJson`, `shouldOpenBrowser`, `resolveThemeFlag`, `resolveAnnotateFlag`, `canonicalFile`, `createOpenOutput`.
- Produces: `reviewCommand(args)`; `openResolved({ absolute, noGate, annotate, theme, open })`.

- [ ] **Step 1: Write the failing test**

```js
// add to test/cli-output.test.js (follows existing spawn-the-CLI pattern in that file)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.mjs", import.meta.url).pathname;

test("review: errors clearly outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "lavish-review-nogit-"));
  try {
    const r = spawnSync("node", [CLI, "review", "--no-open"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /not a git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

(Additional cases — empty diff friendly message, annotate-default-on — can be added once the server-backed test harness in this file is reused; keep this task's required test to the non-repo path which needs no server.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-output.test.js`
Expected: FAIL — `review` is not a known command (bare-arg normalization would treat it as a file → different error), so assert currently fails.

- [ ] **Step 3: Implement**

3a. Add `"review"` to the set at `src/cli.js:17`:

```js
const COMMANDS = new Set(["open", "poll", "end", "stop", "server", "playbook", "design", "setup", "review"]);
```

3b. Add to the dispatch map (`:53-62`):

```js
        server: serverCommand,
        review: reviewCommand,
```

3c. Extract the reusable open tail. Replace the body of `openCommand` (`:165-186`) so it parses then calls the helper, and add `openResolved` + `reviewCommand` after it:

```js
async function openCommand(args) {
  const file = args.find((arg) => !arg.startsWith("-"));
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  return openResolved({
    absolute,
    noGate: args.includes("--no-gate"),
    annotate: resolveAnnotateFlag(args),
    theme: resolveThemeFlag(args),
    open: shouldOpenBrowser(args, process.env),
  });
}

async function openResolved({ absolute, noGate, annotate, theme, open }) {
  const baseUrl = await ensureServer({ forceRestart: shouldForceRestartForLocalBuild(process.argv[1] || "") });
  const response = await postJson(`${baseUrl}/api/sessions`, { file: absolute, noGate, annotate, theme });
  if (open) {
    try {
      const openFn = (await import("open")).default;
      await openFn(response.url);
    } catch {
      response.status = "ready";
    }
  }
  return createOpenOutput({ file: absolute, url: response.url, status: response.status || "opened" });
}

async function reviewCommand(args) {
  const cwd = process.cwd();
  const { base, range } = resolveRange(args, cwd);
  const files = readDiff({ cwd, base, range });
  if (files.length === 0) {
    return {
      review: { files: 0, message: `No changes to review between ${base || range || "the merge-base"} and HEAD` },
    };
  }
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  const nameFlag = flagValue(args, "--name");
  const slug = (nameFlag || branch || "head").replace(/[^A-Za-z0-9._-]+/g, "-") || "head";
  const dir = path.join(cwd, ".lavish");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `review-${slug}.html`);
  writeFileSync(filePath, renderDiffArtifact(files, { title: `Review: ${branch || range || base}` }));
  const absolute = await canonicalFile(filePath);
  const annotateFlag = resolveAnnotateFlag(args);
  return openResolved({
    absolute,
    noGate: args.includes("--no-gate"),
    annotate: annotateFlag === undefined ? true : annotateFlag, // review defaults annotate ON
    theme: resolveThemeFlag(args),
    open: shouldOpenBrowser(args, process.env),
  });
}
```

3d. Add imports at the top of `src/cli.js` (with the other local imports):

```js
import { readDiff, resolveRange } from "./git-diff.js";
import { renderDiffArtifact } from "./diff-artifact.js";
```

3e. Add a `review` usage line to `TOP_LEVEL_HELP` (`:785`) and an entry to `COMMAND_HELP` (`:787`):

```js
  review: `Usage: lavish-axi review [<ref-or-range>] [--name <slug>] [--no-open] [--no-gate] [--theme <id>] [--no-annotate]\n\nRead the current git diff and open it as an annotatable Lavish review artifact. With no ref, diffs this branch against its merge-base with the default branch (origin/HEAD, else main/master), including uncommitted and untracked changes. Pass a ref (\`review main\`) or range (\`review a..b\`) to override. Annotation is ON by default; use --no-annotate to disable. Click or select a diff line to attach a precise file:line comment for the agent.\n`,
```

Also update the `playbook` help line's known IDs only if needed (unchanged here).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-output.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli-output.test.js
git commit -m "feat(review): review command + shared openResolved helper"
```

---

### Task 5: Diff-line annotation capture (`src/artifact-sdk.js`)

**Files:**

- Modify: `src/artifact-sdk.js` — add `resolveDiffLine` near `selector`/`context` (`~:130-162`); extend `context` (click path) and `textSelectionContext` (`:191-219`).
- Test: `test/artifact-sdk.test.js`

**Interfaces:**

- Produces: annotations whose `target` is `{ type:"diff-line", file, line, side, text? }` when the annotated node is inside a `[data-diff-line]` element.

**How it reaches the agent:** `context`/`textSelectionContext` set `target`; `queuePrompt(prompt,{...c})` carries it; `SessionStore.normalizeTarget` deep-clones it; `poll` returns `prompts[].target`. No session-store change.

- [ ] **Step 1: Write the failing test**

Check how `test/artifact-sdk.test.js` loads the SDK (it evaluates the module against a jsdom-like or hand-rolled DOM stub — follow the file's existing pattern). Add:

```js
// in test/artifact-sdk.test.js, using the file's existing DOM harness
test("resolveDiffLine returns file/line/side from a data-diff-line ancestor", () => {
  // Arrange a DOM: <div data-diff-line data-file="src/x.js" data-line="7" data-side="new"><span id="code">..</span></div>
  // Act: call the SDK's exported resolveDiffLine (or trigger a click and inspect the queued prompt target)
  // Assert: target === { type:"diff-line", file:"src/x.js", line:7, side:"new" }
});
```

Implementation note: if `artifact-sdk.js` is a single browser IIFE with nothing exported, expose `resolveDiffLine` for test via the same mechanism the file already uses to make internals testable (check the top of the existing test file). If none exists, test through the public capture path (simulate click → assert `postMessage`/queued prompt payload `target`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/artifact-sdk.test.js`
Expected: FAIL — no diff-line target produced.

- [ ] **Step 3: Implement**

3a. Add near `context` (`src/artifact-sdk.js:~155`):

```js
function resolveDiffLine(el) {
  const line = el && el.closest ? el.closest("[data-diff-line]") : null;
  if (!line) return null;
  return {
    type: "diff-line",
    file: line.getAttribute("data-file"),
    line: Number(line.getAttribute("data-line")),
    side: line.getAttribute("data-side"),
  };
}
```

3b. Extend `context` (`:155-162`) to attach the target on the click path:

```js
function context(el) {
  const dl = resolveDiffLine(el);
  return {
    uid: uid(el),
    selector: selector(el),
    tag: dl ? "diff-line" : (el.tagName || "").toLowerCase(),
    text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    ...(dl ? { target: dl } : {}),
  };
}
```

3c. In `textSelectionContext` (`:191-219`), before returning, resolve a diff line from `ancestor`; when found, prefer a precise `diff-line` target carrying the selected text:

```js
const dl = resolveDiffLine(ancestor);
if (dl) {
  dl.text = text.slice(0, 240);
  return {
    uid: "",
    selector: commonAncestorSelector,
    tag: "diff-line",
    text: text.slice(0, 240),
    target: dl,
    element: ancestor,
    range: range.cloneRange(),
  };
}
// (existing text-range target + return unchanged below)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/artifact-sdk.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/artifact-sdk.js test/artifact-sdk.test.js
git commit -m "feat(review): capture diff-line targets on click and selection"
```

---

### Task 6: Amend `code` playbook + regenerate skill

**Files:**

- Modify: `src/playbooks.js` (`code` playbook, `:118-178`)
- Regenerate: `skills/lavish/SKILL.md` via `npm run build:skill`
- Test: `test/skill.test.js` (freshness already covered by `build:skill --check`)

- [ ] **Step 1: Add the leading note** to the `code` playbook object. Find its `use_when` / body and prepend guidance:

```js
    // inside the `code` playbook object, e.g. as the first line of its guidance/body:
    "When reviewing a real git working state, prefer `lavish-axi review` — it reads the diff for you and renders an annotatable surface. Hand-author @pierre/diffs HTML only for synthetic or illustrative snippets, or non-git code.",
```

(Insert in the field the playbook uses for narrative guidance; keep the existing `@pierre/diffs` instructions intact for the illustrative case.)

- [ ] **Step 2: Regenerate the skill and verify freshness**

Run: `npm run build:skill && node scripts/build-skill.js --check`
Expected: SKILL.md regenerated; `--check` exits 0.

- [ ] **Step 3: Run the skill test**

Run: `node --test test/skill.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/playbooks.js skills/lavish/SKILL.md
git commit -m "docs(review): point code playbook at review; regenerate skill"
```

---

### Task 7: End-to-end + full gate

**Files:**

- Test: `test/server.test.js` (extend)

- [ ] **Step 1: Add an end-to-end test** following the file's `LAVISH_AXI_STATE_DIR`+ephemeral-port harness: write a rendered diff artifact to a temp file, POST `/api/sessions`, GET `/artifact/:key/index.html`, assert the served HTML contains `data-diff-line`; POST a prompt with `target:{type:"diff-line",file:"src/foo.js",line:2,side:"new"}`, then GET `/api/poll` and assert the returned prompt's `target` matches (proves deep-clone passthrough end-to-end).

- [ ] **Step 2: Run the full gate**

Run: `npm run check`
Expected: build + lint + prettier + typecheck + all tests + skill-freshness all PASS. Fix any prettier/eslint/tsc issues (e.g. add JSDoc types) until green.

- [ ] **Step 3: Commit**

```bash
git add test/server.test.js
git commit -m "test(review): end-to-end diff-line target through poll"
```

---

## Self-review notes

- **Spec coverage:** command surface (T4), git range+untracked (T2), parser (T1), self-render + data attrs + escaping + binary (T3), annotate-on default (T4), dual-path capture (T5), session-store unchanged (T5 note + T7 e2e), playbook amend + skill (T6), tests per spec §7 (T1–T7). openResolved refactor (T4).
- **Deferred/uncertain, verify during impl:** exact git `--no-index` header for untracked normalization (T2 note); how `artifact-sdk.js` exposes internals for unit test vs testing through the public path (T5 note); precise field name in the `code` playbook object for narrative guidance (T6).
- **YAGNI:** no syntax highlighting, no jj/Sapling, no round-delta — all out per spec non-goals.
