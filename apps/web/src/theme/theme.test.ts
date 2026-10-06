import assert from "node:assert/strict";
import { test } from "node:test";
import { detectInitialTheme } from "./theme.js";

test("detectInitialTheme trusts a valid stored value over the system preference", () => {
  assert.equal(detectInitialTheme("light", true), "light");
  assert.equal(detectInitialTheme("dark", false), "dark");
});

test("detectInitialTheme falls back to the system preference when nothing is stored", () => {
  assert.equal(detectInitialTheme(null, true), "dark");
  assert.equal(detectInitialTheme(null, false), "light");
});

test("detectInitialTheme defaults to light with no stored value and no system signal, never throws", () => {
  assert.equal(detectInitialTheme(null, undefined), "light");
  assert.equal(detectInitialTheme("", undefined), "light");
  assert.equal(detectInitialTheme("sepia", true), "dark"); // a corrupted stored value falls back to the system signal
});
