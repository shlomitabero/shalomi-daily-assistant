import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getHiddenFields, removeHiddenFieldsForUserProject, replaceHiddenFields, toggleFieldVisibility } from "./columnVisibility.js";

/** Same full-jsdom-swap technique used by pinnedProjects.test.ts: real localStorage, not a mock, so these tests prove the actual persistence contract. */
async function withJsdom(fn: () => void | Promise<void>): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const originals: Record<string, unknown> = {};
  const keys = ["window", "document", "navigator", "localStorage"];
  for (const key of keys) {
    originals[key] = (globalThis as Record<string, unknown>)[key];
  }
  try {
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true });
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] !== undefined) Object.defineProperty(globalThis, key, { value: originals[key], configurable: true });
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("getHiddenFields returns an empty set when nothing has ever been hidden", async () => {
  await withJsdom(() => {
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set());
  });
});

test("toggleFieldVisibility hides a shown field, and a fresh getHiddenFields call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = toggleFieldVisibility("proj1", "Customer", "userA", "notes");
    assert.deepEqual(after, new Set(["notes"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set(["notes"]), "must actually be written to storage, not just returned");
  });
});

test("toggleFieldVisibility re-shows an already-hidden field", async () => {
  await withJsdom(() => {
    toggleFieldVisibility("proj1", "Customer", "userA", "notes");
    toggleFieldVisibility("proj1", "Customer", "userA", "phone");
    const after = toggleFieldVisibility("proj1", "Customer", "userA", "notes");
    assert.deepEqual(after, new Set(["phone"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set(["phone"]));
  });
});

test("hidden columns are scoped per project+entity -- hiding a field in one project's entity never hides a same-named field in a different project's same-named entity", async () => {
  await withJsdom(() => {
    toggleFieldVisibility("proj1", "Customer", "userA", "notes");
    assert.deepEqual(getHiddenFields("proj2", "Customer", "userA"), new Set(), "a different project must not see proj1's hidden columns");
    assert.deepEqual(getHiddenFields("proj1", "Order", "userA"), new Set(), "a different entity in the same project must not see Customer's hidden columns");
  });
});

/**
 * Round 1055: the whole point of this round's fix. Before it, the storage
 * key was projectId+entityName alone -- two different collaborator
 * accounts sharing the SAME project+entity on the SAME browser silently
 * saw each other's own hidden columns, with no indication a field had
 * even been hidden -- worse than a leaked filter or search string, since
 * there's nothing in the table itself hinting a column is missing.
 */
test("hidden columns are also kept per-user -- two different accounts on the SAME project+entity never see each other's own hidden-column choice", async () => {
  await withJsdom(() => {
    toggleFieldVisibility("proj1", "Customer", "userA", "notes");
    toggleFieldVisibility("proj1", "Customer", "userB", "phone");
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set(["notes"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userB"), new Set(["phone"]), "userB must never see userA's own hidden-column choice");
  });
});

test("replaceHiddenFields persists a whole new set, and a fresh getHiddenFields call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = replaceHiddenFields("proj1", "Customer", "userA", ["name", "phone"]);
    assert.deepEqual(after, new Set(["name", "phone"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set(["name", "phone"]), "must actually be written to storage, not just returned");
  });
});

test("replaceHiddenFields with an empty set clears the stored entry entirely, not leave an empty array behind", async () => {
  await withJsdom(() => {
    toggleFieldVisibility("proj1", "Customer", "userA", "notes");
    replaceHiddenFields("proj1", "Customer", "userA", []);
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set());
    assert.equal(JSON.parse(localStorage.getItem("forge.hiddenColumns")!)["proj1:Customer:userA"], undefined);
  });
});

test("getHiddenFields tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.hiddenColumns", "not valid json{{{");
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set());

    localStorage.setItem("forge.hiddenColumns", JSON.stringify(["an", "array", "not", "an", "object"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set());

    localStorage.setItem(
      "forge.hiddenColumns",
      JSON.stringify({ "proj1:Customer:userA": ["notes", 42, null, "phone"] }),
    );
    assert.deepEqual(
      getHiddenFields("proj1", "Customer", "userA"),
      new Set(["notes", "phone"]),
      "non-string entries must be dropped, not crash the whole read",
    );
  });
});

test("removeHiddenFieldsForUserProject removes only this one user's own hidden-columns choice across every entity of one project, leaving every other collaborator's own choice for the SAME project (and this user's own choice for another project) untouched", async () => {
  await withJsdom(() => {
    replaceHiddenFields("proj1", "Customer", "userA", ["notes"]);
    replaceHiddenFields("proj1", "Order", "userA", ["total"]);
    replaceHiddenFields("proj1", "Customer", "userB", ["phone"]);
    replaceHiddenFields("proj2", "Customer", "userA", ["email"]);

    removeHiddenFieldsForUserProject("proj1", "userA");

    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set(), "userA's own Customer choice for the left project must be cleared");
    assert.deepEqual(getHiddenFields("proj1", "Order", "userA"), new Set(), "userA's own Order choice for the SAME left project must also be cleared, not just one entity");
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userB"), new Set(["phone"]), "userB's own choice for the SAME still-shared project must survive");
    assert.deepEqual(getHiddenFields("proj2", "Customer", "userA"), new Set(["email"]), "userA's own choice for an UNRELATED project must survive untouched");
  });
});

test("removeHiddenFieldsForUserProject is a no-op, not an error, when this user never hid any column in this project", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => removeHiddenFieldsForUserProject("proj1", "userA"));
    assert.deepEqual(getHiddenFields("proj1", "Customer", "userA"), new Set());
  });
});
