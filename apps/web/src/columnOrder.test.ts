import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  applyColumnOrder,
  getColumnOrder,
  migrateColumnOrderForEntityRename,
  moveColumnToEnd,
  purgeColumnOrderForEntity,
  removeColumnOrderForUserProject,
  reorderColumns,
  setColumnOrder,
} from "./columnOrder.js";

/** Same full-jsdom-swap technique used by columnWidths.test.ts/columnVisibility.test.ts: real localStorage, not a mock. */
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

test("getColumnOrder returns an empty array when columns have never been reordered", async () => {
  await withJsdom(() => {
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), []);
  });
});

test("setColumnOrder persists a real order, and a fresh getColumnOrder call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setColumnOrder("proj1", "Customer", "userA", ["email", "name", "phone"]);
    assert.deepEqual(after, ["email", "name", "phone"]);
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), ["email", "name", "phone"], "must actually be written to storage, not just returned");
  });
});

test("column order is scoped per project+entity -- reordering one project's entity never affects a same-named entity in a different project", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Customer", "userA", ["email", "name"]);
    assert.deepEqual(getColumnOrder("proj2", "Customer", "userA"), [], "a different project must not see proj1's reordered columns");
    assert.deepEqual(getColumnOrder("proj1", "Order", "userA"), [], "a different entity in the same project must not see Customer's reordered columns");
  });
});

/**
 * Round 1069: the whole point of this round's fix. Before it, the storage
 * key was projectId+entityName alone -- two different collaborator
 * accounts sharing the SAME project+entity on the SAME browser silently
 * saw, and could overwrite, each other's own drag-reordered column order.
 */
test("column order is also kept per-user -- two different accounts on the SAME project+entity never see each other's own reordered columns", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Customer", "userA", ["email", "name"]);
    setColumnOrder("proj1", "Customer", "userB", ["name", "email"]);
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), ["email", "name"]);
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userB"), ["name", "email"], "userB must never see userA's own reordered columns");
  });
});

test("getColumnOrder falls back to an empty array for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.columnOrder", "not real json{{{");
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), []);
  });
});

/**
 * Round 1069: purgeColumnOrderForEntity is what entityPreferenceCleanup.ts
 * now calls on an entity drop -- there's no single "current user" at drop
 * time, so it must sweep every collaborator's own entry, not just one.
 */
test("purgeColumnOrderForEntity removes the entity's own order for EVERY collaborator account, leaving a sibling entity's own order untouched", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Customer", "userA", ["email", "name"]);
    setColumnOrder("proj1", "Customer", "userB", ["name", "email"]);
    setColumnOrder("proj1", "Order", "userA", ["total", "status"]);

    purgeColumnOrderForEntity("proj1", "Customer");

    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), [], "userA's own order must be gone");
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userB"), [], "userB's own order must be gone too, not just userA's");
    assert.deepEqual(getColumnOrder("proj1", "Order", "userA"), ["total", "status"], "a sibling entity's own order must survive untouched");
  });
});

/**
 * Round 1069: migrateColumnOrderForEntityRename must remap EVERY
 * collaborator's own entry on a case-only rename, not just one.
 */
test("migrateColumnOrderForEntityRename remaps every collaborator's own order to the new casing, leaving a sibling entity's own order untouched", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "customer", "userA", ["email", "name"]);
    setColumnOrder("proj1", "customer", "userB", ["name", "email"]);
    setColumnOrder("proj1", "Order", "userA", ["total", "status"]);

    migrateColumnOrderForEntityRename("proj1", "customer", "Customer");

    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), ["email", "name"], "userA's order must resolve under the new casing");
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userB"), ["name", "email"], "userB's order must resolve under the new casing too");
    // Round 1542: getColumnOrder itself now has a case-insensitive fallback
    // (for every collaborator who never ran this exact migration in their
    // own browser), so a lookup under the OLD casing correctly still
    // resolves to the migrated entry too -- this is the intended new
    // behavior, not a regression of the migration itself.
    assert.deepEqual(getColumnOrder("proj1", "customer", "userA"), ["email", "name"], "a lookup under the old casing must still resolve via getColumnOrder's own case-insensitive fallback");
    assert.deepEqual(getColumnOrder("proj1", "Order", "userA"), ["total", "status"], "a sibling entity's own order must survive the rename untouched");
  });
});

