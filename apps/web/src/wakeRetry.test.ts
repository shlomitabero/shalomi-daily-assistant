import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWithWakeRetry } from "./wakeRetry.js";

function fakeResponse(): Response {
  return new Response("ok", { status: 200 });
}

test("fetchWithWakeRetry returns the response immediately on the first successful attempt, without waking anyone", async () => {
  let calls = 0;
  const wakingEvents: boolean[] = [];
  const res = await fetchWithWakeRetry("/x", undefined, {
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse();
    },
    onWaking: (w) => wakingEvents.push(w),
    sleep: async () => {
      throw new Error("should never sleep when the first attempt succeeds");
    },
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(wakingEvents, []);
});

test("fetchWithWakeRetry retries a network failure and notifies waking(true) then waking(false) once it succeeds", async () => {
  let calls = 0;
  const wakingEvents: boolean[] = [];
  const sleeps: number[] = [];
  const res = await fetchWithWakeRetry("/x", undefined, {
    delaysMs: [10, 20, 30],
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("Load failed");
      return fakeResponse();
    },
    onWaking: (w) => wakingEvents.push(w),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(calls, 3);
  assert.equal(res.status, 200);
  assert.deepEqual(wakingEvents, [true, false]);
  assert.deepEqual(sleeps, [10, 20]);
});

test("fetchWithWakeRetry gives up and rethrows once every delay is exhausted, still notifying waking(false)", async () => {
  const wakingEvents: boolean[] = [];
  await assert.rejects(
    () =>
      fetchWithWakeRetry("/x", undefined, {
        delaysMs: [1, 1],
        fetchImpl: async () => {
          throw new TypeError("Load failed");
        },
        onWaking: (w) => wakingEvents.push(w),
        sleep: async () => {},
      }),
    /Load failed/,
  );
  assert.deepEqual(wakingEvents, [true, false]);
});

// Regression test: a caller-supplied AbortSignal already being aborted when
// fetchImpl throws (e.g. api.ts's own client-side request timeout firing)
// must fail immediately, not get treated as a transient cold-start failure
// worth retrying -- the signal stays aborted, so every retry would fail the
// same way, just after burning through the whole retry backoff for nothing.
test("fetchWithWakeRetry does not retry when the caller's own AbortSignal already fired", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const wakingEvents: boolean[] = [];
  await assert.rejects(
    () =>
      fetchWithWakeRetry(
        "/x",
        { signal: controller.signal },
        {
          delaysMs: [1, 1, 1],
          fetchImpl: async () => {
            calls += 1;
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            throw err;
          },
          onWaking: (w) => wakingEvents.push(w),
          sleep: async () => {
            throw new Error("should never sleep once the caller's own signal is already aborted");
          },
        },
      ),
    /aborted/,
  );
  assert.equal(calls, 1, "must fail on the first attempt, not retry");
  assert.deepEqual(wakingEvents, [], "must never show the waking banner for a deliberate cancellation");
});

// Regression test for a real report from שלומי ("waking the server keeps
// happening, the app doesn't work at all") that reproduced even after
// round 163 already widened DEFAULT_DELAYS_MS once: the retry loop gave up
// the moment its own fixed delay array was exhausted (~101s), even though
// the real caller (api.ts's fetchApi) had handed it an AbortSignal good
// for a full 220s. A cold start landing between those two numbers -- very
// plausible once the server grew auth, the build pipeline, and WhatsApp/
// baileys since round 163 -- threw a hard failure with real budget still
// unused. Retries must now continue past the array, using its last delay,
// for as long as the caller's own signal hasn't fired.
test("fetchWithWakeRetry keeps retrying past its own delay array, using the last delay, when the caller supplied an AbortSignal that hasn't fired yet", async () => {
  const controller = new AbortController();
  let calls = 0;
  const wakingEvents: boolean[] = [];
  const sleeps: number[] = [];
  const res = await fetchWithWakeRetry(
    "/x",
    { signal: controller.signal },
    {
      delaysMs: [10, 20],
      fetchImpl: async () => {
        calls += 1;
        // Fail past the end of the 2-entry delay array (3 failures), then
        // succeed on the 4th call -- proving the loop didn't give up after
        // exhausting [10, 20] just because a signal happens to exist.
        if (calls < 4) throw new TypeError("Load failed");
        return fakeResponse();
      },
      onWaking: (w) => wakingEvents.push(w),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(calls, 4, "must keep retrying past the 2-entry array instead of giving up after 2 failures");
  assert.equal(res.status, 200);
  assert.deepEqual(wakingEvents, [true, false]);
  assert.deepEqual(sleeps, [10, 20, 20], "the 3rd retry must reuse the array's own last delay, not throw");
});

// Companion to the test above: the extended retrying must still actually
// stop once the caller's own signal fires -- "continues past the array"
// must not mean "retries forever no matter what."
test("fetchWithWakeRetry stops retrying past its own delay array once the caller's AbortSignal fires, even if fetchImpl keeps failing", async () => {
  const controller = new AbortController();
  let calls = 0;
  const wakingEvents: boolean[] = [];
  await assert.rejects(
    () =>
      fetchWithWakeRetry(
        "/x",
        { signal: controller.signal },
        {
          delaysMs: [10, 20],
          fetchImpl: async () => {
            calls += 1;
            if (calls === 3) controller.abort();
            const err = new Error("The operation was aborted.");
            err.name = calls === 3 ? "AbortError" : "TypeError";
            throw err;
          },
          onWaking: (w) => wakingEvents.push(w),
          sleep: async () => {},
        },
      ),
    /aborted/,
  );
  assert.equal(calls, 3, "must stop on the attempt that observes the now-fired signal, not retry indefinitely");
  assert.deepEqual(wakingEvents, [true, false]);
});

test("fetchWithWakeRetry does not retry a real HTTP error response (only a thrown network failure)", async () => {
  let calls = 0;
  const res = await fetchWithWakeRetry("/x", undefined, {
    fetchImpl: async () => {
      calls += 1;
      return new Response("nope", { status: 500 });
    },
    sleep: async () => {
      throw new Error("should never sleep for a normal HTTP error response");
    },
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 500);
});
