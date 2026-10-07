import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase, ensureIdempotencyKeysTable, insertIdempotencyRecord, getIdempotencyRecord } from "@forge/db";
import { HttpError } from "./httpError.js";
import { withIdempotency } from "./idempotency.js";

function setup() {
  const db = openDatabase(":memory:");
  ensureIdempotencyKeysTable(db);
  return db;
}

test("withIdempotency with no key just runs the work directly, every time", async () => {
  const db = setup();
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { status: 201, body: { n: calls } };
  };
  const a = await withIdempotency(db, undefined, "user1", "POST /projects", run);
  const b = await withIdempotency(db, undefined, "user1", "POST /projects", run);
  assert.equal(calls, 2, "no key means no guard at all -- the work runs every time, same as before this existed");
  assert.deepEqual(a.body, { n: 1 });
  assert.deepEqual(b.body, { n: 2 });
});

test("withIdempotency with a key runs the work once and persists the real response", async () => {
  const db = setup();
  let calls = 0;
  const result = await withIdempotency(db, "key1", "user1", "POST /projects", async () => {
    calls += 1;
    return { status: 201, body: { project: { id: "abc" } } };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: 201, body: { project: { id: "abc" } } });
  const record = getIdempotencyRecord(db, "key1");
  assert.equal(record!.status, "done");
});

/**
 * The core scenario the design doc (round 470) and round 471's trigger
 * both call out by name: "server fully processed the request, client
 * never saw the response, client retries." Simulated here by simply
 * calling withIdempotency a second time with the same key after the first
 * call has already resolved -- from the guard's own point of view, that's
 * indistinguishable from a real network-level retry, since both only ever
 * differ in *why* the same key is reused, never in what the guard sees.
 */
test("withIdempotency replays the cached response for a key whose request already finished, without running the work again", async () => {
  const db = setup();
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { status: 201, body: { project: { id: "abc" }, providerName: "heuristic" } };
  };
  const first = await withIdempotency(db, "retry-key", "user1", "POST /projects", run);
  const second = await withIdempotency(db, "retry-key", "user1", "POST /projects", run);
  assert.equal(calls, 1, "the underlying work (a real AI call plus an insertProject) must only ever run once for one key");
  assert.deepEqual(second, first, "the replayed response must be byte-for-byte identical to what the first attempt actually returned");
});

test("withIdempotency rejects a request whose key is still 'in_progress' with 409 DUPLICATE_REQUEST_IN_PROGRESS, instead of running the work a second time concurrently", async () => {
  const db = setup();
  insertIdempotencyRecord(db, "still-running", "user1", "POST /projects");
  let calls = 0;
  await assert.rejects(
    () =>
      withIdempotency(db, "still-running", "user1", "POST /projects", async () => {
        calls += 1;
        return { status: 201, body: {} };
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "DUPLICATE_REQUEST_IN_PROGRESS");
      return true;
    },
  );
  assert.equal(calls, 0, "the second, concurrent call must never run the guarded work at all");
});

/**
 * Without this, a key whose very first attempt threw (e.g. the AI call
 * failed) would be stuck "in_progress" forever -- every future retry with
 * that same key would get rejected as a duplicate-in-progress request
 * that in reality never completed and never will, with no way to ever
 * succeed.
 */
test("withIdempotency clears the key's row when the guarded work throws, so a retry after a real failure can still succeed", async () => {
  const db = setup();
  await assert.rejects(() =>
    withIdempotency(db, "failing-key", "user1", "POST /projects", async () => {
      throw new Error("the AI call failed");
    }),
  );
  assert.equal(getIdempotencyRecord(db, "failing-key"), undefined, "a failed attempt must not leave a stuck 'in_progress' row behind");

  let calls = 0;
  const result = await withIdempotency(db, "failing-key", "user1", "POST /projects", async () => {
    calls += 1;
    return { status: 201, body: { ok: true } };
  });
  assert.equal(calls, 1, "the retry must actually run the work, not be wrongly rejected as a duplicate of the failed attempt");
  assert.deepEqual(result, { status: 201, body: { ok: true } });
});