const F = (name: string) => ({ name });

test("applyColumnOrder reorders known fields to match the persisted order", () => {
  const fields = [F("name"), F("email"), F("phone")];
  const result = applyColumnOrder(fields, ["phone", "name", "email"]);
  assert.deepEqual(result.map((f) => f.name), ["phone", "name", "email"]);
});

test("applyColumnOrder appends a field the persisted order doesn't mention (newly added since the order was saved) at the end, in the entity's own original order", () => {
  const fields = [F("name"), F("email"), F("phone")];
  const result = applyColumnOrder(fields, ["email", "name"]);
  assert.deepEqual(result.map((f) => f.name), ["email", "name", "phone"]);
});

test("applyColumnOrder drops a persisted name the entity no longer has (a removed field), without crashing or leaving a hole", () => {
  const fields = [F("name"), F("email")];
  const result = applyColumnOrder(fields, ["ghostField", "email", "name"]);
  assert.deepEqual(result.map((f) => f.name), ["email", "name"]);
});

test("applyColumnOrder keeps a field's persisted position across a pure case-only rename, instead of dropping it to the end like a removed field", () => {
  const fields = [F("name"), F("Email"), F("phone")];
  const result = applyColumnOrder(fields, ["phone", "email", "name"]);
  assert.deepEqual(
    result.map((f) => f.name),
    ["phone", "Email", "name"],
    "the persisted 'email' entry must still resolve to the current field 'Email' by its new position, not fall through to the entity's own natural order",
  );
});

test("applyColumnOrder never matches the same field twice for two persisted order entries that differ only by case", () => {
  const fields = [F("name"), F("Email")];
  const result = applyColumnOrder(fields, ["EMAIL", "email", "name"]);
  assert.deepEqual(result.map((f) => f.name), ["Email", "name"], "Email must appear exactly once, at its first (case-insensitive) match's position");
});

test("applyColumnOrder with an empty persisted order falls back to the entity's own natural field order", () => {
  const fields = [F("name"), F("email"), F("phone")];
  assert.deepEqual(applyColumnOrder(fields, []).map((f) => f.name), ["name", "email", "phone"]);
});

test("reorderColumns moves the source field to just before the target field", () => {
  assert.deepEqual(reorderColumns(["name", "email", "phone"], "phone", "email"), ["name", "phone", "email"]);
  assert.deepEqual(reorderColumns(["name", "email", "phone"], "name", "phone"), ["email", "name", "phone"]);
});

test("reorderColumns dropping a column onto itself is a real no-op", () => {
  const order = ["name", "email", "phone"];
  assert.equal(reorderColumns(order, "email", "email"), order);
});

test("reorderColumns is a no-op if either name isn't actually in the order", () => {
  const order = ["name", "email", "phone"];
  assert.equal(reorderColumns(order, "ghost", "email"), order);
  assert.equal(reorderColumns(order, "name", "ghost"), order);
});

/**
 * Round 1789: reorderColumns only has a "move X before Y" primitive, so
 * repeatedly dragging a field onto the current last field's own header
 * (the only drag target reachable without a dedicated "move to end" zone)
 * can never actually reach the true last slot -- it always lands one
 * position short, no matter how many times the exact same drag repeats.
 */
test("reorderColumns dropping a field onto the current last field never reaches the true last position, even if repeated", () => {
  let order = ["a", "b", "c", "d"];
  for (let i = 0; i < 5; i++) order = reorderColumns(order, "a", "d");
  assert.deepEqual(order, ["b", "c", "a", "d"], "repeatedly dragging 'a' onto the last field 'd' must stabilize one slot short of last, never reaching it");
});

test("moveColumnToEnd moves the source field to the true last position", () => {
  assert.deepEqual(moveColumnToEnd(["a", "b", "c", "d"], "a"), ["b", "c", "d", "a"]);
  assert.deepEqual(moveColumnToEnd(["a", "b", "c", "d"], "c"), ["a", "b", "d", "c"]);
});

test("moveColumnToEnd is a no-op if the source field is already last, or isn't actually in the order", () => {
  const order = ["a", "b", "c"];
  assert.deepEqual(moveColumnToEnd(order, "c"), order);
  assert.equal(moveColumnToEnd(order, "ghost"), order);
});

