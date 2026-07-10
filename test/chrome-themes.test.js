import assert from "node:assert/strict";
import test from "node:test";

import { CHROME_THEMES, DEFAULT_CHROME_THEME, isValidChromeTheme, resolveChromeTheme } from "../src/chrome-themes.js";

test("DEFAULT_CHROME_THEME is midnight", () => {
  assert.equal(DEFAULT_CHROME_THEME, "midnight");
});

test("CHROME_THEMES lists lavish-light, midnight, and swiss in that order", () => {
  assert.deepEqual(
    CHROME_THEMES.map((theme) => theme.id),
    ["lavish-light", "midnight", "swiss"],
  );
});

test("isValidChromeTheme accepts only known theme ids", () => {
  assert.equal(isValidChromeTheme("lavish-light"), true);
  assert.equal(isValidChromeTheme("midnight"), true);
  assert.equal(isValidChromeTheme("swiss"), true);
  assert.equal(isValidChromeTheme("nonexistent"), false);
  assert.equal(isValidChromeTheme(""), false);
});

test("resolveChromeTheme defaults to midnight with no query or env", () => {
  assert.equal(resolveChromeTheme({}, {}), "midnight");
});

test("resolveChromeTheme reads a valid ?theme= query param", () => {
  assert.equal(resolveChromeTheme({ theme: "midnight" }, {}), "midnight");
});

test("resolveChromeTheme ignores an invalid ?theme= query param and falls back to default", () => {
  assert.equal(resolveChromeTheme({ theme: "not-a-theme" }, {}), "midnight");
});

test("resolveChromeTheme reads LAVISH_AXI_THEME when no query param is present", () => {
  assert.equal(resolveChromeTheme({}, { LAVISH_AXI_THEME: "swiss" }), "swiss");
});

test("a valid query param wins over LAVISH_AXI_THEME", () => {
  assert.equal(resolveChromeTheme({ theme: "midnight" }, { LAVISH_AXI_THEME: "swiss" }), "midnight");
});

test("resolveChromeTheme ignores an invalid LAVISH_AXI_THEME and falls back to default", () => {
  assert.equal(resolveChromeTheme({}, { LAVISH_AXI_THEME: "nope" }), "midnight");
});
