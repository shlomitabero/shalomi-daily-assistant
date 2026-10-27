import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getEntityTabOrder, setEntityTabOrder, purgeEntityTabOrderForProject, purgeEntityNameFromTabOrder } from "./entityTabOrder.js";

/** Same full-jsdom-swap technique columnOrder.test.ts/columnWidths.test.ts/columnVisibility.test.ts already use: real localStorage, not a mock. */
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

test("getEntityTabOrder returns an empty array when tabs have never been reordered", async () => {
  await withJsdom(() => {
    assert.deepEqual(getEntityTabOrder("proj1", "userA"), []);
  });
});

test("setEntityTabOrder persists a real order, and a fresh getEntityTabOrder call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setEntityTabOrder("proj1", "userA", ["Task", "Deal", "Contact"]);
    assert.deepEqual(after, ["Task", "Deal", "Contact"]);
    assert.deepEqual(getEntityTabOrder("proj1", "userA"), ["Task", "Deal", "Contact"], "must actually be written to storage, not just returned");
  });
});

test("entity-tab order is scoped per project only -- reordering one project's tabs never affects another project's", async () => {
  await withJsdom(() => {
    setEntityTabOrder("proj1", "userA", ["Task", "Deal"]);
    assert.deepEqual(getEntityTabOrder("proj2", "userA"), [], "a different project must not see proj1's reordered tabs");
  });
});

/**
 * Round 1067: the whole point of this round's fix. Before it, the storage
 * key was flat and shared -- two different collaborator accounts sharing
 * the SAME project on the SAME browser silently saw each other's own
 * dragged-into-place tab order.
 */
test("entity-tab order is also kept per-user -- two different accounts on the SAME project never see each other's own reordered tabs", async () => {
  await withJsdom(() => {
    setEntityTabOrder("proj1", "userA", ["Task", "Deal"]);
    setEntityTabOrder("proj1", "userB", ["Deal", "Task"]);
    assert.deepEqual(getEntityTabOrder("proj1", "userA"), ["Task", "Deal"]);
    assert.deepEqual(getEntityTabOrder("proj1", "userB"), ["Deal", "Task"], "userB must never see userA's own reordered tabs");
  });
});

test("getEntityTabOrder falls back to an empty array for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.entityTabOrder.userA", "not real json{{{");
    assert.deepEqual(getEntityTabOrder("proj1", "userA"), []);
  });
});

test("purgeEntityTabOrderForProject removes every collaborator account's own tab order for that project, leaving a different project's own entries untouched", async () => {
  await withJsdom(() => {
    setEntityTabOrder("proj1", "userA", ["Task", "Deal"]);
    setEntityTabOrder("proj1", "userB", ["Deal", "Task"]);
    setEntityTabOrder("proj2", "userA", ["Contact"]);

    purgeEntityTabOrderForProject("proj1");

    assert.deepEqual(getEntityTabOrder("proj1", "userA"), [], "userA's own order must be gone");
    assert.deepEqual(getEntityTabOrder("proj1", "userB"), [], "userB's own order must be gone too, not just userA's");
    assert.deepEqual(getEntityTabOrder("proj2", "userA"), ["Contact"], "a different project's own order must survive untouched");
  });
});

/**
 * Round 865: a refine that drops one entity from a project never removed
 * that entity's name from this project's own persisted tab order -- the
 * one sibling store entityPreferenceCleanup.ts's round-853 sweep missed,
 * since this store is keyed by projectId alone rather than
 * `${projectId}:${entityName}`. Without this, a later refine that
 * reintroduces an entity with the SAME name would silently inherit the
 * stale position.
 */
test("purgeEntityNameFromTabOrder removes exactly one entity name from a project's tab order, leaving the rest of that order and a sibling project's order untouched", async () => {
  await withJsdom(() => {
    setEntityTabOrder("proj1", "userA", ["Task", "Deal", "Contact"]);
    setEntityTabOrder("proj2", "userA", ["Deal", "Task"]);

    purgeEntityNameFromTabOrder("proj1", "Deal");

    assert.deepEqual(getEntityTabOrder("proj1", "userA"), ["Task", "Contact"], "the dropped entity's name must be removed, the rest of the order preserved");
    assert.deepEqual(getEntityTabOrder("proj2", "userA"), ["Deal", "Task"], "an unrelated project's own order, including its own \"Deal\" entry, must survive untouched");
  });
});

/**
 * Round 1067: mirrors purgeEntityTabOrderForProject's own new coverage --
 * any past collaborator could have reordered this entity's project under
 * their own per-user key, so the dropped name must be removed for every
 * account, not just whichever one happens to be signed in when the
 * refine that dropped the entity runs.
 */
test("purgeEntityNameFromTabOrder removes the dropped entity name from EVERY collaborator account's own tab order, not just one", async () => {
  await withJsdom(() => {
    setEntityTabOrder("proj1", "userA", ["Task", "Deal", "Contact"]);
    setEntityTabOrder("proj1", "userB", ["Deal", "Contact", "Task"]);

    purgeEntityNameFromTabOrder("proj1", "Deal");

    assert.deepEqual(getEntityTabOrder("proj1", "userA"), ["Task", "Contact"]);
    assert.deepEqual(getEntityTabOrder("proj1", "userB"), ["Contact", "Task"], "userB's own order must also have the dropped entity removed");
  });
});

test("purgeEntityNameFromTabOrder is a no-op, not an error, when the project was never reordered or the name isn't present", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => purgeEntityNameFromTabOrder("proj1", "Deal"));
    assert.deepEqual(getEntityTabOrder("proj1", "userA"), []);

    setEntityTabOrder("proj1", "userA", ["Task"]);
    purgeEntityNameFromTabOrder("proj1", "Deal");
    assert.deepEqual(getEntityTabOrder("proj1", "userA"), ["Task"]);
  });
});
