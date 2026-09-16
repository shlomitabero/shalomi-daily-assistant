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
