/** @param {unknown} s */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** @param {import("./git-diff.js").FileDiff} file */
function renderFile(file) {
  const header = `<h2 class="df-head"><span class="df-path">${esc(file.path)}</span><span class="df-status df-${esc(file.status)}">${esc(file.status)}</span></h2>`;
  if (file.status === "binary") {
    return `<section class="df">${header}<p class="df-binary">binary — not shown</p></section>`;
  }
  const rows = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const sign = line.side === "new" ? "+" : line.side === "old" ? "-" : " ";
      rows.push(
        `<div class="dl dl-${line.side}" data-diff-line data-file="${esc(file.path)}" data-line="${line.lineNo}" data-side="${line.side}">` +
          `<span class="dl-no">${line.lineNo}</span>` +
          `<span class="dl-sign">${sign}</span>` +
          `<span class="dl-code">${esc(line.content)}</span>` +
          `</div>`,
      );
    }
  }
  const body = rows.length
    ? `<div class="df-body">${rows.join("")}</div>`
    : `<p class="df-binary">no textual changes</p>`;
  return `<section class="df">${header}${body}</section>`;
}

/**
 * Render structured diff data into a self-contained, annotatable HTML artifact.
 * Each diff line carries data-diff-line / data-file / data-line / data-side so
 * the Lavish SDK can attach a precise file:line annotation target.
 * @param {import("./git-diff.js").FileDiff[]} files
 * @param {{ title?: string }} [opts]
 * @returns {string}
 */
export function renderDiffArtifact(files, opts = {}) {
  const title = opts.title || "Diff review";
  const counts = files.reduce(
    (acc, f) => {
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.side === "new") acc.add += 1;
          else if (l.side === "old") acc.del += 1;
        }
      }
      return acc;
    },
    { add: 0, del: 0 },
  );
  const fileList = files.map((f) => `<li>${esc(f.path)}</li>`).join("");
  const body = files.map(renderFile).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="lavish-design" content="off">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1f2328; background: #ffffff; }
  main { max-width: 1000px; margin: 0 auto; padding: 28px 24px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .df-summary { color: #59636e; font-size: 13px; margin: 0 0 20px; }
  .df-summary .add { color: #1a7f37; font-weight: 600; }
  .df-summary .del { color: #cf222e; font-weight: 600; }
  ul.df-files { margin: 0 0 24px; padding-left: 18px; color: #59636e; font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .df { border: 1px solid #d1d9e0; border-radius: 8px; margin: 0 0 16px; overflow: hidden; }
  .df-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 0; padding: 8px 12px; font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; border-bottom: 1px solid #d1d9e0; }
  .df-path { overflow-wrap: anywhere; }
  .df-status { flex: none; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #59636e; }
  .df-added { color: #1a7f37; } .df-deleted { color: #cf222e; } .df-renamed { color: #9a6700; }
  .df-binary { padding: 12px; color: #59636e; margin: 0; }
  .df-body { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; }
  .dl { display: grid; grid-template-columns: 52px 18px minmax(0, 1fr); white-space: pre-wrap; overflow-wrap: anywhere; }
  .dl-no { color: #8c959f; text-align: right; padding-right: 10px; user-select: none; }
  .dl-sign { user-select: none; text-align: center; }
  .dl-code { min-width: 0; }
  .dl-new { background: #e6ffec; } .dl-new .dl-sign { color: #1a7f37; }
  .dl-old { background: #ffebe9; } .dl-old .dl-sign { color: #cf222e; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="df-summary">${files.length} file${files.length === 1 ? "" : "s"} · <span class="add">+${counts.add}</span> / <span class="del">−${counts.del}</span></p>
<ul class="df-files">${fileList}</ul>
${body}
</main>
</body>
</html>`;
}
