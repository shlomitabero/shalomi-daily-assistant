import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "./password.js";

test("hashPassword + verifyPassword round-trip: the same password verifies against its own hash", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.equal(await verifyPassword("correct-horse-battery-staple", hash), true);
});

test("verifyPassword rejects a wrong password against a real hash", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("verifyPassword returns false (not throw) for a malformed stored hash", async () => {
  assert.equal(await verifyPassword("anything", "not-a-real-stored-hash"), false);
  assert.equal(await verifyPassword("anything", ""), false);
});

test("hashPassword produces a different salt (and hash) each time for the same password", async () => {
  const hash1 = await hashPassword("same-password");
  const hash2 = await hashPassword("same-password");
  assert.notEqual(hash1, hash2);
  // Both still verify correctly despite the different salts.
  assert.equal(await verifyPassword("same-password", hash1), true);
  assert.equal(await verifyPassword("same-password", hash2), true);
});

/**
 * These used to call scryptSync directly, blocking Node's single JS event
 * loop for the entire tens-of-milliseconds cost of the hash -- so every
 * concurrent request (even to totally unrelated routes) had to wait
 * behind it. The fix switches to the async scrypt(), which runs on
 * libuv's threadpool instead, keeping the event loop free. See
 * docs/roadmap.md and password.ts's own comment for the full bug.
 */
test("hashPassword does not block the event loop while it computes (uses the async scrypt, not scryptSync)", async () => {
  let tickCount = 0;
  const interval = setInterval(() => {
    tickCount++;
  }, 2);
  await hashPassword("a-reasonably-long-password-value");
  clearInterval(interval);
  // A blocking scryptSync call leaves the event loop with zero ticks for
  // its whole duration (confirmed empirically: 0 ticks blocking vs. ~47
  // ticks non-blocking for a comparable hash cost) -- this generous floor
  // stays well clear of that boundary without being sensitive to exact
  // machine speed.
  assert.ok(
    tickCount > 3,
    `expected the event loop to keep ticking (setInterval firing) while hashPassword ran, but only saw ${tickCount} tick(s) -- the event loop may be blocked`,
  );
});

test("verifyPassword also does not block the event loop while it computes", async () => {
  const hash = await hashPassword("a-reasonably-long-password-value");
  let tickCount = 0;
  const interval = setInterval(() => {
    tickCount++;
  }, 2);
  await verifyPassword("a-reasonably-long-password-value", hash);
  clearInterval(interval);
  assert.ok(tickCount > 3, `expected the event loop to keep ticking while verifyPassword ran, but only saw ${tickCount} tick(s)`);
});

/**
 * Concurrent hashes should run in parallel on libuv's threadpool (default
 * size 4), not be serialized behind one blocked thread -- so N concurrent
 * hashes should take roughly the time of one, not N times as long.
 */
test("concurrent hashPassword calls run in parallel, not serialized one after another", async () => {
  const singleStart = process.hrtime.bigint();
  await hashPassword("password-a");
  const singleMs = Number(process.hrtime.bigint() - singleStart) / 1e6;

  const concurrentStart = process.hrtime.bigint();
  await Promise.all([hashPassword("password-b"), hashPassword("password-c"), hashPassword("password-d")]);
  const concurrentMs = Number(process.hrtime.bigint() - concurrentStart) / 1e6;

  assert.ok(
    concurrentMs < singleMs * 2.5,
    `expected 3 concurrent hashes to run in parallel (~${singleMs.toFixed(1)}ms), took ${concurrentMs.toFixed(1)}ms (${(concurrentMs / singleMs).toFixed(1)}x a single hash)`,
  );
});
