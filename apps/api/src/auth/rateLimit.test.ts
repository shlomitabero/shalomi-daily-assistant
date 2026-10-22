import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { createRateLimiter } from "./rateLimit.js";
import { HttpError } from "../httpError.js";

function fakeRequest(ip: string): Request {
  return { ip } as unknown as Request;
}

function runMiddleware(
  limiter: ReturnType<typeof createRateLimiter>,
  req: Request,
): { blocked: boolean; error?: unknown } {
  let called = false;
  let error: unknown;
  limiter(req, {} as never, (err?: unknown) => {
    called = true;
    error = err;
  });
  assert.equal(called, true, "next() must always be called exactly once, whether allowed or blocked");
  return { blocked: error instanceof HttpError && error.status === 429, error };
}

test("createRateLimiter allows requests under the max and blocks the one that exceeds it", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, keyGenerator: (req) => req.ip ?? "unknown", message: "too many" });
  const req = fakeRequest("1.2.3.4");
  for (let i = 0; i < 3; i++) {
    const { blocked } = runMiddleware(limiter, req);
    assert.equal(blocked, false, `request ${i + 1} of 3 (within the limit) must not be blocked`);
  }
  const fourth = runMiddleware(limiter, req);
  assert.equal(fourth.blocked, true, "the 4th request, exceeding max=3, must be blocked with a 429 HttpError");
  assert.equal((fourth.error as HttpError).code, "RATE_LIMITED");
  assert.equal((fourth.error as HttpError).message, "too many");
});

test("createRateLimiter tracks separate keys independently -- one key being rate-limited never affects another", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, keyGenerator: (req) => req.ip ?? "unknown", message: "too many" });
  const attacker = fakeRequest("9.9.9.9");
  const innocent = fakeRequest("1.1.1.1");
  assert.equal(runMiddleware(limiter, attacker).blocked, false);
  assert.equal(runMiddleware(limiter, attacker).blocked, true, "the attacker's own 2nd request must now be blocked");
  assert.equal(runMiddleware(limiter, innocent).blocked, false, "a completely different key must still get its own fresh allowance");
});

test("createRateLimiter resets a key's count once its window has fully elapsed", () => {
  const realNow = Date.now;
  let mockedNow = 1_000_000;
  Date.now = () => mockedNow;
  try {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, keyGenerator: (req) => req.ip ?? "unknown", message: "too many" });
    const req = fakeRequest("1.2.3.4");
    assert.equal(runMiddleware(limiter, req).blocked, false);
    assert.equal(runMiddleware(limiter, req).blocked, true, "still inside the same window -- must stay blocked");
    mockedNow += 1001; // past the 1000ms window
    assert.equal(runMiddleware(limiter, req).blocked, false, "a new window must grant a fresh allowance for the same key");
  } finally {
    Date.now = realNow;
  }
});
