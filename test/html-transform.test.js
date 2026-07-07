import assert from "node:assert/strict";
import test from "node:test";

import { injectLavishSdk, injectPrintScript } from "../src/html-transform.js";

test("injects the Lavish SDK before the closing body tag", () => {
  const html = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.match(result, /<script src="\/sdk\.js\?key=abc123"><\/script><\/body>/);
});

test("does not inject Tailwind or DaisyUI design assets so the saved file stays portable", () => {
  const html = '<!doctype html><html><head><title>Hi</title></head><body><h1 class="btn">Hi</h1></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.doesNotMatch(result, /\/design\/daisyui\.css/);
  assert.doesNotMatch(result, /\/design\/daisyui-themes\.css/);
  assert.doesNotMatch(result, /\/design\/tailwindcss-browser\.js/);
  assert.doesNotMatch(result, /data-lavish-design/);
});

test("leaves the <head> untouched - only the SDK script is appended at end of body", () => {
  const html = "<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(
    result,
    '<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1><script src="/sdk.js?key=abc123"></script></body></html>',
  );
});

test("appends the Lavish SDK when the artifact has no body tag", () => {
  const result = injectLavishSdk("<h1>Hi</h1>", "abc123");

  assert.equal(result, '<h1>Hi</h1>\n<script src="/sdk.js?key=abc123"></script>');
});

test("injects a print script that reveals hidden content then prints, before </body>", () => {
  const html = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  const result = injectPrintScript(html);

  // still calls window.print()
  assert.match(result, /window\.print\(\)/);
  // reveals collapsed disclosures, [hidden], and CSS-only tab panels
  assert.match(result, /details:not\(\[open\]\)/);
  assert.match(result, /removeAttribute\("hidden"\)/);
  assert.match(result, /input\[type=radio\],input\[type=checkbox\]/);
  // injected immediately before the closing body tag
  assert.match(result, /<\/script><\/body><\/html>$/);
});

test("print script labels each broken tab page with its tab name as an <h1>", () => {
  const result = injectPrintScript("<!doctype html><html><body><h1>Hi</h1></body></html>");

  // resolves the tab name from the controlling input's label
  assert.match(result, /label\[for=/);
  // prepends a marked <h1> heading onto each page-broken panel
  assert.match(result, /createElement\("h1"\)/);
  assert.match(result, /data-lavish-print-heading/);
});

test("print script scales the printed output to 80% for a comfortable size", () => {
  const result = injectPrintScript("<!doctype html><html><body><h1>Hi</h1></body></html>");

  // print-scoped zoom, injected as a stylesheet by the reveal script
  assert.match(result, /@media print\{html\{zoom:0\.8\}/);
});

test("print script starts each revealed tab panel on its own page", () => {
  const html = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  const result = injectPrintScript(html);

  // page-break the revealed panels so each tab prints on a fresh page
  assert.match(result, /break-before/);
  // legacy alias too, for broader print-engine support
  assert.match(result, /page-break-before/);
  // breaks apply only to panel roots (parent visible pre-reveal), not nested content
  assert.match(result, /parentElement/);
});

test("print script appends at end of document when there is no body tag", () => {
  const result = injectPrintScript("<h1>Hi</h1>");

  assert.match(result, /^<h1>Hi<\/h1>\n<script>/);
  assert.match(result, /window\.print\(\)/);
});

test("leaves the document body content untouched except for the appended print script", () => {
  const html = "<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>";
  const result = injectPrintScript(html);

  // everything up to </h1> is byte-identical; only a <script>…</script> is added before </body>
  assert.match(
    result,
    /^<!doctype html><html><head><title>Hi<\/title><\/head><body><h1>Hi<\/h1><script>.*<\/script><\/body><\/html>$/s,
  );
});
