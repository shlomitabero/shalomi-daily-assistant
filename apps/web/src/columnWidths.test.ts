import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  clearColumnWidths,
  computeResizedWidth,
  getColumnWidths,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  migrateColumnWidthsForEntityRename,
  purgeColumnWidthsForEntity,
  removeColumnWidthsForUserProject,
  setColumnWidth,
} from "./columnWidths.js";

/** Same full-jsdom-swap technique used by columnVisibility.test.ts/pinnedProjects.test.ts: real localStorage, not a mock. */
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

test("getColumnWidths returns an empty record when no column has ever been resized", async () => {
  await withJsdom(() => {
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), {});
  });
});

test("setColumnWidth persists a field's width, and a fresh getColumnWidths call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setColumnWidth("proj1", "Customer", "userA", "name", 220);
    assert.deepEqual(after, { name: 220 });
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), { name: 220 }, "must actually be written to storage, not just returned");
  });
});

test("setColumnWidth keeps other already-resized fields' widths untouched", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "userA", "name", 220);
    const after = setColumnWidth("proj1", "Customer", "userA", "email", 300);
    assert.deepEqual(after, { name: 220, email: 300 });
  });
});

test("column widths are scoped per project+entity -- resizing a field in one project's entity never affects a same-named field in a different project's same-named entity", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "userA", "name", 220);
    assert.deepEqual(getColumnWidths("proj2", "Customer", "userA"), {}, "a different project must not see proj1's resized columns");
    assert.deepEqual(getColumnWidths("proj1", "Order", "userA"), {}, "a different entity in the same project must not see Customer's resized columns");
  });
});

/**
 * Round 1068: the whole point of this round's fix. Before it, the storage
 * key was projectId+entityName alone -- two different collaborator
 * accounts sharing the SAME project+entity on the SAME browser silently
 * saw, and could overwrite, each other's own drag-resized column widths.
 */
test("column widths are also kept per-user -- two different accounts on the SAME project+entity never see each other's own resized widths", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "userA", "name", 220);
    setColumnWidth("proj1", "Customer", "userB", "name", 350);
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), { name: 220 });
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userB"), { name: 350 }, "userB must never see userA's own resized width");
  });
});

test("getColumnWidths falls back to an empty record for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.columnWidths", "not real json{{{");
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), {});
  });
});

test("clearColumnWidths drops every resized width for the entity for the current user, and a fresh getColumnWidths call sees it gone -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "userA", "name", 220);
    setColumnWidth("proj1", "Customer", "userA", "email", 300);
    const after = clearColumnWidths("proj1", "Customer", "userA");
    assert.deepEqual(after, {});
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), {}, "must actually be removed from storage, not just returned as empty");
  });
});

test("clearColumnWidths only clears the given project+entity+user, leaving a different entity's own resized widths -- and a different user's own resized widths for the SAME entity -- untouched", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "userA", "name", 220);
    setColumnWidth("proj1", "Order", "userA", "total", 180);
    setColumnWidth("proj1", "Customer", "userB", "name", 350);
    clearColumnWidths("proj1", "Customer", "userA");
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), {});
    assert.deepEqual(getColumnWidths("proj1", "Order", "userA"), { total: 180 }, "a different entity's own resized widths must survive clearing Customer's");
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userB"), { name: 350 }, "a different user's own resized widths for the same entity must survive too");
  });
});

/**
 * Round 1068: purgeColumnWidthsForEntity is what entityPreferenceCleanup.ts
 * now calls on an entity drop, replacing the old single-user clearColumnWidths
 * call -- there's no single "current user" at drop time, so it must sweep
 * every collaborator's own entry, not just whichever one happens to be
 * signed in when the drop runs.
 */
test("purgeColumnWidthsForEntity removes the entity's own widths for EVERY collaborator account, not just one, leaving a sibling entity's own widths untouched", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "userA", "name", 220);
    setColumnWidth("proj1", "Customer", "userB", "name", 350);
    setColumnWidth("proj1", "Order", "userA", "total", 180);

    purgeColumnWidthsForEntity("proj1", "Customer");

    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), {}, "userA's own widths must be gone");
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userB"), {}, "userB's own widths must be gone too, not just userA's");
    assert.deepEqual(getColumnWidths("proj1", "Order", "userA"), { total: 180 }, "a sibling entity's own widths must survive untouched");
  });
});

/**
 * Round 1068: migrateColumnWidthsForEntityRename must remap EVERY
 * collaborator's own entry on a case-only rename, not just one -- the
 * key's own userId segment isn't known in advance.
 */
test("migrateColumnWidthsForEntityRename remaps every collaborator's own widths to the new casing, leaving a sibling entity's own widths untouched", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "customer", "userA", "name", 220);
    setColumnWidth("proj1", "customer", "userB", "name", 350);
    setColumnWidth("proj1", "Order", "userA", "total", 180);

    migrateColumnWidthsForEntityRename("proj1", "customer", "Customer");

    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), { name: 220 }, "userA's widths must resolve under the new casing");
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userB"), { name: 350 }, "userB's widths must resolve under the new casing too");
    // Round 1543: getColumnWidths now falls back to a case-insensitive scan, the same
    // resolution round 1542 gave columnOrder.ts's identical gap -- so a lookup under the
    // old casing still resolves via that fallback instead of coming back empty. This is
    // the intended new behavior, not a regression: the whole point of the fallback is
    // that such a lookup no longer silently reverts to default widths.
    assert.deepEqual(getColumnWidths("proj1", "customer", "userA"), { name: 220 }, "a lookup under the old casing must still resolve via getColumnWidths's own case-insensitive fallback");
    assert.deepEqual(getColumnWidths("proj1", "Order", "userA"), { total: 180 }, "a sibling entity's own widths must survive the rename untouched");
  });
});