test("removeColumnOrderForUserProject removes only this one user's own order across every entity of one project, leaving every other collaborator's own order for the SAME project (and this user's own order for another project) untouched", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Customer", "userA", ["email", "name"]);
    setColumnOrder("proj1", "Order", "userA", ["total", "date"]);
    setColumnOrder("proj1", "Customer", "userB", ["name", "email"]);
    setColumnOrder("proj2", "Customer", "userA", ["phone", "name"]);

    removeColumnOrderForUserProject("proj1", "userA");

    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), [], "userA's own Customer order for the left project must be cleared");
    assert.deepEqual(getColumnOrder("proj1", "Order", "userA"), [], "userA's own Order order for the SAME left project must also be cleared, not just one entity");
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userB"), ["name", "email"], "userB's own order for the SAME still-shared project must survive");
    assert.deepEqual(getColumnOrder("proj2", "Customer", "userA"), ["phone", "name"], "userA's own order for an UNRELATED project must survive untouched");
  });
});

test("removeColumnOrderForUserProject is a no-op, not an error, when this user never reordered anything in this project", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => removeColumnOrderForUserProject("proj1", "userA"));
    assert.deepEqual(getColumnOrder("proj1", "Customer", "userA"), []);
  });
});

/**
 * Round 1542: migrateEntityPreferencesForCaseRename (entityPreferenceCleanup.ts)
 * only ever runs in the one browser tab that triggered a case-only entity
 * rename (build/refine completion, or a checkpoint restore) -- every OTHER
 * collaborator's own localStorage still holds this entry under the entity's
 * OLD casing, forever, with no way to ever re-run that migration. Before
 * this round's fix, getColumnOrder's exact-match lookup silently reverted
 * such a collaborator's saved column order to the entity's default field
 * order the moment they next loaded the project, with zero error or
 * indication.
 */
test("getColumnOrder finds a collaborator's own order stored under the entity's OLD casing, even though this browser never ran migrateEntityPreferencesForCaseRename for it", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Customer", "userB", ["name", "email", "phone"]);

    assert.deepEqual(
      getColumnOrder("proj1", "customer", "userB"),
      ["name", "email", "phone"],
      "a case-only entity rename elsewhere must not silently revert this collaborator's own saved column order",
    );
  });
});

test("getColumnOrder's case-insensitive fallback never leaks a DIFFERENT user's or a DIFFERENT project's own order for the same entity", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Customer", "userA", ["email", "name"]);
    setColumnOrder("proj2", "Customer", "userB", ["phone", "name"]);

    assert.deepEqual(getColumnOrder("proj1", "customer", "userB"), [], "must not return a different user's own order for the same project+entity");
    assert.deepEqual(getColumnOrder("proj2", "customer", "userA"), [], "must not return a different project's own order for the same user+entity");
  });
});

/**
 * Round 1579: entity names have no character restriction, so two sibling
 * entities like "Foo" and "Foo:Bar" can legally coexist in one project --
 * see columnWidths.ts's own identical regression test for the full
 * "colon-joined key collision" reasoning.
 */
test("purging or renaming an entity named 'Foo' must not touch a sibling entity whose name is 'Foo:Bar'", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Foo", "userA", ["name"]);
    setColumnOrder("proj1", "Foo:Bar", "userA", ["label"]);

    purgeColumnOrderForEntity("proj1", "Foo");
    assert.deepEqual(getColumnOrder("proj1", "Foo", "userA"), [], "the purged entity's own order must be gone");
    assert.deepEqual(getColumnOrder("proj1", "Foo:Bar", "userA"), ["label"], "the sibling 'Foo:Bar' entity's order must survive untouched");

    setColumnOrder("proj1", "Foo", "userA", ["name"]);
    migrateColumnOrderForEntityRename("proj1", "Foo", "Baz");
    assert.deepEqual(getColumnOrder("proj1", "Baz", "userA"), ["name"], "the renamed entity's order must land under the new name");
    assert.deepEqual(getColumnOrder("proj1", "Foo:Bar", "userA"), ["label"], "renaming 'Foo' must not corrupt the sibling 'Foo:Bar' entity's own order");
  });
});
