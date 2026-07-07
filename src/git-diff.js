import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AxiError } from "axi-sdk-js";

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
    if (raw.startsWith("Binary ")) {
      file.status = "binary";
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ")) continue;
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
      // context lines carry the new-side number (the line as it exists in the
      // reviewed state), matching added lines; removed lines use the old number.
      hunk.lines.push({ side: "context", lineNo: newNo, content });
      oldNo += 1;
      newNo += 1;
    }
    // "\ No newline at end of file" and trailing blank line: ignored.
  }
  return files;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runGit(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT") {
    throw new AxiError("git is not installed or not on PATH", "VALIDATION_ERROR", ["Install git and retry"]);
  }
  return r;
}

/** @param {string} cwd */
function assertRepo(cwd) {
  const r = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (r.status !== 0 || r.stdout.trim() !== "true") {
    throw new AxiError("not a git repository", "VALIDATION_ERROR", [
      "Run `lavish-axi review` from inside a git repository",
    ]);
  }
}

/** @param {string} cwd */
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
 * Resolve CLI args into a base ref or an explicit range.
 * @param {string[]} args
 * @returns {{ base: string|null, range: string|null }}
 */
export function resolveRange(args) {
  const positional = args.find((a) => !a.startsWith("-"));
  if (!positional) return { base: null, range: null };
  if (positional.includes("..")) return { base: null, range: positional };
  return { base: positional, range: null };
}

/** @param {Buffer} buf */
function looksBinary(buf) {
  const scan = buf.subarray(0, 8000);
  return scan.includes(0);
}

/**
 * Read the current git diff as structured per-file data.
 * Default (no base/range): merge-base of HEAD and the default branch vs the
 * working tree, plus untracked files rendered as added.
 * @param {{ cwd: string, base: string|null, range: string|null }} opts
 * @returns {FileDiff[]}
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
  if (diff.status !== 0 && diff.status !== null && diff.stderr) {
    throw new AxiError(`git diff failed for ${diffArg}`, "VALIDATION_ERROR", [diff.stderr.trim()]);
  }
  const files = parseUnifiedDiff(diff.stdout || "");

  // Untracked files never appear in `git diff`; synthesize them as all-added
  // by reading their content directly (no index mutation).
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.status === 0) {
    for (const rel of untracked.stdout.split("\n").filter(Boolean)) {
      let buf;
      try {
        buf = readFileSync(join(cwd, rel));
      } catch {
        continue;
      }
      if (looksBinary(buf)) {
        files.push({ path: rel, oldPath: rel, status: "binary", hunks: [] });
        continue;
      }
      const lines = buf.toString("utf8").split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      files.push({
        path: rel,
        oldPath: rel,
        status: "added",
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: lines.map((content, i) => ({ side: "new", lineNo: i + 1, content })),
          },
        ],
      });
    }
  }

  return files;
}
