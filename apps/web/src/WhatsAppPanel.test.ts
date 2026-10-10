import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { WhatsAppPanel } from "./WhatsAppPanel.js";
import { getWhatsAppLogFilter } from "./whatsappLogFilter.js";
import { getWhatsAppLastSeenId } from "./whatsappUnread.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

const whatsAppPanelSrc = readFileSync(new URL("./WhatsAppPanel.tsx", import.meta.url), "utf8");

/**
 * Regression test: handleDisconnect stops both polling loops (the fast
 * QR-waiting poll and the slow background "is WhatsApp still linked"
 * poll) BEFORE awaiting the disconnect request, so a request already in
 * flight can't race a reconnect. That's correct when the request
 * succeeds. But when the request itself fails (network error, expired
 * session) nothing actually changed server-side -- the panel was
 * connected before the click and still is -- yet the background
 * connected-poll it just stopped was never resumed. The panel silently
 * loses all monitoring for WhatsApp dropping the link on its own until
 * the user closes and reopens the panel, exactly the "stuck showing
 * Connected with no way to confirm it" failure mode this file's own
 * comments describe fixing elsewhere. Extracts the real handleDisconnect
 * from WhatsAppPanel.tsx, strips its TypeScript with esbuild, and runs it
 * with a mock disconnectWhatsApp that rejects while status is "connected".
 */
