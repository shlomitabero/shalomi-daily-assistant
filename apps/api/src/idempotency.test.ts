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

/**
 * `userId`/`route` are stored on every row specifically to scope a key to
 * the one request it was chosen for (see packages/db/src/idempotency.ts's
 * own doc comment), but the lookup used to only ever filter by `key`. A
 * key reused across a different user or a different route must never
 * replay or block against that other request -- it has no relation to it
 * at all, and today's header is entirely client-supplied with no other
 * validation, so this is the only server-side defense against exactly
 * that reuse.
 */
test("withIdempotency rejects a key that was already used by a different user or route, instead of replaying or blocking against an unrelated request", async () => {
  const db = setup();
  const first = await withIdempotency(db, "shared-key", "user1", "POST /projects/A/roles", async () => {
    return { status: 200, body: { project: "A" } };
  });
  assert.deepEqual(first.body, { project: "A" });

  let calls = 0;
  await assert.rejects(
    () =>
      withIdempotency(db, "shared-key", "user1", "POST /projects/B/roles", async () => {
        calls += 1;
        return { status: 200, body: { project: "B" } };
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "IDEMPOTENCY_KEY_MISMATCH");
      return true;
    },
  );
  assert.equal(calls, 0, "a route mismatch must reject outright, not run project B's own request");

  await assert.rejects(
    () =>
      withIdempotency(db, "shared-key", "user2", "POST /projects/A/roles", async () => {
        calls += 1;
        return { status: 200, body: { project: "A-for-user2" } };
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "IDEMPOTENCY_KEY_MISMATCH");
      return true;
    },
  );
  assert.equal(calls, 0, "a userId mismatch must reject outright too, even on the exact same route");
});

/**
 * The flip side of "replays the cached response": without the opportunistic
 * prune inside withIdempotency, a 'done' row's cached response would be
 * replayed forever, never expiring, turning the table into a permanent
 * cache rather than the short-lived retry-window mechanism the design doc
 * calls for. Backdates the existing row's createdAt well past the 24h TTL
 * (same raw-SQL pattern apps/api/src/twin.test.ts already uses) and
 * confirms a same-key call afterward re-runs the work instead of replaying
 * the stale cached body.
 */
test("withIdempotency treats a key whose row has aged out past the TTL as brand-new, not a cached replay", async () => {
  const db = setup();
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { status: 201, body: { attempt: calls } };
  };
  const first = await withIdempotency(db, "aged-key", "user1", "POST /projects", run);
  assert.deepEqual(first.body, { attempt: 1 });

  const oneDayMs = 24 * 60 * 60 * 1000;
  const twoDaysAgo = new Date(Date.now() - 2 * oneDayMs).toISOString();
  db.prepare("UPDATE idempotency_keys SET createdAt = ? WHERE key = ?").run(twoDaysAgo, "aged-key");

  const second = await withIdempotency(db, "aged-key", "user1", "POST /projects", run);
  assert.equal(calls, 2, "a key whose row aged out past the TTL must run the work again, not replay the stale cached response");
  assert.deepEqual(second.body, { attempt: 2 });
});
