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
          { side: "new", lineNo: 2, content: "const b = 3; // <script>alert(1)</script>" },
        ],
      },
    ],
  },
];

test("renderDiffArtifact: emits data-* line attrs and stays design-off", () => {
  const html = renderDiffArtifact(FILES, { title: "Review" });
  assert.match(html, /<meta name="lavish-design" content="off">/);
  assert.match(html, /data-diff-line data-file="src\/foo\.js" data-line="2" data-side="new"/);
  assert.match(html, /data-line="1" data-side="context"/);
});

test("renderDiffArtifact: escapes HTML in line content (no raw injection)", () => {
  const html = renderDiffArtifact(FILES);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("renderDiffArtifact: binary file shows a notice, not lines", () => {
  const html = renderDiffArtifact([{ path: "img.png", oldPath: "img.png", status: "binary", hunks: [] }]);
  assert.match(html, /binary — not shown/);
  assert.doesNotMatch(html, /data-diff-line/);
});

test("renderDiffArtifact: summary counts additions and deletions", () => {
  const html = renderDiffArtifact([
    {
      path: "x",
      oldPath: "x",
      status: "modified",
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { side: "old", lineNo: 1, content: "a" },
            { side: "new", lineNo: 1, content: "b" },
            { side: "new", lineNo: 2, content: "c" },
          ],
        },
      ],
    },
  ]);
  assert.match(html, /\+2/);
  assert.match(html, /−1/);
});
