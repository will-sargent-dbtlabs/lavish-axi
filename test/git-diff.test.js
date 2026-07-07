import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { parseUnifiedDiff, readDiff, resolveRange } from "../src/git-diff.js";

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
  assert.deepEqual(
    lines.map((l) => [l.side, l.lineNo, l.content]),
    [
      ["context", 1, "const a = 1;"],
      ["old", 2, "const b = 2;"],
      ["new", 2, "const b = 3;"],
      ["new", 3, "const c = 4;"],
      ["context", 4, "const d = 5;"],
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

test("resolveRange: no args, base ref, and explicit range", () => {
  assert.deepEqual(resolveRange([]), { base: null, range: null });
  assert.deepEqual(resolveRange(["main"]), { base: "main", range: null });
  assert.deepEqual(resolveRange(["--no-open", "a..b"]), { base: null, range: "a..b" });
});

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

test("readDiff: branch changes vs merge-base include uncommitted edits", () => {
  const dir = makeRepo();
  try {
    git(dir, "checkout", "-q", "-b", "feat");
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
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
    writeFileSync(join(dir, "new.txt"), "fresh\nlines\n");
    const files = readDiff({ cwd: dir, base: "main", range: null });
    const n = files.find((f) => f.path === "new.txt");
    assert.ok(n, "untracked file present");
    assert.equal(n.status, "added");
    assert.deepEqual(
      n.hunks[0].lines.map((l) => [l.side, l.lineNo, l.content]),
      [
        ["new", 1, "fresh"],
        ["new", 2, "lines"],
      ],
    );
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