test("WhatsAppPanel's handleDisconnect resumes the background connected-poll after a failed disconnect attempt, instead of leaving an unmonitored 'connected' panel", async () => {
  const handlerMatch = whatsAppPanelSrc.match(/ {2}async function handleDisconnect\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleDisconnect in WhatsAppPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedLoadError: string | undefined;
  let startConnectedPollingCalls = 0;
  let stopPollingCalls = 0;
  let stopConnectedPollingCalls = 0;
  const rejection = new Error("network error");
  const messagesVersionRef = { current: 0 };

  const fn = new Function(
    "status",
    "setDisconnecting",
    "stopPolling",
    "stopConnectedPolling",
    "disconnectWhatsApp",
    "messagesVersionRef",
    "setStatus",
    "setMessages",
    "setHasMoreMessages",
    "setLoadError",
    "startConnectedPolling",
    "projectId",
    `${code}\nreturn handleDisconnect;`,
  )(
    { status: "connected" },
    () => {},
    () => {
      stopPollingCalls += 1;
    },
    () => {
      stopConnectedPollingCalls += 1;
    },
    async () => {
      throw rejection;
    },
    messagesVersionRef,
    () => {},
    () => {},
    () => {},
    (msg: string) => {
      capturedLoadError = msg;
    },
    () => {
      startConnectedPollingCalls += 1;
    },
    "proj1",
  ) as () => Promise<void>;

  await fn();

  assert.equal(stopPollingCalls, 1, "must still stop the fast poll before attempting the request");
  assert.equal(stopConnectedPollingCalls, 1, "must still stop the connected poll before attempting the request");
  assert.equal(capturedLoadError, rejection.message);
  assert.equal(
    startConnectedPollingCalls,
    1,
    "a failed disconnect while previously connected must resume the connected-poll it just stopped",
  );
  assert.equal(messagesVersionRef.current, 0, "a disconnect request that never succeeded must not bump the version");
});

test("WhatsAppPanel's handleDisconnect does not resume connected-polling after a successful disconnect (the status is genuinely no longer connected)", async () => {
  const handlerMatch = whatsAppPanelSrc.match(/ {2}async function handleDisconnect\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let startConnectedPollingCalls = 0;
  let capturedStatus: unknown;
  const messagesVersionRef = { current: 7 };

  const fn = new Function(
    "status",
    "setDisconnecting",
    "stopPolling",
    "stopConnectedPolling",
    "disconnectWhatsApp",
    "messagesVersionRef",
    "setStatus",
    "setMessages",
    "setHasMoreMessages",
    "setLoadError",
    "startConnectedPolling",
    "projectId",
    `${code}\nreturn handleDisconnect;`,
  )(
    { status: "connected" },
    () => {},
    () => {},
    () => {},
    async () => ({ status: "disconnected" }),
    messagesVersionRef,
    (next: unknown) => {
      capturedStatus = next;
    },
    () => {},
    () => {},
    () => {},
    () => {
      startConnectedPollingCalls += 1;
    },
    "proj1",
  ) as () => Promise<void>;

  await fn();

  assert.deepEqual(capturedStatus, { status: "disconnected" });
  assert.equal(startConnectedPollingCalls, 0, "a genuinely successful disconnect must not resume connected-polling");
  assert.equal(
    messagesVersionRef.current,
    8,
    "a genuinely successful disconnect must bump the version, the signal startPolling's own tick uses to discard a stale in-flight message fetch (round 530)",
  );
});

/**
 * Regression test: unlike startConnectedPolling (which already guards
 * against this via cancelInFlightConnectedCheckRef), startPolling's own
 * getWhatsAppStatus call had no protection against a call already in
 * flight when stopPolling() runs (from handleDisconnect, or a fresh
 * handleConnect while still mid-QR-wait) -- clearInterval only stops
 * *future* ticks, so that one already-in-flight request would still
 * resolve afterward and call setStatus with its now-stale "connecting"/
 * "qr" payload, silently clobbering whatever correct status was set in
 * the meantime. Extracts the real stopPolling + startPolling from
 * WhatsAppPanel.tsx (not stopConnectedPolling/startConnectedPolling,
 * which startPolling only references as a free variable here), injects a
 * fake setInterval that captures the tick callback for manual, synchronous
 * control instead of waiting on real 1.5s timers, and a controllable
 * getWhatsAppStatus mock to hold one request open past an external
 * stopPolling() call.
 */
test("WhatsAppPanel's startPolling discards a getWhatsAppStatus response that resolves after stopPolling() was already called", async () => {
  const stopMatch = whatsAppPanelSrc.match(/ {2}function stopPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  const startMatch = whatsAppPanelSrc.match(/ {2}function startPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(stopMatch, "expected to find stopPolling in WhatsAppPanel.tsx");
  assert.ok(startMatch, "expected to find startPolling in WhatsAppPanel.tsx");
  const { code } = transformSync(`${stopMatch![0]}\n${startMatch![0]}`, { loader: "ts" });

  let tickFn: (() => Promise<void>) | undefined;
  const fakeSetInterval = ((fn: () => Promise<void>) => {
    tickFn = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const fakeClearInterval = (() => {
    tickFn = undefined;
  }) as typeof clearInterval;

  let resolveGetStatus!: (value: { status: string }) => void;
  const heldStatus = new Promise((resolve) => {
    resolveGetStatus = resolve;
  });
  const capturedStatuses: unknown[] = [];

  const pollRef = { current: null as unknown };
  const cancelInFlightPollRef = { current: null as (() => void) | null };
  const pollFailuresRef = { current: 0 };

  const { stopPolling, startPolling } = new Function(
    "pollRef",
    "cancelInFlightPollRef",
    "pollFailuresRef",
    "setInterval",
    "clearInterval",
    "getWhatsAppStatus",
    "setStatus",
    "listWhatsAppMessages",
    "setMessages",
    "startConnectedPolling",
    "setLoadError",
    "MAX_CONSECUTIVE_POLL_FAILURES",
    "POLL_INTERVAL_MS",
    "projectId",
    `${code}\nreturn { stopPolling, startPolling };`,
  )(
    pollRef,
    cancelInFlightPollRef,
    pollFailuresRef,
    fakeSetInterval,
    fakeClearInterval,
    () => heldStatus,
    (next: unknown) => {
      capturedStatuses.push(next);
    },
    async () => ({ messages: [] }),
    () => {},
    () => {},
    () => {},
    5,
    1500,
    "proj1",
  ) as { stopPolling: () => void; startPolling: () => void };

  startPolling();
  assert.ok(tickFn, "expected startPolling to register an interval callback");
  const tickPromise = tickFn!();

  // Simulate the external stopPolling() call a real handleDisconnect (or a
  // fresh handleConnect) makes while this tick's own getWhatsAppStatus is
  // still in flight.
  stopPolling();

  resolveGetStatus({ status: "qr" });
  await tickPromise;

  assert.deepEqual(capturedStatuses, [], "a status that resolves after stopPolling() must never reach setStatus");
});

/**
 * Sanity counterpart to the race test just below: with no concurrent
 * disconnect, startPolling's own "becoming connected" branch must still
 * apply the fetched message page and start connected-polling exactly like
 * before the messagesVersionRef guard was added (round 530) -- the guard
 * must only skip a stale fetch, never the normal non-racing path.
 */
test("WhatsAppPanel's startPolling applies the fetched message page and starts connected-polling when becoming connected, with no concurrent disconnect", async () => {
  const stopMatch = whatsAppPanelSrc.match(/ {2}function stopPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  const startMatch = whatsAppPanelSrc.match(/ {2}function startPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(`${stopMatch![0]}\n${startMatch![0]}`, { loader: "ts" });

  let tickFn: (() => Promise<void>) | undefined;
  const fakeSetInterval = ((fn: () => Promise<void>) => {
    tickFn = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const fakeClearInterval = (() => {
    tickFn = undefined;
  }) as typeof clearInterval;

  const pollRef = { current: null as unknown };
  const cancelInFlightPollRef = { current: null as (() => void) | null };
  const pollFailuresRef = { current: 0 };
  const messagesVersionRef = { current: 5 };
  let startConnectedPollingCalls = 0;
  let capturedMessages: unknown;
  let capturedHasMore: unknown;

  const { startPolling } = new Function(
    "pollRef",
    "cancelInFlightPollRef",
    "pollFailuresRef",
    "messagesVersionRef",
    "setInterval",
    "clearInterval",
    "getWhatsAppStatus",
    "setStatus",
    "listWhatsAppMessages",
    "setMessages",
    "setHasMoreMessages",
    "startConnectedPolling",
    "setLoadError",
    "MAX_CONSECUTIVE_POLL_FAILURES",
    "POLL_INTERVAL_MS",
    "projectId",
    `${code}\nreturn { stopPolling, startPolling };`,
  )(
    pollRef,
    cancelInFlightPollRef,
    pollFailuresRef,
    messagesVersionRef,
    fakeSetInterval,
    fakeClearInterval,
    async () => ({ status: "connected" }),
    () => {},
    async () => ({ messages: [{ id: "m1" }], hasMore: true }),
    (messages: unknown) => {
      capturedMessages = messages;
    },
    (hasMore: unknown) => {
      capturedHasMore = hasMore;
    },
    () => {
      startConnectedPollingCalls += 1;
    },
    () => {},
    5,
    1500,
    "proj1",
  ) as { startPolling: () => void };

  startPolling();
  assert.ok(tickFn, "expected startPolling to register an interval callback");
  await tickFn!();

  assert.deepEqual(capturedMessages, [{ id: "m1" }]);
  assert.equal(capturedHasMore, true);
  assert.equal(startConnectedPollingCalls, 1, "becoming connected with no race must start connected-polling");
});

/**
 * Regression test: startPolling's own "becoming connected" branch awaits
 * listWhatsAppMessages, then unconditionally applied it via
 * setMessages/setHasMoreMessages/startConnectedPolling -- even if a
 * disconnect (handleDisconnect) happened server-side while that fetch was
 * still in flight. stopPolling() running just above (as part of this exact
 * same tick, transitioning out of "connecting"/"qr") sets this tick's own
 * `cancelled` closure variable to true as a side effect every time, so a
 * naive `if (cancelled) return;` check right after the await can't tell
 * that apart from a genuine concurrent disconnect -- it would also wrongly
 * discard the normal, non-racing result tested just above. The real fix
 * (round 530) is the same messagesVersionRef idiom already proven for
 * startConnectedPolling's own message-refresh (see the "never resurrects a
 * message deleted" test below) and for handleDeleteMessage/
 * handleClearHistory: handleDisconnect bumps the version after disconnect
 * succeeds, and this tick only applies its fetch if nothing bumped the
 * version while it awaited.
 */
test("WhatsAppPanel's startPolling discards a listWhatsAppMessages page fetched while becoming connected if a disconnect happened during that fetch", async () => {
  const stopMatch = whatsAppPanelSrc.match(/ {2}function stopPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  const startMatch = whatsAppPanelSrc.match(/ {2}function startPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(`${stopMatch![0]}\n${startMatch![0]}`, { loader: "ts" });

  let tickFn: (() => Promise<void>) | undefined;
  const fakeSetInterval = ((fn: () => Promise<void>) => {
    tickFn = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const fakeClearInterval = (() => {
    tickFn = undefined;
  }) as typeof clearInterval;

  const pollRef = { current: null as unknown };
  const cancelInFlightPollRef = { current: null as (() => void) | null };
  const pollFailuresRef = { current: 0 };
  const messagesVersionRef = { current: 0 };
  let startConnectedPollingCalls = 0;
  let setMessagesCalls = 0;
  let setHasMoreMessagesCalls = 0;

  let resolveFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    resolveFetchStarted = resolve;
  });
  let releaseListMessages!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseListMessages = resolve;
  });

  const { startPolling } = new Function(
    "pollRef",
    "cancelInFlightPollRef",
    "pollFailuresRef",
    "messagesVersionRef",
    "setInterval",
    "clearInterval",
    "getWhatsAppStatus",
    "setStatus",
    "listWhatsAppMessages",
    "setMessages",
    "setHasMoreMessages",
    "startConnectedPolling",
    "setLoadError",
    "MAX_CONSECUTIVE_POLL_FAILURES",
    "POLL_INTERVAL_MS",
    "projectId",
    `${code}\nreturn { stopPolling, startPolling };`,
  )(
    pollRef,
    cancelInFlightPollRef,
    pollFailuresRef,
    messagesVersionRef,
    fakeSetInterval,
    fakeClearInterval,
    async () => ({ status: "connected" }),
    () => {},
    async () => {
      resolveFetchStarted();
      await held;
      return { messages: [{ id: "m1" }], hasMore: true };
    },
    () => {
      setMessagesCalls += 1;
    },
    () => {
      setHasMoreMessagesCalls += 1;
    },
    () => {
      startConnectedPollingCalls += 1;
    },
    () => {},
    5,
    1500,
    "proj1",
  ) as { startPolling: () => void };

  startPolling();
  assert.ok(tickFn, "expected startPolling to register an interval callback");
  const tickPromise = tickFn!();

  // Wait for the tick to actually reach its own listWhatsAppMessages call
  // before simulating handleDisconnect's version bump -- a real network
  // fetch would take real time, exactly like this held-open promise.
  await fetchStarted;
  messagesVersionRef.current += 1;
  releaseListMessages();
  await tickPromise;

  assert.equal(setMessagesCalls, 0, "a disconnect mid-fetch must discard this tick's stale message page");
  assert.equal(setHasMoreMessagesCalls, 0, "a disconnect mid-fetch must discard this tick's stale hasMore flag");
  assert.equal(
    startConnectedPollingCalls,
    0,
    "a disconnect mid-fetch must never restart connected-polling for a connection that's already gone",
  );
});

/**
 * Regression test for a real gap found by round 288's Explore survey: while
 * the panel was open and connected, startConnectedPolling only re-checked
 * whether the WhatsApp link itself was still alive -- it never re-fetched
 * the message log, so an inbound message never appeared until the user
 * closed and reopened the panel (the one thing a live chat/inbox log is
 * expected to do on its own). Confirms each connected-poll tick now also
 * fetches the newest page and merges it into state: a genuinely new
 * message (by id) is prepended, an already-loaded message is not
 * duplicated, and the relative order of previously-loaded messages (and
 * any pagination reached via "load older") is left untouched. Uses the
 * same fake-setInterval/new-Function extraction technique as the
 * startPolling test just above.
 */
test("WhatsAppPanel's startConnectedPolling also refreshes the message log each tick, prepending newly arrived messages without duplicating already-loaded ones", async () => {
  const stopMatch = whatsAppPanelSrc.match(/ {2}function stopConnectedPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  const startMatch = whatsAppPanelSrc.match(/ {2}function startConnectedPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(stopMatch, "expected to find stopConnectedPolling in WhatsAppPanel.tsx");
  assert.ok(startMatch, "expected to find startConnectedPolling in WhatsAppPanel.tsx");
  const { code } = transformSync(`${stopMatch![0]}\n${startMatch![0]}`, { loader: "ts" });

  let tickFn: (() => Promise<void>) | undefined;
  const fakeSetInterval = ((fn: () => Promise<void>) => {
    tickFn = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const fakeClearInterval = (() => {
    tickFn = undefined;
  }) as typeof clearInterval;

  const connectedPollRef = { current: null as unknown };
  const cancelInFlightConnectedCheckRef = { current: null as (() => void) | null };
  const connectedPollFailuresRef = { current: 0 };

  function makeMsg(id: string): WhatsAppMessageLogEntry {
    return {
      id,
      direction: "in",
      fromNumber: "+1000",
      toNumber: "+2000",
      body: id,
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
  }
  const existingBeforeThisTick = [makeMsg("m2"), makeMsg("m1")]; // newest first, as the real log is
  // The server's own newest-page fetch: one brand-new message ("m3") plus
  // the newest already-loaded one ("m2") still in range -- a real fetch
  // would include both, not just the delta.
  const freshPage = [makeMsg("m3"), makeMsg("m2")];
  let capturedMessages: WhatsAppMessageLogEntry[] | undefined;

  const { stopConnectedPolling, startConnectedPolling } = new Function(
    "connectedPollRef",
    "cancelInFlightConnectedCheckRef",
    "connectedPollFailuresRef",
    "messagesVersionRef",
    "setInterval",
    "clearInterval",
    "getWhatsAppStatus",
    "setStatus",
    "startPolling",
    "listWhatsAppMessages",
    "setMessages",
    "setLoadError",
    "MAX_CONSECUTIVE_CONNECTED_POLL_FAILURES",
    "CONNECTED_POLL_INTERVAL_MS",
    "projectId",
    "mergeFreshMessages",
    `${code}\nreturn { stopConnectedPolling, startConnectedPolling };`,
  )(
    connectedPollRef,
    cancelInFlightConnectedCheckRef,
    connectedPollFailuresRef,
    { current: 0 },
    fakeSetInterval,
    fakeClearInterval,
    async () => ({ status: "connected" }),
    () => {},
    () => {},
    async () => ({ messages: freshPage, hasMore: false }),
    (updater: (prev: WhatsAppMessageLogEntry[]) => WhatsAppMessageLogEntry[]) => {
      capturedMessages = updater(existingBeforeThisTick);
    },
    () => {},
    5,
    10000,
    "proj1",
    (prev: WhatsAppMessageLogEntry[], fresh: WhatsAppMessageLogEntry[]) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const newOnes = fresh.filter((m) => !existingIds.has(m.id));
      return newOnes.length === 0 ? prev : [...newOnes, ...prev];
    },
  ) as { stopConnectedPolling: () => void; startConnectedPolling: () => void };

  startConnectedPolling();
  assert.ok(tickFn, "expected startConnectedPolling to register an interval callback");
  await tickFn!();

  assert.deepEqual(
    capturedMessages?.map((m) => m.id),
    ["m3", "m2", "m1"],
    "the new message (m3) is prepended, the already-loaded one (m2) is not duplicated, and m1 is preserved",
  );
});

/**
 * Regression test for a real race found by round 431's Explore survey:
 * mergeFreshMessages is purely additive (it can only add an id missing
 * from `prev`, never remove one it no longer sees). If handleDeleteMessage
 * or handleClearHistory removes a message while this tick's own
 * listWhatsAppMessages fetch is already in flight, that fetch's response
 * still reflects the pre-deletion log -- once it resolves, the merge
 * would treat every id in it as "new" relative to the now-shorter `prev`
 * and splice the just-deleted message right back in, permanently (the
 * next tick's genuinely up-to-date fetch computes zero new ids and leaves
 * the wrongly-resurrected list untouched). Confirms the fix:
 * messagesVersionRef (bumped by handleDeleteMessage/handleClearHistory,
 * simulated directly here since this test extracts only
 * startConnectedPolling itself) changing while the fetch is held open
 * means its result is discarded -- setMessages is never even called for
 * this tick -- rather than merged into state.
 */
test("WhatsAppPanel's connected-poll tick never resurrects a message deleted while its own message-refresh fetch was still in flight", async () => {
  const stopMatch = whatsAppPanelSrc.match(/ {2}function stopConnectedPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  const startMatch = whatsAppPanelSrc.match(/ {2}function startConnectedPolling\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(stopMatch, "expected to find stopConnectedPolling in WhatsAppPanel.tsx");
  assert.ok(startMatch, "expected to find startConnectedPolling in WhatsAppPanel.tsx");
  const { code: raceCode } = transformSync(`${stopMatch![0]}\n${startMatch![0]}`, { loader: "ts" });

  let raceTickFn: (() => Promise<void>) | undefined;
  const fakeSetIntervalForRace = ((fn: () => Promise<void>) => {
    raceTickFn = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const fakeClearIntervalForRace = (() => {
    raceTickFn = undefined;
  }) as typeof clearInterval;

  const connectedPollRefForRace = { current: null as unknown };
  const cancelInFlightConnectedCheckRefForRace = { current: null as (() => void) | null };
  const connectedPollFailuresRefForRace = { current: 0 };
  const messagesVersionRef = { current: 0 };

  function makeRaceMsg(id: string): WhatsAppMessageLogEntry {
    return {
      id,
      direction: "in",
      fromNumber: "+1000",
      toNumber: "+2000",
      body: id,
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
  }
  // This tick's own fetch, issued before the user's concurrent delete --
  // it still reflects the pre-deletion log.
  const stalePage = [makeRaceMsg("m2"), makeRaceMsg("m1")];

  let releaseListMessages: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseListMessages = resolve;
  });
  // getWhatsAppStatus's own `await` (real code, above listWhatsAppMessages)
  // needs a microtask turn to resolve before the tick's continuation even
  // reaches `const versionBeforeFetch = messagesVersionRef.current;` --
  // bumping the version synchronously right after calling raceTickFn()
  // would race ahead of that capture and land before it, not during the
  // listWhatsAppMessages call this test means to simulate. Waiting for the
  // listWhatsAppMessages stub to actually be entered (same technique as
  // round 424's "waits for logout() to actually be entered") guarantees
  // the version bump below lands strictly after versionBeforeFetch was
  // already captured.
  let resolveFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    resolveFetchStarted = resolve;
  });
  let setMessagesCallCount = 0;

  const { startConnectedPolling: startRacePolling } = new Function(
    "connectedPollRef",
    "cancelInFlightConnectedCheckRef",
    "connectedPollFailuresRef",
    "messagesVersionRef",
    "setInterval",
    "clearInterval",
    "getWhatsAppStatus",
    "setStatus",
    "startPolling",
    "listWhatsAppMessages",
    "setMessages",
    "setLoadError",
    "MAX_CONSECUTIVE_CONNECTED_POLL_FAILURES",
    "CONNECTED_POLL_INTERVAL_MS",
    "projectId",
    "mergeFreshMessages",
    `${raceCode}\nreturn { stopConnectedPolling, startConnectedPolling };`,
  )(
    connectedPollRefForRace,
    cancelInFlightConnectedCheckRefForRace,
    connectedPollFailuresRefForRace,
    messagesVersionRef,
    fakeSetIntervalForRace,
    fakeClearIntervalForRace,
    async () => ({ status: "connected" }),
    () => {},
    () => {},
    async () => {
      resolveFetchStarted!();
      await held;
      return { messages: stalePage, hasMore: false };
    },
    () => {
      setMessagesCallCount += 1;
    },
    () => {},
    5,
    10000,
    "proj1",
    (prev: WhatsAppMessageLogEntry[], fresh: WhatsAppMessageLogEntry[]) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const newOnes = fresh.filter((m) => !existingIds.has(m.id));
      return newOnes.length === 0 ? prev : [...newOnes, ...prev];
    },
  ) as { startConnectedPolling: () => void };

  startRacePolling();
  assert.ok(raceTickFn, "expected startConnectedPolling to register an interval callback");
  const tickPromise = raceTickFn!();

  // Wait for the tick to actually reach its own listWhatsAppMessages call
  // before simulating handleDeleteMessage's version bump -- a real network
  // fetch would take real time, exactly like this held-open promise.
  await fetchStarted;
  messagesVersionRef.current += 1;
  releaseListMessages!();
  await tickPromise;

  assert.equal(
    setMessagesCallCount,
    0,
    "a message-refresh fetch that started before a delete/clear must never apply its now-stale result",
  );
});

/** Same jsdom-swap technique as useDialogFocusTrap.test.ts/EntityPanel.test.ts. */
async function withJsdom<T>(fn: () => Promise<T> | T): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  const replacements: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    localStorage: window.localStorage,
  };
  const originalDescriptors: Record<string, PropertyDescriptor | undefined> = {};
  for (const key of Object.keys(replacements)) {
    originalDescriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value: replacements[key],
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  try {
    const result = await fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return result;
  } finally {
    cleanup();
    for (const key of Object.keys(replacements)) {
      const original = originalDescriptors[key];
      if (original) Object.defineProperty(globalThis, key, original);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

async function waitForCondition(check: () => boolean, maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitForCondition: condition never became true");
}

/**
 * New in this round: a failed initial status fetch left the panel
 * permanently showing the plain "disconnected" Connect box with only a
 * generic error line above it -- no way to retry the status check itself
 * short of closing and reopening the panel. BusinessTwinPanel already had
 * this exact "Retry" pattern; this closes the identical, previously-missing
 * gap here, via a new initialLoadError distinct from the shared loadError
 * (which still covers connect/disconnect/send/load-more failures, each of
 * which already has its own clear retry action). Confirms the real
 * error+Retry row appears, and clicking Retry genuinely re-fetches the real
 * status (not a reimplementation).
 */
test("WhatsAppPanel shows a real error with a Retry button when the initial status fetch fails", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "Server exploded" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "disconnected", phoneNumber: "972501234567", qrDataUrl: null, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelector(".error-retry-row") !== null);

      assert.match(document.querySelector(".error-retry-row p.error")!.textContent ?? "", /Server exploded/);
      assert.equal(
        document.querySelector(".error-retry-row p.error")!.getAttribute("role"),
        "status",
        "the error must be announced to screen readers, not just shown visually",
      );

      const retryButton = document.querySelector(".error-retry-row button") as HTMLButtonElement;
      assert.ok(retryButton, "expected a real Retry button");

      fireEvent.click(retryButton);
      await waitForCondition(() => (document.body.textContent ?? "").includes("972501234567"));

      assert.equal(
        document.querySelector(".error-retry-row"),
        null,
        "the error+Retry row must disappear once the retry succeeds",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Real-DOM coverage for handleSendTest -- the two typed text fields
 * (recipient number, message body) had never been exercised through a
 * real render, only via handleDisconnect's own function-extraction tests
 * above. This is exactly the class of bug jsdomWarmup.ts's own fix
 * addresses: confirms the *exact* typed recipient/message genuinely reach
 * the real POST body sendWhatsAppMessage sends, not just the inputs' own
 * DOM `.value`, and that a successful send refreshes the message log with
 * the real server response.
 */
test("WhatsAppPanel sends the exact typed recipient/message and refreshes the message log", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let capturedSendBody: string | undefined;
    let sent = false;
    const sentMessage: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "out",
      fromNumber: "972501234567",
      toNumber: "972521112233",
      body: "Hello from test",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "sent",
      createdAt: new Date().toISOString(),
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: sent ? [sentMessage] : [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/integrations/whatsapp/send") {
        capturedSendBody = init!.body as string;
        sent = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-test-form") !== null);

      const inputs = document.querySelectorAll('.whatsapp-test-form input[type="text"]');
      const toInput = inputs[0] as HTMLInputElement;
      const messageInput = inputs[1] as HTMLInputElement;
      fireEvent.change(toInput, { target: { value: "972521112233" } });
      fireEvent.change(messageInput, { target: { value: "Hello from test" } });

      const form = document.querySelector("form.whatsapp-test-form")!;
      fireEvent.submit(form);

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      assert.equal(typeof capturedSendBody, "string", "the send request must actually have been sent with a body");
      const parsed = JSON.parse(capturedSendBody!);
      assert.equal(parsed.to, "972521112233", "the exact typed recipient number must reach the send request body");
      assert.equal(parsed.message, "Hello from test", "the exact typed message must reach the send request body");

      const logEntry = document.querySelector(".whatsapp-log-list li")!;
      assert.match(logEntry.textContent ?? "", /Hello from test/, "the message log must reflect the real server response after sending");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a `prefillTo` prop lets a caller (EntityPanel's
 * "Send WhatsApp" row action, via App.tsx) open this panel with the
 * test-send "to" box already filled in, instead of forcing the user to
 * copy the phone number out of the record and paste it in by hand.
 * Confirms the real rendered input starts with that value, and that
 * submitting the form without touching the field sends exactly that
 * number, proving it's real component state (not just a placeholder).
 */
test("WhatsAppPanel's prefillTo prop pre-fills the real test-send 'to' input, which sends as-is without being touched", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let capturedSendBody: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/integrations/whatsapp/send") {
        capturedSendBody = init!.body as string;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, {
              projectId: "proj1",
              projectName: "Test Project",
              onClose: () => {},
              onJumpToEntity: () => {},
              onJumpToRecord: () => {},
              prefillTo: "0501234567",
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-test-form") !== null);

      const toInput = document.querySelector('.whatsapp-test-form input[type="text"]') as HTMLInputElement;
      assert.equal(toInput.value, "0501234567", "the real 'to' input must start pre-filled with the given phone number");

      const messageInput = document.querySelectorAll('.whatsapp-test-form input[type="text"]')[1] as HTMLInputElement;
      fireEvent.change(messageInput, { target: { value: "Hi from the record row" } });
      fireEvent.submit(document.querySelector("form.whatsapp-test-form")!);

      await waitForCondition(() => typeof capturedSendBody === "string");
      assert.equal(JSON.parse(capturedSendBody!).to, "0501234567", "submitting without touching the prefilled field must send the exact prefilled number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: an inbound message had no way to reply to it
 * directly -- only a delete button (and, for a failed outbound message,
 * Retry) -- forcing the user to scroll up and copy the sender's number by
 * hand into the test-send "to" field. A new "Reply" button on every
 * inbound log row fills the real "to" input with that message's own
 * fromNumber, reusing the exact same state (and send path) as the
 * existing recent-numbers chips. Confirms it's real component state, not
 * a dead button: after clicking Reply, typing a message and submitting
 * sends to the replied-to number, not whatever was there before.
 */
test("WhatsAppPanel's Reply button on an inbound message fills the real test-send 'to' input with that message's sender, and sending afterward uses it", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const messages: WhatsAppMessageLogEntry[] = [
      {
        id: "m1",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Hi, do you have this in stock?",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    let capturedSendBody: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/integrations/whatsapp/send") {
        capturedSendBody = init!.body as string;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      const toInputBefore = document.querySelector('.whatsapp-test-form input[type="text"]') as HTMLInputElement;
      assert.equal(toInputBefore.value, "", "the 'to' input must start empty -- nothing prefilled this time");

      const logRow = document.querySelector(".whatsapp-log-in") as HTMLElement;
      assert.ok(logRow, "expected the inbound message's own row");
      const replyButtons = [...logRow.querySelectorAll("button")].filter((b) => b.textContent === "Reply");
      assert.equal(replyButtons.length, 1, "expected exactly one real Reply button on the inbound row");
      fireEvent.click(replyButtons[0]);

      const toInputAfter = document.querySelector('.whatsapp-test-form input[type="text"]') as HTMLInputElement;
      assert.equal(toInputAfter.value, "972521112233", "clicking Reply must fill the real 'to' input with the message's own sender number");

      const messageInput = document.querySelectorAll('.whatsapp-test-form input[type="text"]')[1] as HTMLInputElement;
      fireEvent.change(messageInput, { target: { value: "Yes, it's in stock!" } });
      fireEvent.submit(document.querySelector("form.whatsapp-test-form")!);

      await waitForCondition(() => typeof capturedSendBody === "string");
      const parsed = JSON.parse(capturedSendBody!);
      assert.equal(parsed.to, "972521112233", "sending after Reply must use the replied-to sender, not a stale or empty value");
      assert.equal(parsed.message, "Yes, it's in stock!");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 289's WhatsApp unread-badge feature
 * (whatsappUnread.ts + App.tsx's topbar poll): the badge reads its "last
 * seen" marker purely from localStorage, written by this panel -- if the
 * panel never actually wrote it after loading real messages, the badge
 * would have no way to ever settle back to 0 after being opened. Confirms
 * a real render, connected with messages already present, ends up with
 * the newest message's id (not any other message's, and not left empty)
 * persisted as the last-seen marker for this exact project.
 */
test("WhatsAppPanel marks the newest loaded message as 'seen' in localStorage once messages load, for the topbar's own unread badge to read", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const messages: WhatsAppMessageLogEntry[] = [
      {
        id: "m2",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Newest",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
      {
        id: "m1",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Older",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      assert.equal(getWhatsAppLastSeenId("proj1"), null, "nothing should be marked seen before the panel has ever loaded anything");

      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 2);
      // The DOM commit and the "mark seen" effect are two separate
      // useEffects reacting to the same `messages` update -- React's
      // scheduler can run the DOM-affecting render and flush this file's
      // passive effects on separate scheduler ticks, so poll the actual
      // thing under test (the storage write) rather than assuming it's
      // already landed the instant the DOM looks right.
      await waitForCondition(() => getWhatsAppLastSeenId("proj1") !== null);

      assert.equal(getWhatsAppLastSeenId("proj1"), "m2", "the newest loaded message's id must be marked seen, not the older one and not left empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function mockConnectedStatusFetch(): typeof fetch {
  return (async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
      return new Response(
        JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${method} ${input}`);
  }) as typeof fetch;
}

/**
 * New in this round: a real desktop-notification permission toggle so a
 * new WhatsApp message can alert the user even with the tab backgrounded
 * (App.tsx's own background poll only shows a topbar badge, invisible while
 * the tab isn't focused -- see whatsappNotify.ts). jsdom implements no
 * Notification API at all, so this stubs one with a controllable
 * requestPermission the way round 291's own matchMedia stub did for
 * ThemeContext. Confirms the real button appears when permission is still
 * "default", that clicking it calls the real requestPermission and updates
 * the UI to reflect a "granted" result, without reimplementing the click
 * handler's own logic.
 */
test("WhatsAppPanel's notification toggle requests permission on click and reflects a granted result", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let requestPermissionCalls = 0;
    (globalThis as unknown as { Notification: unknown }).Notification = {
      permission: "default",
      requestPermission: async () => {
        requestPermissionCalls++;
        return "granted";
      },
    };
    globalThis.fetch = mockConnectedStatusFetch();
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-connected-box") !== null);

      const enableButton = [...document.querySelectorAll(".whatsapp-connected-actions button")].find(
        (b) => b.textContent === "🔔 Enable desktop notifications",
      ) as HTMLButtonElement;
      assert.ok(enableButton, "a real enable-notifications button must render while permission is still 'default'");

      fireEvent.click(enableButton);
      await waitForCondition(() => document.querySelector(".whatsapp-notify-status") !== null);

      assert.equal(requestPermissionCalls, 1, "clicking must call the real Notification.requestPermission, not a reimplementation");
      assert.equal(
        document.querySelector(".whatsapp-notify-status")?.textContent,
        "🔔 Desktop notifications enabled",
        "once granted, the UI must reflect the real permission result instead of still showing the enable button",
      );
      assert.equal(
        [...document.querySelectorAll(".whatsapp-connected-actions button")].some((b) => b.textContent?.includes("Enable desktop notifications")),
        false,
        "the enable button must disappear once permission is granted",
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete (globalThis as unknown as { Notification?: unknown }).Notification;
    }
  });
});

/**
 * Companion to the test above: when the browser already denied notification
 * permission (e.g. the user blocked it once before, outside this app),
 * confirms the panel shows a real "blocked" message instead of a
 * now-pointless enable button that would just trigger another silent
 * denial -- browsers never re-prompt once a user has explicitly denied.
 */
test("WhatsAppPanel shows a blocked message, not an enable button, when notification permission is already denied", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { Notification: unknown }).Notification = {
      permission: "denied",
      requestPermission: async () => "denied",
    };
    globalThis.fetch = mockConnectedStatusFetch();
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-connected-box") !== null);

      assert.equal(
        document.querySelector(".whatsapp-notify-status")?.textContent,
        "🔕 Notifications blocked in browser settings",
        "an already-denied permission must show the blocked message",
      );
      assert.equal(
        [...document.querySelectorAll(".whatsapp-connected-actions button")].some((b) => b.textContent?.includes("Enable desktop notifications")),
        false,
        "no enable button should render once permission is already denied",
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete (globalThis as unknown as { Notification?: unknown }).Notification;
    }
  });
});

/**
 * New in this round: the "To" field had no memory at all -- a real owner
 * testing their WhatsApp connection typically sends to the same 1-3
 * numbers repeatedly, but had to retype the number from scratch every
 * single time, the exact same gap Global Search's own query box had
 * before recentSearches.ts (round 180). Confirms a sent number appears as
 * a real chip afterward, and clicking that chip fills the "To" field with
 * that number instead of requiring it to be typed again.
 */
test("WhatsAppPanel remembers a sent test number as a clickable recent-number chip", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/integrations/whatsapp/send") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-test-form") !== null);

      const inputs = document.querySelectorAll('.whatsapp-test-form input[type="text"]');
      const toInput = inputs[0] as HTMLInputElement;
      const messageInput = inputs[1] as HTMLInputElement;
      fireEvent.change(toInput, { target: { value: "972521112233" } });
      fireEvent.change(messageInput, { target: { value: "Hi" } });
      fireEvent.submit(document.querySelector("form.whatsapp-test-form")!);

      await waitForCondition(() => document.querySelector(".whatsapp-recent-numbers .chip-text") !== null);
      const chip = document.querySelector(".whatsapp-recent-numbers .chip-text") as HTMLButtonElement;
      assert.equal(chip.textContent, "972521112233", "the just-sent number must appear as a recent-number chip");

      fireEvent.change(toInput, { target: { value: "" } });
      assert.equal(toInput.value, "", "sanity check: the To field is genuinely cleared before clicking the chip");
      fireEvent.click(chip);
      assert.equal(toInput.value, "972521112233", "clicking the chip must fill the To field with that number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The other half: a recent-number chip's own remove button must delete
 * just that one number, mirroring Global Search's own recentSearches.ts
 * single-item removal (round 230) -- the previous state for this kind of
 * list was "no way to trim it except by never having sent to it, or
 * wiping everything" and this proves the per-chip remove button, once
 * added, actually calls through to real per-number removal rather than
 * only updating some unrelated piece of state.
 */
test("WhatsAppPanel's recent-number chip has a working per-number remove button", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/integrations/whatsapp/send") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-test-form") !== null);

      const inputs = document.querySelectorAll('.whatsapp-test-form input[type="text"]');
      fireEvent.change(inputs[0], { target: { value: "972521112233" } });
      fireEvent.change(inputs[1], { target: { value: "Hi" } });
      fireEvent.submit(document.querySelector("form.whatsapp-test-form")!);

      await waitForCondition(() => document.querySelector(".whatsapp-recent-numbers") !== null);
      fireEvent.click(document.querySelector(".whatsapp-recent-numbers .chip-remove") as HTMLButtonElement);

      assert.equal(
        document.querySelector(".whatsapp-recent-numbers"),
        null,
        "removing the only recent number must make the whole recent-numbers block disappear, not leave an empty chip row",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the message log's own search box (shown once a
 * project has more than 5 messages) was the last live-filter-as-you-type
 * search box in the app with zero memory of past queries -- Global
 * Search, Time Machine, the home screen's project search (round 316),
 * and the per-entity table search (round 318) all already remember
 * recent queries the same way. Exercises the full real wiring: typing a
 * query and pressing Enter persists it, the chip row only shows while
 * the box is empty, clicking a chip refills the search box, and the
 * per-chip remove button drops just that one entry.
 */
test("WhatsAppPanel's log search box remembers a query on Enter, shows it as a chip once the box is empty, and a chip click refills the search", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const messages: WhatsAppMessageLogEntry[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: `Message number ${i}`,
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    }));
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-log-search") !== null);

      const searchInput = document.querySelector(".whatsapp-log-search") as HTMLInputElement;
      assert.equal(document.querySelector(".whatsapp-log-search-recent"), null, "no recent-searches row before anything's ever been searched");

      fireEvent.change(searchInput, { target: { value: "number 3" } });
      assert.equal(
        document.querySelector(".whatsapp-log-search-recent"),
        null,
        "the chip row must stay hidden while the box still has text in it",
      );

      fireEvent.keyDown(searchInput, { key: "Enter" });
      fireEvent.change(searchInput, { target: { value: "" } });
      await waitForCondition(() => document.querySelector(".whatsapp-log-search-recent") !== null);

      let chips = Array.from(document.querySelectorAll(".whatsapp-log-search-recent .chip-text")) as HTMLButtonElement[];
      assert.deepEqual(
        chips.map((c) => c.textContent),
        ["number 3"],
        "the committed query must appear as a chip once the box is empty again",
      );

      fireEvent.click(chips[0]);
      assert.equal(searchInput.value, "number 3", "clicking the chip must refill the search box with that query");

      fireEvent.change(searchInput, { target: { value: "" } });
      await waitForCondition(() => document.querySelector(".whatsapp-log-search-recent .chip-remove") !== null);
      fireEvent.click(document.querySelector(".whatsapp-log-search-recent .chip-remove") as HTMLButtonElement);
      await waitForCondition(() => document.querySelector(".whatsapp-log-search-recent") === null);

      chips = Array.from(document.querySelectorAll(".whatsapp-log-search-recent .chip-text")) as HTMLButtonElement[];
      assert.equal(chips.length, 0, "removing the only chip must clear the whole recent-searches row");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: HistoryPanel.tsx's own log/checkpoint search box
 * already has a one-click "Clear search" (✕) button and Escape-to-clear
 * (rounds 358/359), but this dialog's own, structurally identical
 * message-log search box had neither -- the only way to empty it was
 * deleting every character by hand, and (before round 359's
 * data-escape-handled-locally fix was ported here) pressing Escape would
 * have closed the whole WhatsApp dialog instead of clearing the box.
 * Passes a REAL onClose spy all the way through the dialog (not the
 * no-op most tests in this file use) specifically to prove Escape here
 * only clears the search and never also closes the panel.
 */
test("WhatsAppPanel's log search box has a 'Clear search' button and Escape-to-clear, and neither one closes the whole dialog", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const messages: WhatsAppMessageLogEntry[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: `Message number ${i}`,
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    }));
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let closeCalls = 0;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, {
              projectId: "proj1",
              projectName: "Test Project",
              onClose: () => {
                closeCalls += 1;
              },
              onJumpToEntity: () => {},
              onJumpToRecord: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelector(".whatsapp-log-search") !== null);
      assert.ok(document.querySelector('[role="dialog"]'), "sanity check: a real dialog wired to the real onClose must be open");

      const searchInput = document.querySelector(".whatsapp-log-search") as HTMLInputElement;
      assert.equal(document.querySelector(".whatsapp-log-clear-search"), null, "the button must not render while the search box is empty");

      fireEvent.change(searchInput, { target: { value: "number 3" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      const clearButton = document.querySelector(".whatsapp-log-clear-search") as HTMLButtonElement;
      assert.ok(clearButton, "the button must appear the moment the search box has text");
      fireEvent.click(clearButton);
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 6);
      assert.equal(searchInput.value, "", "clicking the button must empty the search box");
      assert.equal(document.querySelector(".whatsapp-log-clear-search"), null, "the button must disappear again once the search box is empty");
      assert.equal(closeCalls, 0, "clicking Clear search must never also close the whole dialog");

      fireEvent.change(searchInput, { target: { value: "number 5" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);
      fireEvent.keyDown(searchInput, { key: "Escape" });

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 6);
      assert.equal(searchInput.value, "", "Escape must also empty the search box");
      assert.equal(closeCalls, 0, "Escape clearing the search box must never also close the whole dialog");
      assert.ok(document.querySelector('[role="dialog"]'), "the dialog itself must still be in the DOM after that Escape");

      // Round 362 regression: data-escape-handled-locally used to sit on
      // this input unconditionally, so once the box was already empty
      // (nothing left to clear), useDialogFocusTrap's own Escape listener
      // still skipped closing the dialog because the marker was present --
      // and handleLogSearchKeyDown's own `search.length > 0` guard also did
      // nothing, so Escape from a focused, empty search box silently did
      // nothing at all instead of closing the dialog.
      fireEvent.keyDown(searchInput, { key: "Escape" });
      assert.equal(closeCalls, 1, "Escape on an already-empty search box must close the dialog normally, not get silently swallowed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: each message log row shows the real `createdAt` the
 * server actually recorded for it -- the type has always carried this
 * field (see api.ts's WhatsAppMessageLogEntry), but the row markup never
 * rendered it at all, so a conversation history with no visible time
 * information was strictly less useful than any real chat log. Confirms
 * the exact locale-formatted string for that record's own timestamp is
 * what actually appears, not a placeholder or the wrong record's time.
 */
test("WhatsAppPanel's message log shows each message's own real timestamp", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const createdAt = new Date("2026-03-15T14:32:00Z").toISOString();
    const message: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: "Hi there",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt,
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [message] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      const timeEl = document.querySelector(".whatsapp-log-time");
      assert.ok(timeEl, "expected a timestamp element in the message log row");
      const expected = new Date(createdAt).toLocaleString("en-US");
      assert.equal(timeEl!.textContent, expected, `expected the real record's own timestamp "${expected}", got "${timeEl!.textContent}"`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: matchedEntityName/matchedRecordId have always been
 * stamped on every message (see packages/db/src/whatsapp.ts), and
 * matchedLabel already rendered as the row's "who" text -- but that text
 * was always inert, never a way to actually reach the matched record.
 * Mirrors BusinessTwinPanel's own onJumpToEntity pattern (round 141), but
 * for the real per-record jump added in this round: the API already
 * resolves each matched message down to a specific record id
 * (matchedRecordId), but the click handler used to throw it away and only
 * ever call onJumpToEntity -- the same "navigates to the tab, not the
 * record" gap Global Search's own "jump to" had before round 174. Renders
 * one matched message and one unmatched message in the same log, confirms
 * only the matched one renders as a real clickable button (the unmatched
 * one must stay plain, inert text -- there's nothing to jump to), and
 * confirms clicking it calls onJumpToRecord with the real matched entity
 * name AND record id, not just the entity name, and does NOT also fire
 * onJumpToEntity.
 */
test("WhatsAppPanel's message log makes a matched sender's name a real jump-to-RECORD button, and leaves an unmatched sender as plain text", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const matchedMessage: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: "Can I reschedule?",
      matchedLabel: "Dana Levi",
      matchedEntityName: "Customer",
      matchedRecordId: 7,
      status: "received",
      createdAt: new Date().toISOString(),
    };
    const unmatchedMessage: WhatsAppMessageLogEntry = {
      id: "m2",
      direction: "in",
      fromNumber: "972529998888",
      toNumber: "972501234567",
      body: "Who is this?",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [matchedMessage, unmatchedMessage] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    const entityJumps: string[] = [];
    const recordJumps: [string, number][] = [];
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, {
              projectId: "proj1",
              projectName: "Test Project",
              onClose: () => {},
              onJumpToEntity: (entityName: string) => entityJumps.push(entityName),
              onJumpToRecord: (entityName: string, recordId: number) => recordJumps.push([entityName, recordId]),
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 2);

      const whoButtons = document.querySelectorAll(".whatsapp-log-who-link");
      assert.equal(whoButtons.length, 1, "exactly one matched message must render a real clickable who-button");
      assert.equal(whoButtons[0].tagName, "BUTTON");
      assert.equal(whoButtons[0].textContent, "Dana Levi");

      const unmatchedWho = Array.from(document.querySelectorAll(".whatsapp-log-who")).find((el) => el.tagName !== "BUTTON");
      assert.ok(unmatchedWho, "expected the unmatched message's who to stay a plain, non-button element");
      assert.equal(unmatchedWho!.textContent, "972529998888", "an unmatched sender must fall back to the phone number, unchanged");

      fireEvent.click(whoButtons[0]);
      assert.deepEqual(
        recordJumps,
        [["Customer", 7]],
        "must call onJumpToRecord with the real matched ENTITY NAME (Customer) and RECORD ID (7), not just the entity name",
      );
      assert.deepEqual(entityJumps, [], "a message with a real matchedRecordId must not also fire onJumpToEntity");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Fallback coverage for the rare case a message matched an entity whose
 * specific record has since been deleted (matchedEntityName set,
 * matchedRecordId null): the click handler must still fall back to
 * onJumpToEntity rather than calling onJumpToRecord with a null id or
 * silently doing nothing.
 */
test("WhatsAppPanel falls back to onJumpToEntity when a message matched an entity but has no matchedRecordId", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const matchedNoRecordId: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: "Hello",
      matchedLabel: "Dana Levi",
      matchedEntityName: "Customer",
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [matchedNoRecordId] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    const entityJumps: string[] = [];
    const recordJumps: [string, number][] = [];
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, {
              projectId: "proj1",
              projectName: "Test Project",
              onClose: () => {},
              onJumpToEntity: (entityName: string) => entityJumps.push(entityName),
              onJumpToRecord: (entityName: string, recordId: number) => recordJumps.push([entityName, recordId]),
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-who-link").length === 1);

      fireEvent.click(document.querySelector(".whatsapp-log-who-link")!);
      assert.deepEqual(entityJumps, ["Customer"], "must fall back to onJumpToEntity when matchedRecordId is null");
      assert.deepEqual(recordJumps, [], "must not call onJumpToRecord with a null record id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the message log had no way to keep a real record of a
 * WhatsApp conversation before using the panel's own "Clear history"
 * button, which is irreversible -- exactly the gap Business Twin's report
 * download (round 129) and Backup All Data (round 75) already closed for
 * their own screens. Confirms the download button only appears once there
 * are real messages (mirrors "Clear history"'s own existing condition, so
 * an empty log never offers to download nothing), and that clicking it
 * drives the real browser download mechanism -- a real Blob URL handed to
 * a real anchor's `download` attribute and `click()` -- with the actual
 * project name in the filename, not a hardcoded placeholder.
 */
test("WhatsAppPanel's message log shows a download button only once there are messages, and clicking it downloads the real log as a named file", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const message: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: "Hi there",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [message] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    // jsdom doesn't implement the real Blob-URL machinery -- stub just
    // enough of it to observe what the click handler actually does,
    // the same technique BackupAllData-style download tests elsewhere in
    // this app use for triggering a real <a download> click.
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    // withJsdom (above) swaps in window/document/etc. globally but not
    // HTMLAnchorElement itself -- the real anchor class lives on the
    // swapped-in `window`, so it must be reached through that, not the
    // bare (still-original-realm) global identifier.
    const anchorProto = (globalThis as unknown as { window: { HTMLAnchorElement: { prototype: HTMLAnchorElement } } }).window
      .HTMLAnchorElement.prototype;
    const originalAnchorClick = anchorProto.click;
    let capturedDownloadName: string | null = null;
    let clickCount = 0;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:mock-url";
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    anchorProto.click = function (this: HTMLAnchorElement) {
      capturedDownloadName = this.download;
      clickCount += 1;
    };

    try {
      const { container } = render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Flower Shop", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      // Before any messages load, an empty log must not offer to download
      // nothing (mirrors "Clear history"'s own existing empty-log guard).
      assert.equal(
        container.querySelector(".whatsapp-log-header-actions"),
        null,
        "no download/clear actions should render before the log has any messages",
      );

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      const downloadButton = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Download History"),
      );
      assert.ok(downloadButton, "expected a Download History button once the log has real messages");

      fireEvent.click(downloadButton!);

      assert.equal(clickCount, 1, "clicking the download button must trigger exactly one real anchor click");
      const downloadName: string = capturedDownloadName ?? "";
      assert.ok(
        downloadName.includes("Flower Shop"),
        `expected the downloaded filename to be derived from the real project name "Flower Shop", got "${downloadName}"`,
      );
      assert.ok(downloadName.endsWith("whatsapp-log.txt"), `expected a whatsapp-log.txt filename, got "${downloadName}"`);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      anchorProto.click = originalAnchorClick;
    }
  });
});

/**
 * New in this round: a WhatsApp conversation only ever grows (no cap, no
 * delete besides the panel's own "Clear history", which wipes everything).
 * Mirrors HistoryPanel's own search-box threshold (round 157) -- both a
 * small log (search box hidden, nothing worth filtering) and a real filter
 * once there are enough messages to actually need one.
 */
test("WhatsAppPanel shows a search box only once the log passes the threshold, filters the real rendered messages, and shows a real 'no results' state", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const makeMessage = (id: string, body: string): WhatsAppMessageLogEntry => ({
      id,
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body,
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    });
    const sixMessages = [
      makeMessage("m1", "מתי אתם פתוחים?"),
      makeMessage("m2", "אשמח להזמין זר ורדים"),
      makeMessage("m3", "תודה רבה"),
      makeMessage("m4", "האם יש משלוחים?"),
      makeMessage("m5", "מה המחיר של זר יומולדת?"),
      makeMessage("m6", "בסדר, מגיע עוד מעט"),
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: sixMessages }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Flower Shop", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 6);
      assert.equal(
        document.querySelector(".whatsapp-log-count")!.textContent,
        " — 6 messages",
        "unfiltered must read as a plain count, not '6 of 6 messages'",
      );

      const searchBox = document.querySelector(".whatsapp-log-search") as HTMLInputElement | null;
      assert.ok(searchBox, "expected a real search box once the log has more than the threshold of messages");

      fireEvent.change(searchBox!, { target: { value: "ורדים" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);
      assert.match(
        document.querySelector(".whatsapp-log-body")!.textContent ?? "",
        /ורדים/,
        "the one remaining row must be the real matching message, not a stale/wrong one",
      );
      assert.equal(
        document.querySelector(".whatsapp-log-count")!.textContent,
        " — 1 of 6 messages",
        "once the search narrows the log, the count must show shown-of-total",
      );

      fireEvent.change(searchBox!, { target: { value: "zzz-no-such-message" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 0);
      assert.equal(
        document.querySelector(".whatsapp-log-list") === null,
        true,
        "the message list itself must not render at all once nothing matches",
      );
      const noResultsEl = Array.from(document.querySelectorAll("p")).find((p) => p.textContent?.includes("No messages match your search."));
      assert.ok(noResultsEl, "expected a real 'no results' message, not a silently empty log");
      assert.equal(
        document.querySelector(".whatsapp-log-count")!.textContent,
        " — 0 of 6 messages",
        "a search matching nothing must still show the real 0-of-6 count, not hide it or show a stale number",
      );

      fireEvent.change(searchBox!, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: mirrors rounds 195-196's fix to the Entity table
 * search box and Global Search -- the WhatsApp log's own search box
 * already narrowed the list to matching messages, but never showed
 * where within a message's own body, or its sender/recipient label,
 * the match actually was. Confirms a real typed search wraps the
 * matched substring in a real <mark class="search-match"> inside both
 * the message body and the "who" label (filterWhatsAppMessages already
 * matches on both, per its own doc comment), and that clearing the
 * search removes the highlight along with restoring the rest of the log.
 */
test("WhatsAppPanel's search box highlights the matched text within both a message's own body and its sender/recipient label", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const makeMessage = (id: string, body: string, fromNumber: string): WhatsAppMessageLogEntry => ({
      id,
      direction: "in",
      fromNumber,
      toNumber: "972501234567",
      body,
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    });
    const sixMessages = [
      makeMessage("m1", "מתי אתם פתוחים?", "972521112233"),
      makeMessage("m2", "אשמח להזמין זר ורדים", "972521112233"),
      makeMessage("m3", "תודה רבה", "972521112233"),
      makeMessage("m4", "האם יש משלוחים?", "972521112233"),
      makeMessage("m5", "מה המחיר של זר יומולדת?", "972521112233"),
      makeMessage("m6", "בסדר, מגיע עוד מעט", "555000111"),
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: sixMessages }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Flower Shop", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 6);

      const searchBox = document.querySelector(".whatsapp-log-search") as HTMLInputElement;

      // Match within the message body.
      fireEvent.change(searchBox, { target: { value: "ורדים" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);
      const bodyMark = document.querySelector(".whatsapp-log-body mark.search-match");
      assert.ok(bodyMark, "the matched substring within the message body must be wrapped in a real <mark class=\"search-match\">");
      assert.equal(bodyMark!.textContent, "ורדים");
      assert.equal(
        document.querySelector(".whatsapp-log-body")!.textContent,
        "אשמח להזמין זר ורדים",
        "the rest of the body's own text must still render around the highlight",
      );

      // Match within the "who" label (the raw phone number, unmatched to any record).
      fireEvent.change(searchBox, { target: { value: "555000" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);
      const whoMark = document.querySelector(".whatsapp-log-who mark.search-match");
      assert.ok(whoMark, "the matched substring within the sender label must also be highlighted");
      assert.equal(whoMark!.textContent, "555000");

      // Clearing the search must remove the highlight.
      fireEvent.change(searchBox, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 6);
      assert.equal(document.querySelector("mark.search-match"), null, "clearing the search must remove the highlight");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the message log had a text search but no way to
 * isolate "just what I sent" / "just what came in" / "just what failed
 * to send" -- exactly the gap a long, never-capped, never-deleted
 * conversation (filterWhatsAppMessages' own comment) eventually needs.
 * Combines a real direction/status filter with the existing text search
 * through a real running component, not the pure function in isolation.
 */
test("WhatsAppPanel's direction filter narrows the real rendered log to incoming/outgoing/failed, and composes with the text search", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const makeMessage = (id: string, overrides: Partial<WhatsAppMessageLogEntry>): WhatsAppMessageLogEntry => ({
      id,
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: "הודעה",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
      ...overrides,
    });
    const sevenMessages = [
      makeMessage("m1", { direction: "in", body: "מתי אתם פתוחים?" }),
      makeMessage("m2", { direction: "in", body: "אשמח להזמין זר ורדים" }),
      makeMessage("m3", { direction: "out", status: "sent", body: "בשמחה, איזה זר?" }),
      makeMessage("m4", { direction: "out", status: "sent", body: "זר ורדים אדומים מוכן" }),
      makeMessage("m5", { direction: "out", status: "failed", body: "עדכון סטטוס ההזמנה" }),
      makeMessage("m6", { direction: "in", body: "תודה רבה" }),
      makeMessage("m7", { direction: "out", status: "sent", body: "בבקשה!" }),
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: sevenMessages }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Flower Shop", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 7);

      const filterSelect = document.querySelector(".whatsapp-log-direction-filter") as HTMLSelectElement | null;
      assert.ok(filterSelect, "expected a real direction/status filter select once the log has more than the threshold of messages");

      fireEvent.change(filterSelect!, { target: { value: "in" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 3);
      assert.equal(
        document.querySelector(".whatsapp-log-count")!.textContent,
        " — 3 of 7 messages",
        "the 'incoming only' filter must show the real 3-of-7 count",
      );

      fireEvent.change(filterSelect!, { target: { value: "out" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 4);
      assert.equal(
        document.querySelector(".whatsapp-log-count")!.textContent,
        " — 4 of 7 messages",
        "the 'outgoing only' filter must include both the sent AND the failed outgoing messages",
      );

      fireEvent.change(filterSelect!, { target: { value: "failed" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);
      assert.match(
        document.querySelector(".whatsapp-log-body")!.textContent ?? "",
        /עדכון סטטוס ההזמנה/,
        "the 'failed only' filter must show exactly the one real failed message, not a stale/wrong one",
      );

      // Composes with the text search -- both filters apply together, not one replacing the other.
      // Of the 4 outgoing messages, only m4 ("זר ורדים אדומים מוכן") mentions ורדים.
      fireEvent.change(filterSelect!, { target: { value: "out" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 4);
      const searchBox = document.querySelector(".whatsapp-log-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "ורדים" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);
      assert.equal(
        document.querySelector(".whatsapp-log-count")!.textContent,
        " — 1 of 7 messages",
        "the real search AND the real direction filter must both narrow the log together, down to just m4",
      );
      assert.match(
        document.querySelector(".whatsapp-log-body")!.textContent ?? "",
        /זר ורדים אדומים מוכן/,
        "the one remaining message must genuinely be both outgoing AND matching the search text",
      );

      fireEvent.change(filterSelect!, { target: { value: "all" } });
      fireEvent.change(searchBox, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: clearWhatsAppMessages (round 154's own download button
 * is its neighbor, and handleClearHistory further up this file wipes the
 * WHOLE log) was previously the only way to remove anything from the log
 * at all -- one junk or test message meant clearing everything. Each row
 * now gets its own real delete button (🗑️), sending a real DELETE request
 * scoped to that one message's id and removing only that row from the
 * rendered log, confirmed via window.confirm exactly like handleDelete's
 * own single-record confirm in EntityPanel.tsx.
 */
test("WhatsAppPanel's per-message delete button sends a real DELETE for that one message's id and removes only that row from the log", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    let capturedDeletePath: string | undefined;
    const store: WhatsAppMessageLogEntry[] = [
      {
        id: "m1",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "keep this one",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date("2026-03-15T14:32:00Z").toISOString(),
      },
      {
        id: "m2",
        direction: "out",
        fromNumber: "972501234567",
        toNumber: "972521112233",
        body: "delete this one",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "sent",
        createdAt: new Date("2026-03-15T14:33:00Z").toISOString(),
      },
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const deleteMatch = /^\/api\/projects\/proj1\/integrations\/whatsapp\/messages\/([^/]+)$/.exec(input);
      if (method === "DELETE" && deleteMatch) {
        capturedDeletePath = input;
        const index = store.findIndex((m) => m.id === deleteMatch[1]);
        assert.ok(index !== -1, "the mock server's own message id lookup must actually find the real message");
        store.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 2);

      const rows = [...document.querySelectorAll(".whatsapp-log-list li")];
      const targetRow = rows.find((li) => (li.textContent ?? "").includes("delete this one"))!;
      assert.ok(targetRow, "expected to find the row to delete");
      const deleteButton = targetRow.querySelector(".whatsapp-log-delete") as HTMLButtonElement;
      assert.ok(deleteButton, "expected a real delete button on the row");

      fireEvent.click(deleteButton);
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      assert.equal(
        capturedDeletePath,
        "/api/projects/proj1/integrations/whatsapp/messages/m2",
        "must send a real DELETE scoped to exactly this message's own id",
      );
      assert.match(
        document.querySelector(".whatsapp-log-list li")!.textContent ?? "",
        /keep this one/,
        "the other message must still be shown -- only the deleted one should disappear",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * The complement to the delete test above: declining the confirm dialog
 * must genuinely abort the delete -- no DELETE request sent at all, and
 * the row stays exactly as it was, matching handleClearHistory's own
 * confirm-gated shape (and the same "no request on decline" contract
 * EntityPanel.tsx's own handleDelete has).
 */
test("WhatsAppPanel's per-message delete button sends no request at all when the confirm dialog is declined", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.window.confirm = (() => false) as typeof window.confirm;
    let deleteRequestSent = false;
    const message: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "out",
      fromNumber: "972501234567",
      toNumber: "972521112233",
      body: "should not be deleted",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "sent",
      createdAt: new Date("2026-03-15T14:33:00Z").toISOString(),
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [message] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/integrations/whatsapp/messages/m1") {
        deleteRequestSent = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} })),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      const deleteButton = document.querySelector(".whatsapp-log-delete") as HTMLButtonElement;
      fireEvent.click(deleteButton);
      // Give any (wrongly) fired request a real tick to land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(deleteRequestSent, false, "declining the confirm dialog must never send the DELETE request");
      assert.equal(document.querySelectorAll(".whatsapp-log-list li").length, 1, "the message must still be shown after declining");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: the same "Copy report" companion action round 222
 * added to Business Twin's own Download button, mirrored here -- the log
 * is already formatted as plain, shareable text (formatWhatsAppLog), but
 * the only way to actually get it anywhere was a real file download.
 * Confirms the real navigator.clipboard.writeText receives the exact
 * formatted log text, the button shows a real "Copied!" confirmation, and
 * (via a real mocked setTimeout tick, not a hardcoded wait) fades back to
 * normal 2 seconds later.
 */
test("WhatsAppPanel's copy button writes the real formatted log to the clipboard, shows Copied, then reverts", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const message: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: "Hi there",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [message] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Flower Shop", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "📋 Copy History");
      assert.ok(copyButton, "expected a Copy History button once the log has real messages");
      assert.equal(
        copyButton!.getAttribute("aria-live"),
        "polite",
        "the copy button's own changing label must be announced to screen readers, not just silently change visually",
      );
      assert.equal(copyButton!.getAttribute("aria-atomic"), "true", "the whole button's text must be re-announced, not just the changed part");

      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Flower Shop/, "the copied text must be the real formatted log, not a placeholder");
      assert.match(writtenText!, /Hi there/, "the copied text must include the real message body");
      assert.equal(copyButton!.textContent, "✅ Copied!", "must show the real Copied confirmation, not silently do nothing");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy History", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/** The other half: a real rejection (denied permission, insecure context) must show a real failure label, not fail silently or crash. */
test("WhatsAppPanel's copy button shows a failure label when navigator.clipboard.writeText rejects", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const message: WhatsAppMessageLogEntry = {
      id: "m1",
      direction: "in",
      fromNumber: "972521112233",
      toNumber: "972501234567",
      body: "Hi there",
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "received",
      createdAt: new Date().toISOString(),
    };
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(JSON.stringify({ messages: [message] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Flower Shop", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "📋 Copy History");
      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(copyButton!.textContent, "Copy failed", "a real clipboard rejection must show a real failure label");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy History", "must revert to the normal label even after a failure");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * New in this round: the log's direction/status filter (All/Incoming/
 * Outgoing/Failed) was plain useState with no persistence -- filtering down
 * to "Failed" to track failed sends, closing the panel to check something
 * else, then reopening it silently reset back to "All" and lost the exact
 * view the owner was mid-triage on. Confirms the choice survives a real
 * unmount+remount of the panel (its own close/reopen lifecycle, per
 * App.tsx's `{showWhatsApp && <WhatsAppPanel .../>}`), and that it's scoped
 * per project rather than leaking across projects.
 */
test("WhatsAppPanel's log filter choice survives a real unmount+remount, and is scoped per project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const manyMessages: WhatsAppMessageLogEntry[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      direction: i % 2 === 0 ? "in" : "out",
      fromNumber: "972501234567",
      toNumber: "972521112233",
      body: `Message ${i}`,
      matchedLabel: null,
      matchedEntityName: null,
      matchedRecordId: null,
      status: "sent",
      createdAt: new Date().toISOString(),
    }));
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const projectId = (input as string).split("/projects/")[1]?.split("/")[0];
      if (method === "GET" && (input as string) === `/api/projects/${projectId}/integrations/whatsapp/status`) {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && (input as string) === `/api/projects/${projectId}/integrations/whatsapp/messages`) {
        return new Response(JSON.stringify({ messages: manyMessages }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    function renderPanel(projectId: string) {
      return render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, { projectId, projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} }),
          ),
        ),
      );
    }

    try {
      const first = renderPanel("proj-filter");
      await waitForCondition(() => document.querySelector(".whatsapp-log-direction-filter") !== null);
      const select = document.querySelector(".whatsapp-log-direction-filter") as HTMLSelectElement;
      assert.equal(select.value, "all", "sanity check: starts at the default before any choice is made");
      fireEvent.change(select, { target: { value: "failed" } });
      assert.equal(select.value, "failed");
      assert.equal(getWhatsAppLogFilter("proj-filter"), "failed", "the choice must actually be persisted, not just held in memory");
      first.unmount();

      const second = renderPanel("proj-filter");
      await waitForCondition(() => document.querySelector(".whatsapp-log-direction-filter") !== null);
      const reopenedSelect = document.querySelector(".whatsapp-log-direction-filter") as HTMLSelectElement;
      assert.equal(reopenedSelect.value, "failed", "reopening the panel for the same project must restore the persisted filter");
      second.unmount();

      const third = renderPanel("proj-other");
      await waitForCondition(() => document.querySelector(".whatsapp-log-direction-filter") !== null);
      const otherSelect = document.querySelector(".whatsapp-log-direction-filter") as HTMLSelectElement;
      assert.equal(otherSelect.value, "all", "a different project must not inherit proj-filter's persisted choice");
      third.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round (263): listWhatsAppMessages always capped at 50 with no
 * way to reach anything older -- once a real conversation passed that, the
 * rest of the log was permanently unreachable, with the count label itself
 * wrongly claiming "N of N (all)". This is a real-render regression test
 * for the fix: a "Load older messages" button appears exactly while more
 * exist, clicking it appends (never replaces) the next page onto what's
 * already showing, and it disappears once the server reports nothing left.
 */
test("WhatsAppPanel's 'Load older messages' button appends the next page without replacing what's shown, and disappears once hasMore is false", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const page1: WhatsAppMessageLogEntry[] = [
      {
        id: "m1",
        direction: "out",
        fromNumber: "972501234567",
        toNumber: "972521112233",
        body: "Newest message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "sent",
        createdAt: new Date().toISOString(),
      },
      {
        id: "m2",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Second message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    const page2: WhatsAppMessageLogEntry[] = [
      {
        id: "m3",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Oldest message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    let messagesRequestCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input.startsWith("/api/projects/proj1/integrations/whatsapp/messages")) {
        messagesRequestCount += 1;
        // The first load must ask for no offset at all (offset=0 is the
        // implicit default -- see listWhatsAppMessages in api.ts), and the
        // "load more" click must ask for exactly offset=2 (messages.length
        // at the moment of the click), never replaying offset=0.
        if (!input.includes("offset=")) {
          return new Response(JSON.stringify({ messages: page1, hasMore: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (input.endsWith("offset=2")) {
          return new Response(JSON.stringify({ messages: page2, hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected offset in ${input}`);
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} }),
          ),
        ),
      );

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 2);
      assert.equal(messagesRequestCount, 1, "sanity check: exactly one messages request so far");

      const countLabel = document.querySelector(".whatsapp-log-count");
      assert.ok(countLabel?.textContent?.includes("2+"), `expected the count to read "2+" while more exist, got "${countLabel?.textContent}"`);

      const loadMoreButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Load older messages");
      assert.ok(loadMoreButton, "expected a 'Load older messages' button while hasMore is true");

      fireEvent.click(loadMoreButton!);

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 3);
      assert.equal(messagesRequestCount, 2, "the click must trigger exactly one more request");

      const bodies = Array.from(document.querySelectorAll(".whatsapp-log-body")).map((el) => el.textContent);
      assert.deepEqual(
        bodies,
        ["Newest message", "Second message", "Oldest message"],
        "the older page must be appended after the existing two, never replacing them",
      );

      await waitForCondition(() => Array.from(document.querySelectorAll("button")).every((b) => b.textContent !== "Load older messages"));
      const countLabelAfter = document.querySelector(".whatsapp-log-count");
      assert.ok(
        countLabelAfter?.textContent?.includes("3") && !countLabelAfter.textContent.includes("+"),
        `expected the count to read a plain "3" once nothing more is left, got "${countLabelAfter?.textContent}"`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 432: handleLoadMore was a fourth
 * fetch-then-setMessages call site that round 431's own messagesVersionRef
 * fix never covered (the fix's own doc comment and code only guarded the
 * three mergeFreshMessages call sites). "Load older messages" and "Clear
 * history" are both always-enabled, simultaneously-rendered buttons --
 * nothing stops a user from clicking "Load older messages" and then
 * "Clear history" before the first request resolves. Before this round's
 * fix, the held-open "older page" fetch's response (still reflecting the
 * pre-clear log) would land after handleClearHistory had already emptied
 * `messages`, and handleLoadMore's unconditional `setMessages((prev) =>
 * [...prev, ...older])` would glue the stale page right back onto the
 * now-empty state -- resurrecting the entire cleared history. Confirms the
 * fix: the version bump from Clear history (which lands first here) makes
 * the load-more fetch's own now-stale result get discarded instead.
 */
test("WhatsAppPanel's 'Load older messages' never resurrects history cleared while its own fetch was still in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    const page1: WhatsAppMessageLogEntry[] = [
      {
        id: "m1",
        direction: "out",
        fromNumber: "972501234567",
        toNumber: "972521112233",
        body: "Newest message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "sent",
        createdAt: new Date().toISOString(),
      },
      {
        id: "m2",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Second message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    const page2: WhatsAppMessageLogEntry[] = [
      {
        id: "m3",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Oldest message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    let releaseOlderPageFetch: (() => void) | undefined;
    const olderPageHeld = new Promise<void>((resolve) => {
      releaseOlderPageFetch = resolve;
    });
    let olderPageRequestEntered = false;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input.startsWith("/api/projects/proj1/integrations/whatsapp/messages")) {
        if (!input.includes("offset=")) {
          return new Response(JSON.stringify({ messages: page1, hasMore: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (input.endsWith("offset=2")) {
          olderPageRequestEntered = true;
          await olderPageHeld;
          return new Response(JSON.stringify({ messages: page2, hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected offset in ${input}`);
      }
      if (method === "DELETE" && input === "/api/projects/proj1/integrations/whatsapp/messages") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} }),
          ),
        ),
      );

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 2);

      const loadMoreButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Load older messages");
      assert.ok(loadMoreButton, "expected a 'Load older messages' button while hasMore is true");
      fireEvent.click(loadMoreButton!);
      await waitForCondition(() => olderPageRequestEntered);
      // loadingMore flips the button's own label while its fetch is in
      // flight -- a real, DOM-observable signal (not a timer) that the
      // click's own fetch has actually started, mirroring this file's
      // existing "Loading…" button-text convention.
      await waitForCondition(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Loading…"));

      // The older-page fetch is now held open, exactly as if a real
      // network request were still in flight. Clicking Clear history
      // while it's held simulates the real race this test guards against.
      const clearButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Clear history");
      assert.ok(clearButton, "expected a 'Clear history' button");
      fireEvent.click(clearButton!);
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 0);

      // Only now release the stale older-page fetch, after the clear has
      // already taken effect. handleClearHistory's own setHasMoreMessages(false)
      // unmounts the "Load older messages" button entirely, so its
      // "Loading…" label can't be used as a completion signal here --
      // draining the microtask queue a few times (the same technique
      // EntityPanel.test.ts already uses for an identical "let the stale
      // call's continuation actually run after release" need, not a
      // timing-based sleep) is what actually lets handleLoadMore's own
      // continuation run before the assertion below.
      releaseOlderPageFetch!();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(
        document.querySelectorAll(".whatsapp-log-list li").length,
        0,
        "the cleared history must stay empty -- the stale 'older page' fetch must never resurrect it",
      );
    } finally {
      globalThis.window.confirm = originalConfirm;
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 476: handleLoadMore's offset (messages.length,
 * read at click time) is a server-side OFFSET over a DESC-ordered log that
 * a real incoming WhatsApp message can grow at the HEAD at any time --
 * nothing to do with the round 432 delete/clear race above, which only
 * guards messagesVersionRef (bumped solely by handleDeleteMessage/
 * handleClearHistory). If a message lands between reading that offset and
 * the server running the query, the "older" page the server returns shifts
 * and overlaps with the tail of what's already shown, which the old
 * unconditional `[...prev, ...older]` concat rendered twice (duplicate ids,
 * duplicate React keys). Confirms the fix: handleLoadMore now dedupes the
 * fetched page against `prev` the same way mergeFreshMessages's own three
 * call sites already did.
 */
test("WhatsAppPanel's 'Load older messages' doesn't duplicate a message that's both already shown and in the newly-fetched older page", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const page1: WhatsAppMessageLogEntry[] = [
      {
        id: "m1",
        direction: "out",
        fromNumber: "972501234567",
        toNumber: "972521112233",
        body: "Newest message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "sent",
        createdAt: new Date().toISOString(),
      },
      {
        id: "m2",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Second message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    // Simulates a new WhatsApp message having been inserted server-side
    // between handleLoadMore reading offset=2 and the server running its
    // OFFSET query: the true DESC order shifted by one, so the "older" page
    // the server hands back starts with m2 (already shown, now one
    // position later than the client's stale offset assumed) followed by
    // the genuinely-new-to-the-client m3.
    const page2WithOverlap: WhatsAppMessageLogEntry[] = [
      page1[1],
      {
        id: "m3",
        direction: "in",
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body: "Oldest message",
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: "received",
        createdAt: new Date().toISOString(),
      },
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input.startsWith("/api/projects/proj1/integrations/whatsapp/messages")) {
        if (!input.includes("offset=")) {
          return new Response(JSON.stringify({ messages: page1, hasMore: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (input.endsWith("offset=2")) {
          return new Response(JSON.stringify({ messages: page2WithOverlap, hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected offset in ${input}`);
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} }),
          ),
        ),
      );

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 2);

      const loadMoreButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Load older messages");
      assert.ok(loadMoreButton, "expected a 'Load older messages' button while hasMore is true");
      fireEvent.click(loadMoreButton!);

      // Wait on the actual rendered row count, not on the button's own
      // text -- it flips to a transient "Loading…" label the instant the
      // click fires, which would also satisfy a "no longer says 'Load
      // older messages'" condition well before the fetch's result (and
      // this fix's dedup) has actually been applied to `messages`.
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 3);

      assert.equal(
        document.querySelectorAll(".whatsapp-log-list li").length,
        3,
        "m2 must not be rendered twice -- the overlapping message from the shifted 'older' page must be deduped against what's already shown",
      );
      const bodies = Array.from(document.querySelectorAll(".whatsapp-log-list li")).map((li) => li.textContent);
      assert.equal(
        bodies.filter((text) => text?.includes("Second message")).length,
        1,
        "'Second message' (m2) must appear exactly once in the log",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test: handleSendTest used to refresh the log with a plain
 * `setMessages(messages)` using the newest-page response (offset 0) --
 * a full replace, not a merge. Once a user had clicked "Load older
 * messages" at least once, sending a test message silently threw away
 * every older page that call had loaded (and made "Load older messages"
 * reappear, as if nothing had ever been paged in), even though the server
 * itself still had all of it. The fix merges the fresh newest-page
 * response into the existing list the same way startConnectedPolling's
 * own background refresh already did (prepend only the truly-new ids),
 * instead of replacing it, and leaves hasMoreMessages untouched (a
 * same-size newest-page fetch can't tell you anything about history
 * beyond what's already loaded).
 */
test("WhatsAppPanel's handleSendTest preserves older pages loaded via 'Load older messages' instead of replacing them with just the newest page", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    function makeMsg(id: string, body: string, direction: "in" | "out" = "in"): WhatsAppMessageLogEntry {
      return {
        id,
        direction,
        fromNumber: "972521112233",
        toNumber: "972501234567",
        body,
        matchedLabel: null,
        matchedEntityName: null,
        matchedRecordId: null,
        status: direction === "in" ? "received" : "sent",
        createdAt: new Date().toISOString(),
      };
    }
    const m1 = makeMsg("m1", "Newest before send");
    const m2 = makeMsg("m2", "Second before send");
    const m3 = makeMsg("m3", "Oldest, loaded via Load More");
    const m4 = makeMsg("m4", "Just sent", "out");
    let sent = false;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/integrations/whatsapp/status") {
        return new Response(
          JSON.stringify({ status: "connected", phoneNumber: "972501234567", qrDataUrl: null, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && input.startsWith("/api/projects/proj1/integrations/whatsapp/messages")) {
        if (input.endsWith("offset=2")) {
          return new Response(JSON.stringify({ messages: [m3], hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (!input.includes("offset=")) {
          // The "newest page" response: once sent, the brand-new message
          // (m4) now occupies the newest slot alongside m1 -- a real fetch
          // of offset 0 would return both, not just the delta.
          const page = sent ? [m4, m1] : [m1, m2];
          return new Response(JSON.stringify({ messages: page, hasMore: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected offset in ${input}`);
      }
      if (method === "POST" && input === "/api/projects/proj1/integrations/whatsapp/send") {
        sent = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(WhatsAppPanel, { projectId: "proj1", projectName: "Test Project", onClose: () => {}, onJumpToEntity: () => {}, onJumpToRecord: () => {} }),
          ),
        ),
      );

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 2);
      const loadMoreButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Load older messages");
      assert.ok(loadMoreButton, "expected a 'Load older messages' button while hasMore is true");
      fireEvent.click(loadMoreButton!);
      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 3);

      const inputs = document.querySelectorAll('.whatsapp-test-form input[type="text"]');
      fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "972521112233" } });
      fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: "Just sent" } });
      fireEvent.submit(document.querySelector("form.whatsapp-test-form")!);

      await waitForCondition(() => document.querySelectorAll(".whatsapp-log-list li").length === 4);
      const bodies = Array.from(document.querySelectorAll(".whatsapp-log-body")).map((el) => el.textContent);
      assert.deepEqual(
        bodies,
        ["Just sent", "Newest before send", "Second before send", "Oldest, loaded via Load More"],
        "sending must prepend the new message while keeping every older page already loaded, not replace the log with just the newest page",
      );

      assert.ok(
        Array.from(document.querySelectorAll("button")).every((b) => b.textContent !== "Load older messages"),
        "'Load older messages' must not reappear after sending -- hasMoreMessages reflects what was already loaded, not a fresh same-size newest-page fetch",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
