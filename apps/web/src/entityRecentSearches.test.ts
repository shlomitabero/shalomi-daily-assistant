import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addEntityRecentSearch,
  clearEntityRecentSearches,
  getEntityRecentSearches,
  purgeEntityRecentSearchesForEntity,
  purgeEntityRecentSearchesForProject,
  removeEntityRecentSearch,
  removeEntityRecentSearchesForUserProject,
} from "./entityRecentSearches.js";

/** Same full-jsdom-swap technique columnOrder.test.ts/recentProjectSearches.test.ts use: real localStorage, not a mock. */
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

test("getEntityRecentSearches returns an empty list when nothing has ever been searched", async () => {
  await withJsdom(() => {
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), []);
  });
});

test("addEntityRecentSearch adds a query to the front, and a fresh getEntityRecentSearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addEntityRecentSearch("proj1", "Customer", "userA", "unpaid");
    assert.deepEqual(after, ["unpaid"]);
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), ["unpaid"], "must actually be written to storage, not just returned");
  });
});

test("addEntityRecentSearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    addEntityRecentSearch("proj1", "Customer", "userA", "zeta");
    const after = addEntityRecentSearch("proj1", "Customer", "userA", "mid");
    assert.deepEqual(after, ["mid", "zeta", "acme"]);
  });
});

test("addEntityRecentSearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "Acme");
    addEntityRecentSearch("proj1", "Customer", "userA", "zeta");
    const after = addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    assert.deepEqual(after, ["acme", "zeta"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addEntityRecentSearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addEntityRecentSearch("proj1", "Customer", "userA", q);
    }
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), ["six", "five", "four", "three", "two"]);
  });
});

test("addEntityRecentSearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    const after = addEntityRecentSearch("proj1", "Customer", "userA", "   ");
    assert.deepEqual(after, ["acme"]);
  });
});

test("recent searches are scoped per project+entity -- searching one project's entity never affects a same-named entity in a different project, or a different entity in the same project", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "unpaid");
    assert.deepEqual(getEntityRecentSearches("proj2", "Customer", "userA"), [], "a different project must not see proj1's recent searches");
    assert.deepEqual(getEntityRecentSearches("proj1", "Order", "userA"), [], "a different entity in the same project must not see Customer's recent searches");
  });
});

/**
 * Round 994: the whole point of this round's fix. Before it, the storage
 * key was projectId+entityName alone -- two different collaborator
 * accounts sharing the SAME project on the SAME browser saw each other's
 * own typed table-search text.
 */
test("recent searches are also kept per-user -- two different accounts on the SAME project+entity never see each other's searches", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "overdue invoice dispute");
    addEntityRecentSearch("proj1", "Customer", "userB", "unrelated query");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), ["overdue invoice dispute"]);
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userB"), ["unrelated query"], "userB must never see userA's own typed search text");
  });
});

test("clearEntityRecentSearches wipes only this project+entity+user's list, leaving a sibling entity's list and another user's own list for the SAME entity untouched", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    addEntityRecentSearch("proj1", "Customer", "userA", "zeta");
    addEntityRecentSearch("proj1", "Customer", "userB", "other-user-query");
    addEntityRecentSearch("proj1", "Order", "userA", "paid");
    clearEntityRecentSearches("proj1", "Customer", "userA");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), []);
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userB"), ["other-user-query"], "clearing userA's own list must never touch userB's");
    assert.deepEqual(getEntityRecentSearches("proj1", "Order", "userA"), ["paid"], "clearing Customer must not touch Order's own list");
  });
});

test("removeEntityRecentSearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getEntityRecentSearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    addEntityRecentSearch("proj1", "Customer", "userA", "zeta");
    addEntityRecentSearch("proj1", "Customer", "userA", "mid");
    const after = removeEntityRecentSearch("proj1", "Customer", "userA", "ZETA");
    assert.deepEqual(after, ["mid", "acme"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), ["mid", "acme"], "must actually be persisted, not just returned");
  });
});

test("removeEntityRecentSearch is a no-op when the query isn't in the list", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    const after = removeEntityRecentSearch("proj1", "Customer", "userA", "nonexistent");
    assert.deepEqual(after, ["acme"]);
  });
});

