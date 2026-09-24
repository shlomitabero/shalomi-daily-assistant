import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { WhatsAppPanel } from "./WhatsAppPanel.js";
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

  const fn = new Function(
    "status",
    "setDisconnecting",
    "stopPolling",
    "stopConnectedPolling",
    "disconnectWhatsApp",
    "setStatus",
    "setMessages",
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
});

test("WhatsAppPanel's handleDisconnect does not resume connected-polling after a successful disconnect (the status is genuinely no longer connected)", async () => {
  const handlerMatch = whatsAppPanelSrc.match(/ {2}async function handleDisconnect\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let startConnectedPollingCalls = 0;
  let capturedStatus: unknown;

  const fn = new Function(
    "status",
    "setDisconnecting",
    "stopPolling",
    "stopConnectedPolling",
    "disconnectWhatsApp",
    "setStatus",
    "setMessages",
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
    (next: unknown) => {
      capturedStatus = next;
    },
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
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", onClose: () => {}, onJumpToEntity: () => {} })),
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
          React.createElement(LanguageProvider, null, React.createElement(WhatsAppPanel, { projectId: "proj1", onClose: () => {}, onJumpToEntity: () => {} })),
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
 * Mirrors BusinessTwinPanel's own onJumpToEntity pattern (round 141)
 * exactly. Renders one matched message and one unmatched message in the
 * same log, confirms only the matched one renders as a real clickable
 * button (the unmatched one must stay plain, inert text -- there's
 * nothing to jump to), and confirms clicking it calls onJumpToEntity with
 * the real matched entity name, not the display label or the phone number.
 */
test("WhatsAppPanel's message log makes a matched sender's name a real jump-to-entity button, and leaves an unmatched sender as plain text", async () => {
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
    const jumps: string[] = [];
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
              onClose: () => {},
              onJumpToEntity: (entityName: string) => jumps.push(entityName),
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
        jumps,
        ["Customer"],
        "must call onJumpToEntity with the real matched ENTITY NAME (Customer), not the display label (Dana Levi) or the phone number",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
