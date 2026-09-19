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