test("getEntityRecentSearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.entityRecentSearches", "not valid json{{{");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), []);

    localStorage.setItem("forge.entityRecentSearches", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), []);

    localStorage.setItem(
      "forge.entityRecentSearches",
      JSON.stringify({ "proj1:Customer:userA": ["acme", 42, null, "zeta"] }),
    );
    assert.deepEqual(
      getEntityRecentSearches("proj1", "Customer", "userA"),
      ["acme", "zeta"],
      "non-string entries must be dropped, not crash the whole read",
    );
  });
});

test("purgeEntityRecentSearchesForEntity removes every collaborator account's own list for that project+entity, leaving a sibling entity's and a different project's entries untouched", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    addEntityRecentSearch("proj1", "Customer", "userB", "other-user-query");
    addEntityRecentSearch("proj1", "Order", "userA", "paid");
    addEntityRecentSearch("proj2", "Customer", "userA", "zeta");
    purgeEntityRecentSearchesForEntity("proj1", "Customer");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), [], "userA's own Customer list must be gone");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userB"), [], "userB's own Customer list must be gone too, not just userA's");
    assert.deepEqual(getEntityRecentSearches("proj1", "Order", "userA"), ["paid"], "a sibling entity in the same project must be untouched");
    assert.deepEqual(getEntityRecentSearches("proj2", "Customer", "userA"), ["zeta"], "the same-named entity in a different project must be untouched");
  });
});

test("purgeEntityRecentSearchesForProject removes every collaborator account's own list across every entity in that project, and never touches another project's entries", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    addEntityRecentSearch("proj1", "Order", "userB", "paid");
    addEntityRecentSearch("proj2", "Customer", "userA", "zeta");
    purgeEntityRecentSearchesForProject("proj1");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), []);
    assert.deepEqual(getEntityRecentSearches("proj1", "Order", "userB"), []);
    assert.deepEqual(getEntityRecentSearches("proj2", "Customer", "userA"), ["zeta"], "a completely different project's own entries must be untouched");
  });
});

/**
 * Round 1128: mirrors entityTabOrder.ts's own round-1127
 * removeEntityTabOrder -- used by projectPreferenceCleanup.ts's
 * purgeOwnProjectAccess for the "this one user's own access ended, the
 * project itself is still alive for everyone else" events (account
 * deletion's shared-project loop; CollaboratorsPanel's self-service
 * "leave project"), where a plain per-user delete is correct (unlike
 * purgeEntityRecentSearchesForProject's every-collaborator sweep, correct
 * only when the project itself is genuinely gone). Unlike that sibling,
 * this store has no single exact key for one user's whole project-wide
 * footprint -- entityName is a third, unknowable segment -- so this also
 * confirms every one of this user's OWN entities (not just one) is swept
 * by the prefix+suffix match, not just whichever single entity a
 * narrower test might happen to check.
 */
test("removeEntityRecentSearchesForUserProject removes only this one user's own lists across every entity of one project, leaving every other collaborator's own lists for the SAME project (and this user's own lists for another project) untouched", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "userA", "acme");
    addEntityRecentSearch("proj1", "Order", "userA", "overdue");
    addEntityRecentSearch("proj1", "Customer", "userB", "zenith");
    addEntityRecentSearch("proj2", "Customer", "userA", "beta corp");

    removeEntityRecentSearchesForUserProject("proj1", "userA");

    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), [], "userA's own Customer list for the left project must be cleared");
    assert.deepEqual(getEntityRecentSearches("proj1", "Order", "userA"), [], "userA's own Order list for the SAME left project must also be cleared, not just one entity");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userB"), ["zenith"], "userB's own list for the SAME still-shared project must survive");
    assert.deepEqual(getEntityRecentSearches("proj2", "Customer", "userA"), ["beta corp"], "userA's own list for an UNRELATED project must survive untouched");
  });
});

test("removeEntityRecentSearchesForUserProject is a no-op, not an error, when this user never searched anything in this project", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => removeEntityRecentSearchesForUserProject("proj1", "userA"));
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer", "userA"), []);
  });
});
