import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAnthropic } from "./anthropicFetch.js";

test("fetchAnthropic resolves normally when fetchImpl responds before the timeout", async () => {
  const response = new Response("ok", { status: 200 });
  const result = await fetchAnthropic(async () => response, "https://example.com", {}, 1000);
  assert.equal(result, response);
});

/**
 * The bug this covers: api.anthropic.com can accept the TCP connection but
 * never respond (a network stall or an upstream hang) -- without a
 * timeout, the raw fetchImpl(...) call this wraps would hang forever,
 * never resolving or rejecting. Simulates that by never resolving the
 * fetchImpl promise at all, and proves fetchAnthropic still rejects (with
 * the request genuinely aborted) once the timeout elapses.
 */
test("fetchAnthropic rejects once the timeout elapses, instead of hanging forever on a stalled network call", async () => {
  let sawAbortSignal = false;
  const neverResolvingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        sawAbortSignal = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });

  await assert.rejects(
    () => fetchAnthropic(neverResolvingFetch, "https://example.com", {}, 10),
    /timed out after 10ms/,
  );
  assert.ok(sawAbortSignal, "fetchAnthropic must actually abort the in-flight request, not just give up waiting on it");
});

test("fetchAnthropic passes through a real fetchImpl rejection unchanged (e.g. DNS failure), not mistaking it for a timeout", async () => {
  const dnsFailure = new TypeError("fetch failed");
  await assert.rejects(
    () =>
      fetchAnthropic(
        async () => {
          throw dnsFailure;
        },
        "https://example.com",
        {},
        1000,
      ),
    dnsFailure,
  );
});

const noRealDelay = async () => {};

/**
 * Regression test for a real bug found in round 374: a 429/529 response
 * (the two status codes Anthropic's own API documents as transient and
 * safe to retry) used to be treated identically to a genuine 400/401 by
 * every caller, since fetchAnthropic never retried at all -- a single
 * transient hiccup killed requestSpecFix (the Debug Agent's own call,
 * which has no offline fallback whatsoever) outright. Confirms a 429
 * followed by a real 200 now succeeds, and that the call actually happened
 * twice (not just that the final result looks right by coincidence).
 */
test("fetchAnthropic retries once on a 429 response and returns the eventual success", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response("rate limited", { status: 429 }) : new Response("ok", { status: 200 });
  };
  const result = await fetchAnthropic(fetchImpl, "https://example.com", {}, 1000, [10], noRealDelay);
  assert.equal(result.status, 200);
  assert.equal(calls, 2, "must have actually retried, not just returned the first response");
});

/**
 * The same retryable-status handling applies to 529 ("overloaded_error"),
 * Anthropic's other documented transient status, not just 429.
 */
test("fetchAnthropic retries on a 529 response the same way it does on 429", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response("overloaded", { status: 529 }) : new Response("ok", { status: 200 });
  };
  const result = await fetchAnthropic(fetchImpl, "https://example.com", {}, 1000, [10], noRealDelay);
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

/**
 * Once every configured retry has also come back 429/529, fetchAnthropic
 * must give up and return the final failing response to its caller
 * (debug.ts's requestSpecFix turns a non-ok response into a real thrown
 * error) rather than retrying forever.
 */
test("fetchAnthropic gives up and returns the final response once retries are exhausted, never retrying forever", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("still overloaded", { status: 529 });
  };
  const result = await fetchAnthropic(fetchImpl, "https://example.com", {}, 1000, [10, 10], noRealDelay);
  assert.equal(result.status, 529);
  assert.equal(calls, 3, "1 initial attempt + 2 retries (matching the 2 configured delays), then stop");
});

/**
 * A genuine client/auth error (e.g. 400/401) is never retried -- only the
 * two status codes Anthropic documents as transient are. Confirms the
 * call happens exactly once, proving this isn't retried "by accident"
 * (e.g. a bug that retries on ANY non-2xx status).
 */
test("fetchAnthropic never retries a non-retryable status like 400", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  };
  const result = await fetchAnthropic(fetchImpl, "https://example.com", {}, 1000, [10, 10], noRealDelay);
  assert.equal(result.status, 400);
  assert.equal(calls, 1, "a non-retryable status must never trigger a retry");
});
