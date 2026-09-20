import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";

const entityPanelSrc = readFileSync(new URL("./EntityPanel.tsx", import.meta.url), "utf8");

/**
 * Regression test: handleBulkDelete used to await `Promise.all(ids.map(...))`
 * inside a try/catch. A single rejected delete (a dropped connection, a
 * record another browser tab already removed) rejected the whole
 * `Promise.all` immediately, skipping both `refresh()` and the
 * `setSelectedIds` cleanup that followed it -- any records that DID delete
 * successfully stayed listed, and selected, in a now-stale table until the
 * user manually reloaded the page. This extracts the real handleBulkDelete
 * function straight from EntityPanel.tsx (not reimplemented), strips its
 * TypeScript syntax with esbuild (it's a plain async function, no JSX, so
 * the "ts" loader alone is enough), and runs it with a mock deleteRecord
 * that fails for exactly one of several selected ids.
 */
test("EntityPanel's handleBulkDelete refreshes and keeps only the ids that actually failed selected, instead of Promise.all's all-or-nothing hiding the deletes that succeeded", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDelete\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDelete in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  let capturedSelectedIds: Set<number> | undefined;
  let refreshCalled = 0;
  const attemptedIds: number[] = [];

  const fn = new Function(
    "window",
    "t",
    "projectId",
    "entity",
    "selectedIds",
    "setError",
    "deleteRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDelete;`,
  )(
    { confirm: () => true },
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    "proj1",
    { name: "Customer" },
    new Set([1, 2, 3]),
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    async (_projectId: string, _entityName: string, id: number) => {
      attemptedIds.push(id);
      if (id === 2) throw new Error("record 2 network error");
    },
    (next: Set<number>) => {
      capturedSelectedIds = next;
    },
    async () => {
      refreshCalled += 1;
    },
  ) as () => Promise<void>;

  await fn();

  assert.deepEqual(
    attemptedIds.slice().sort(),
    [1, 2, 3],
    "must attempt every selected id, not stop at the first failure",
  );
  assert.deepEqual(
    [...capturedSelectedIds!].sort(),
    [2],
    "only the id that actually failed should remain selected -- the two that succeeded must be cleared",
  );
  assert.match(
    capturedError!,
    /entity\.bulk\.partialFailure/,
    "a partial failure must surface the translated partial-failure message, not the raw single-record rejection",
  );
  assert.equal(
    refreshCalled,
    1,
    "refresh() must still run so the table reflects the records that WERE successfully deleted, even on a partial failure",
  );
});

test("EntityPanel's handleBulkDelete still surfaces the raw error message when every delete in the batch fails", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDelete\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  const rejection = new Error("network error");
  const fn = new Function(
    "window",
    "t",
    "projectId",
    "entity",
    "selectedIds",
    "setError",
    "deleteRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDelete;`,
  )(
    { confirm: () => true },
    (key: string) => key,
    "proj1",
    { name: "Customer" },
    new Set([1]),
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    async () => {
      throw rejection;
    },
    () => {},
    async () => {},
  ) as () => Promise<void>;

  await fn();

  assert.equal(capturedError, rejection.message);
});
