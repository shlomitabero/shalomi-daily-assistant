import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleSelectedIds } from "./projectSelection.js";

test("visibleSelectedIds keeps a selected id that is still visible", () => {
  const result = visibleSelectedIds(new Set(["a", "b"]), ["a", "b", "c"]);
  assert.deepEqual([...result].sort(), ["a", "b"]);
});

test("visibleSelectedIds drops a selected id that is no longer visible (e.g. hidden by a filter)", () => {
  const result = visibleSelectedIds(new Set(["a", "b"]), ["a"]);
  assert.deepEqual([...result], ["a"]);
});

test("visibleSelectedIds returns an empty set when nothing selected is currently visible", () => {
  const result = visibleSelectedIds(new Set(["a", "b"]), ["c", "d"]);
  assert.equal(result.size, 0);
});

test("visibleSelectedIds does not mutate the original selected-ids set", () => {
  const original = new Set(["a", "b"]);
  visibleSelectedIds(original, ["a"]);
  assert.deepEqual([...original].sort(), ["a", "b"]);
});