/**
 * Round 1543: migrateColumnWidthsForEntityRename only ever runs in the single
 * browser tab that triggered the rename (see getColumnWidths's own doc
 * comment) -- so a different collaborator's own localStorage, which never
 * saw that migration run, must still resolve its real widths via
 * getColumnWidths's new case-insensitive fallback, mirroring
 * columnOrder.test.ts's identical round-1542 coverage for getColumnOrder.
 */
test("getColumnWidths resolves a collaborator's own widths stored under the OLD casing, even though no migration ever ran in this browser", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "customer", "userB", "name", 350);

    assert.deepEqual(getColumnWidths("proj1", "Customer", "userB"), { name: 350 }, "must resolve userB's own widths under the new casing via the case-insensitive fallback, with no migration ever having run");
  });
});

test("getColumnWidths's case-insensitive fallback never leaks a different user's or different project's own widths for the same entity name", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "customer", "userA", "name", 220);
    setColumnWidth("proj2", "customer", "userB", "name", 400);

    assert.deepEqual(getColumnWidths("proj1", "Customer", "userB"), {}, "userB has no widths of their own in proj1 -- userA's own widths for the same entity must not leak across users");
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), { name: 220 }, "userA's own widths must still resolve via the fallback");
    assert.deepEqual(getColumnWidths("proj2", "Customer", "userA"), {}, "a different project's own widths for the same entity+user combination must not leak across projects");
  });
});

test("computeResizedWidth adds the drag delta to the starting width in LTR", () => {
  assert.equal(computeResizedWidth(200, 40), 240);
  assert.equal(computeResizedWidth(200, -40), 160);
});

test("computeResizedWidth flips the delta's sign in RTL, so dragging the same direction narrows instead of widens", () => {
  assert.equal(computeResizedWidth(200, 40, "rtl"), 160);
  assert.equal(computeResizedWidth(200, -40, "rtl"), 240);
});

test("computeResizedWidth clamps to MIN_COLUMN_WIDTH, never producing an unreadably narrow column", () => {
  assert.equal(computeResizedWidth(70, -1000), MIN_COLUMN_WIDTH);
});

test("computeResizedWidth clamps to MAX_COLUMN_WIDTH, never producing a runaway-wide column", () => {
  assert.equal(computeResizedWidth(400, 1000), MAX_COLUMN_WIDTH);
});

test("removeColumnWidthsForUserProject removes only this one user's own widths across every entity of one project, leaving every other collaborator's own widths for the SAME project (and this user's own widths for another project) untouched", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "userA", "name", 220);
    setColumnWidth("proj1", "Order", "userA", "total", 180);
    setColumnWidth("proj1", "Customer", "userB", "name", 300);
    setColumnWidth("proj2", "Customer", "userA", "name", 260);

    removeColumnWidthsForUserProject("proj1", "userA");

    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), {}, "userA's own Customer widths for the left project must be cleared");
    assert.deepEqual(getColumnWidths("proj1", "Order", "userA"), {}, "userA's own Order widths for the SAME left project must also be cleared, not just one entity");
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userB"), { name: 300 }, "userB's own widths for the SAME still-shared project must survive");
    assert.deepEqual(getColumnWidths("proj2", "Customer", "userA"), { name: 260 }, "userA's own widths for an UNRELATED project must survive untouched");
  });
});

test("removeColumnWidthsForUserProject is a no-op, not an error, when this user never resized anything in this project", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => removeColumnWidthsForUserProject("proj1", "userA"));
    assert.deepEqual(getColumnWidths("proj1", "Customer", "userA"), {});
  });
});

/**
 * Round 1579: entity names have no character restriction (EntitySchema is a
 * bare non-empty string), so two sibling entities like "Foo" and "Foo:Bar"
 * can legally coexist in one project. A colon-joined key would make
 * purgeColumnWidthsForEntity's/migrateColumnWidthsForEntityRename's own
 * prefix-scan for "Foo" also match "Foo:Bar"'s real keys, silently wiping
 * or corrupting an unrelated, still-live entity's widths.
 */
test("purging or renaming an entity named 'Foo' must not touch a sibling entity whose name is 'Foo:Bar'", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Foo", "userA", "name", 150);
    setColumnWidth("proj1", "Foo:Bar", "userA", "label", 200);

    purgeColumnWidthsForEntity("proj1", "Foo");
    assert.deepEqual(getColumnWidths("proj1", "Foo", "userA"), {}, "the purged entity's own widths must be gone");
    assert.deepEqual(getColumnWidths("proj1", "Foo:Bar", "userA"), { label: 200 }, "the sibling 'Foo:Bar' entity's widths must survive untouched");

    setColumnWidth("proj1", "Foo", "userA", "name", 150);
    migrateColumnWidthsForEntityRename("proj1", "Foo", "Baz");
    assert.deepEqual(getColumnWidths("proj1", "Baz", "userA"), { name: 150 }, "the renamed entity's widths must land under the new name");
    assert.deepEqual(getColumnWidths("proj1", "Foo:Bar", "userA"), { label: 200 }, "renaming 'Foo' must not corrupt the sibling 'Foo:Bar' entity's own widths");
  });
});
