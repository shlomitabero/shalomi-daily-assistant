import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, ensureProjectsTable, ensureWhatsAppConnectionsTable, ensureWhatsAppMessagesTable, getWhatsAppConnection, insertProject, insertRecord, insertWhatsAppMessage, listWhatsAppMessages, markProjectBuilt, openDatabase } from "@forge/db";
import { WhatsAppWebManager, type BaileysCallEvent, type BaileysConnectionUpdate, type BaileysMessageUpdate, type BaileysMessagesUpsert, type WhatsAppSocket } from "./whatsappWeb.js";

/**
 * Real Baileys sockets talk to WhatsApp's actual servers over a raw
 * WebSocket, which this sandboxed dev environment cannot reach (its
 * outbound network only tunnels plain HTTPS through a proxy) -- confirmed
 * by a direct probe against the real library before writing this test
 * double. So every test here injects a fake socket/QR factory instead,
 * exercising the manager's real state machine (connecting -> qr ->
 * connected -> disconnected, message logging, sending) without touching
 * the real WhatsApp network. See docs/roadmap.md for the full disclosure.
 */
function createFakeSocket(options?: {
  getPNForLID?: (lid: string) => Promise<string | null | undefined>;
  /** Round 1242: lets a test make one specific sendMessage call fail (e.g. "the audio send"), while every other call on the same socket still succeeds -- needed to reproduce the two-call audio branch's own partial-failure scenario. */
  failWhen?: (content: Parameters<WhatsAppSocket["sendMessage"]>[1]) => boolean;
}) {
  const handlers: {
    creds?: () => void;
    connectionUpdate?: (u: BaileysConnectionUpdate) => void;
    messagesUpsert?: (u: BaileysMessagesUpsert) => void;
    messagesUpdate?: (u: BaileysMessageUpdate[]) => void;
    call?: (calls: BaileysCallEvent[]) => void;
  } = {};
  const sendCalls: (
    | { jid: string; text: string }
    | { jid: string; document: Buffer; mimetype: string; fileName: string; caption?: string }
    | { jid: string; image: Buffer; mimetype: string; caption?: string }
    | { jid: string; video: Buffer; mimetype: string; caption?: string }
    | { jid: string; audio: Buffer; mimetype: string; ptt?: boolean }
  )[] = [];
  // Round 1618: a deterministic, distinct id per real Baileys sendMessage
  // call -- mirrors the real library's own `key.id` (WAMessageUpdate's
  // own correlation key), letting a test assert exactly which send a
  // later "messages.update" delivery-failure event ought to reconcile
  // against.
  const sentMessageIds: string[] = [];
  let loggedOut = false;

  const sock: WhatsAppSocket = {
    ev: {
      on(event, listener) {
        if (event === "creds.update") handlers.creds = listener as () => void;
        if (event === "connection.update") handlers.connectionUpdate = listener as (u: BaileysConnectionUpdate) => void;
        if (event === "messages.upsert") handlers.messagesUpsert = listener as (u: BaileysMessagesUpsert) => void;
        if (event === "messages.update") handlers.messagesUpdate = listener as (u: BaileysMessageUpdate[]) => void;
        if (event === "call") handlers.call = listener as (calls: BaileysCallEvent[]) => void;
      },
    },
    user: null,
    ...(options?.getPNForLID ? { signalRepository: { lidMapping: { getPNForLID: options.getPNForLID } } } : {}),
    async sendMessage(jid, content) {
      if (options?.failWhen?.(content)) {
        throw new Error("fake Baileys send failure");
      }
      if ("text" in content) {
        sendCalls.push({ jid, text: content.text });
      } else if ("document" in content) {
        sendCalls.push({ jid, document: content.document, mimetype: content.mimetype, fileName: content.fileName, caption: content.caption });
      } else if ("image" in content) {
        sendCalls.push({ jid, image: content.image, mimetype: content.mimetype, caption: content.caption });
      } else if ("video" in content) {
        sendCalls.push({ jid, video: content.video, mimetype: content.mimetype, caption: content.caption });
      } else {
        sendCalls.push({ jid, audio: content.audio, mimetype: content.mimetype, ptt: content.ptt });
      }
      const id = `wa-id-${sentMessageIds.length}`;
      sentMessageIds.push(id);
      return { key: { id } };
    },
    async logout() {
      loggedOut = true;
    },
  };

  return {
    sock,
    sendCalls,
    sentMessageIds,
    isLoggedOut: () => loggedOut,
    emitConnectionUpdate: (u: BaileysConnectionUpdate) => handlers.connectionUpdate?.(u),
    emitMessagesUpsert: (u: BaileysMessagesUpsert) => handlers.messagesUpsert?.(u),
    emitMessagesUpdate: (u: BaileysMessageUpdate[]) => handlers.messagesUpdate?.(u),
    emitCall: (calls: BaileysCallEvent[]) => handlers.call?.(calls),
  };
}

function setupManager(options?: Parameters<typeof createFakeSocket>[0]) {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const createdSockets: ReturnType<typeof createFakeSocket>[] = [];
  let createSocketCalls = 0;
  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-test-sessions",
    createSocket: async () => {
      createSocketCalls++;
      const fake = createFakeSocket(options);
      createdSockets.push(fake);
      return { sock: fake.sock, saveCreds: async () => {} };
    },
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
  });

  return { db, manager, createdSockets, getCreateSocketCalls: () => createSocketCalls };
}

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "test",
  description: "test",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Customer",
        label: "לקוחות",
        fields: [
          { name: "name", label: "שם", type: "text", required: true },
          { name: "phone", label: "טלפון", type: "text", required: false },
        ],
      },
    ],
  },
};

test("getStatus reports disconnected with no phone number for a project that never connected", async () => {
  const { manager } = setupManager();
  assert.deepEqual(manager.getStatus("proj1"), { status: "disconnected", qrDataUrl: null, phoneNumber: null, error: null });
});

test("connect moves to connecting, then qr once the socket emits one, using the injected QR encoder", async () => {
  const { manager, createdSockets } = setupManager();
  const state = await manager.connect("proj1");
  assert.equal(state.status, "connecting");

  createdSockets[0].emitConnectionUpdate({ qr: "raw-qr-string" });
  // The manager encodes the QR asynchronously (real QR encoding is real
  // async work too) -- give its fire-and-forget handler a turn of the
  // event loop to finish before reading status back, the same way a real
  // status-polling request arriving slightly later would.
  await new Promise((resolve) => setImmediate(resolve));
  const afterQr = manager.getStatus("proj1");
  assert.equal(afterQr.status, "qr");
  assert.equal(afterQr.qrDataUrl, "data:image/png;base64,FAKE(raw-qr-string)");
});

test("connect does not spawn a second socket while already connecting or connected", async () => {
  const { manager, getCreateSocketCalls } = setupManager();
  await manager.connect("proj1");
  await manager.connect("proj1");
  assert.equal(getCreateSocketCalls(), 1);
});

test("a connection.update with connection: open marks the session connected, extracts the phone number, and persists it", async () => {
  const { manager, createdSockets, db } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const state = manager.getStatus("proj1");
  assert.equal(state.status, "connected");
  assert.equal(state.phoneNumber, "972501234567");
  assert.equal(state.qrDataUrl, null);

  const stored = getWhatsAppConnection(db, "proj1");
  assert.equal(stored?.phoneNumber, "972501234567");
  assert.ok(stored?.connectedAt);
});

test("a connection.update with connection: close drops the session back to disconnected", async () => {
  const { manager, createdSockets, db } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });
  createdSockets[0].emitConnectionUpdate({ connection: "close" });

  const state = manager.getStatus("proj1");
  assert.equal(state.status, "disconnected");
  // Last known number is still remembered for display, even though the live session is gone.
  assert.equal(state.phoneNumber, "972501234567");
  const stored = getWhatsAppConnection(db, "proj1");
  assert.equal(stored?.connectedAt, null);
});

/**
 * Regression test for a real bug found by round 382's Explore survey: a QR
 * code that times out before being scanned (Baileys closes the socket with
 * a non-401 status once it exhausts its own QR-refresh budget, confirmed by
 * reading Baileys' own socket.js) previously closed with no explanation at
 * all -- handleConnectionUpdate's close branch unconditionally deleted the
 * session from the manager's map, and getStatus() unconditionally returns
 * error: null the instant a project has no live session, so whatever error
 * might have been set was immediately unreachable anyway. The user just saw
 * the QR silently vanish and a bare "disconnected" state with zero hint why.
 */
test("a QR code that times out before being scanned (a non-401 close while still awaiting one) surfaces a real explanation instead of silently reverting to disconnected", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].emitConnectionUpdate({ qr: "raw-qr-string" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getStatus("proj1").status, "qr");

  // Baileys' own "timedOut"/"connectionLost" status for a QR that was
  // never scanned in time -- definitely not the 401 "logged out" code.
  createdSockets[0].emitConnectionUpdate({ connection: "close", lastDisconnect: { error: { output: { statusCode: 408 } } } });

  const state = manager.getStatus("proj1");
  assert.equal(state.status, "disconnected");
  assert.equal(state.qrDataUrl, null);
  assert.ok(state.error, "expected a real explanation, not a silent revert to disconnected");
  assert.match(state.error!, /qr/i);

  // The next connect() call must still work normally against this
  // left-in-place session -- the fix doesn't wedge the project shut.
  const reconnectState = await manager.connect("proj1");
  assert.equal(reconnectState.status, "connecting");
});

/**
 * Same bug class, the other branch: a connection that WAS fully open and
 * then drops (a non-401, non-515 close after "open", not while still
 * awaiting a QR scan) must get a real explanation too, but a different,
 * accurate one -- "the QR code expired" would be misleading for a session
 * that was never waiting on a QR scan in the first place.
 *
 * Round 1415: this test originally used status code 515 for "some other
 * ordinary disconnect" -- but 515 is Baileys' own `DisconnectReason.
 * restartRequired`, which (confirmed directly against the installed
 * library) always means "please reconnect now," never "give up," whether
 * it happens during initial pairing or after a connection was already
 * open (`getErrorCodeFromStreamError` in `baileys/lib/Utils/generics.js`
 * maps it to `"restart required"` unconditionally, with no pairing-only
 * special case). 515 now gets its own dedicated auto-reconnect test right
 * below; this test switched to 428 (`DisconnectReason.connectionClosed`)
 * -- a genuinely different, non-restart-required code -- to keep testing
 * what it always meant to: an ordinary lost connection this manager
 * really should give up on and explain, not silently retry.
 */
test("a connection that drops after being fully connected (not a QR timeout, not a restart-required 515) surfaces a different, accurate explanation", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });
  assert.equal(manager.getStatus("proj1").status, "connected");

  createdSockets[0].emitConnectionUpdate({ connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });

  const state = manager.getStatus("proj1");
  assert.equal(state.status, "disconnected");
  assert.ok(state.error, "expected a real explanation, not a silent revert to disconnected");
  assert.doesNotMatch(state.error!, /qr/i, "a session that was never waiting on a QR scan must not blame a QR code");
});

/**
 * Round 1415's Explore survey found that status code 515 (Baileys'
 * DisconnectReason.restartRequired) is not actually "a connection that
 * drops after being fully connected" the way the test above USED to
 * exercise it -- confirmed directly against the installed library:
 * `baileys/lib/Socket/socket.js`'s own "device paired for the first
 * time ... if device pairs successfully, the server asks to restart the
 * connection" comment shows it firing right after a QR scan succeeds,
 * strictly BEFORE connection: "open" is ever emitted; `baileys/lib/Utils/
 * generics.js`'s `getErrorCodeFromStreamError` maps this code to the
 * literal reason string `"restart required"` with no condition on prior
 * connection state at all, confirming it means "reconnect now" universally,
 * not only during initial pairing. This first test covers the real,
 * guaranteed sequence for every first-time WhatsApp link: qr -> (scan) ->
 * close(515) while session.status is still "qr" -- which the pre-fix code
 * treated as wasAwaitingQr and surfaced as "the QR code expired", even
 * though the QR was in fact just scanned successfully.
 */
test("Baileys' restart-required close (515) right after a QR scan reconnects automatically instead of surfacing a false 'QR expired' error", async () => {
  const { manager, createdSockets, getCreateSocketCalls } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].emitConnectionUpdate({ qr: "raw-qr-string" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getStatus("proj1").status, "qr");

  // The real sequence: pairing succeeded, Baileys closes with 515 to force
  // a restart -- never connection: "open" first.
  createdSockets[0].emitConnectionUpdate({ connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((resolve) => setImmediate(resolve));

  const midState = manager.getStatus("proj1");
  assert.notEqual(midState.status, "disconnected", "must not surface a disconnect for an in-progress pairing restart");
  assert.equal(midState.error, null, "must not surface QR_EXPIRED_MESSAGE (or any error) for a successful pairing restart");
  assert.equal(getCreateSocketCalls(), 2, "the 515 close must trigger a fresh createSocket() call automatically, reusing the already-saved creds");

  // The fresh socket completing the real reconnect (no new QR needed,
  // exactly like a manual "click Connect again" already worked around
  // this before the fix) proves this wasn't a dead end.
  createdSockets[1].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[1].emitConnectionUpdate({ connection: "open" });
  assert.equal(manager.getStatus("proj1").status, "connected");
});

/**
 * Same restart-required code, the other timing: Baileys can also send a
 * 515 close to a connection that was already fully "open" (e.g. the
 * server asking an existing session to restart for an unrelated reason) --
 * per `getErrorCodeFromStreamError`'s own unconditional mapping (see the
 * test above's doc comment), this means exactly the same thing in either
 * case: reconnect, don't surface a disconnect.
 */
test("Baileys' restart-required close (515) after an already-open connection also reconnects automatically, not just during initial pairing", async () => {
  const { manager, createdSockets, getCreateSocketCalls } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });
  assert.equal(manager.getStatus("proj1").status, "connected");

  createdSockets[0].emitConnectionUpdate({ connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((resolve) => setImmediate(resolve));

  const midState = manager.getStatus("proj1");
  assert.notEqual(midState.status, "disconnected", "a restart-required close on an already-open connection must not surface a disconnect either");
  assert.equal(midState.error, null);
  assert.equal(getCreateSocketCalls(), 2, "must trigger a fresh createSocket() call automatically");

  createdSockets[1].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[1].emitConnectionUpdate({ connection: "open" });
  assert.equal(manager.getStatus("proj1").status, "connected");
});

/**
 * Round 1701: disconnect() reads `session` and starts `await session.sock.
 * logout()` -- a real suspension point -- but, unlike every OTHER handler
 * in this class (runConnectAttempt, handleConnectionUpdate,
 * handleIncomingMessages, handleIncomingCalls, handleMessageUpdates, all
 * of which re-check `this.sessions.get(projectId)` after their own await),
 * never re-checks anything once that logout() resolves. The restartRequired
 * (515) branch above reuses the EXACT SAME session object in place rather
 * than replacing it in the map -- so if a 515 close lands on an
 * already-connected session while disconnect()'s own logout() is still in
 * flight (per the test just above, this can happen for a reason unrelated
 * to the user's disconnect click), that branch's own `await
 * this.beginConnectAttempt(...)` can finish and give `session.sock` a
 * brand-new, fully live socket before disconnect()'s continuation ever
 * resumes. disconnect() then unconditionally deletes the map entry,
 * orphaning that live socket forever: nothing ever calls .logout() on it,
 * and every other handler's own `this.sessions.get(projectId) !== session`
 * check (now `undefined !== session`) silently discards every future
 * event from it.
 */
test("disconnect() also logs out the NEW live socket if Baileys' own 515 restart-required close reconnects the same session while the OLD socket's logout() is still in flight", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });
  assert.equal(manager.getStatus("proj1").status, "connected");

  // Make the OLD socket's logout() controllable, so the test can land the
  // 515 close while disconnect() is still awaiting it.
  let resolveLogout!: () => void;
  createdSockets[0].sock.logout = () => new Promise<void>((resolve) => { resolveLogout = resolve; });

  const disconnectPromise = manager.disconnect("proj1");

  // While that logout() is still pending, Baileys independently delivers a
  // 515 restart-required close on the SAME, still-live socket -- exactly
  // the scenario the test above proves is real, just landing mid-disconnect
  // this time.
  createdSockets[0].emitConnectionUpdate({ connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createdSockets.length, 2, "the 515 close must have already created a fresh, live second socket while the old one's logout() was still pending");

  // Only now does the original logout() resolve, letting disconnect()'s
  // own continuation run.
  resolveLogout();
  await disconnectPromise;

  assert.ok(
    createdSockets[1].isLoggedOut(),
    "the brand-new socket the 515 restart created in place must also be logged out, not abandoned live and unreachable",
  );
  assert.equal(manager.getStatus("proj1").status, "disconnected");
});

test("sendMessage succeeds once connected, addressing the real WhatsApp JID format", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "שלום!");
  assert.equal(result.ok, true);
  assert.deepEqual(createdSockets[0].sendCalls, [{ jid: "972509998888@s.whatsapp.net", text: "שלום!" }]);
  assert.equal(result.waMessageId, createdSockets[0].sentMessageIds[0], "the id Baileys assigned to the real sendMessage call must be returned, for later delivery-status reconciliation");
});

/**
 * Round 1618: performSend's own promise resolving only means Baileys
 * handed the message to the WhatsApp server -- a real downstream failure
 * (the recipient's number isn't on WhatsApp, the recipient blocked the
 * linked number) surfaces later, asynchronously, through a structurally
 * separate Baileys event, "messages.update", carrying the real outcome
 * for the exact id this test asserts sendMessage's own result returns.
 */
test("a 'messages.update' delivery-failure event (status ERROR) flips the matching sent message's log row to failed", async () => {
  const { manager, db, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "hello");
  assert.equal(result.ok, true);
  const waMessageId = result.waMessageId!;
  assert.ok(waMessageId, "sendMessage must return the real Baileys-assigned id to reconcile against");

  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "out",
    fromNumber: "972501234567",
    toNumber: "972509998888",
    body: "hello",
    status: "sent",
    waMessageId,
  });

  createdSockets[0].emitMessagesUpdate([{ key: { id: waMessageId }, update: { status: 0 } }]);
  await new Promise((resolve) => setImmediate(resolve));

  const { messages } = listWhatsAppMessages(db, "proj1");
  assert.equal(messages[0].status, "failed", "the log row for this exact waMessageId must flip from sent to failed");
});

/**
 * Round 1634: DELIVERY_ACK/READ are no longer no-ops -- they advance the
 * log row's own status, the delivery-lifecycle equivalent of WhatsApp's
 * own native gray/blue double-checkmarks, closing the gap this exact test
 * (pre-round-1634) deliberately left as the then-current scope.
 */
test("a 'messages.update' event with status DELIVERY_ACK advances the message log row to delivered", async () => {
  const { manager, db, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "hello");
  const waMessageId = result.waMessageId!;
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "out",
    fromNumber: "972501234567",
    toNumber: "972509998888",
    body: "hello",
    status: "sent",
    waMessageId,
  });

  createdSockets[0].emitMessagesUpdate([{ key: { id: waMessageId }, update: { status: 3 } }]);
  await new Promise((resolve) => setImmediate(resolve));

  const { messages } = listWhatsAppMessages(db, "proj1");
  assert.equal(messages[0].status, "delivered", "DELIVERY_ACK must advance the row from sent to delivered");
});

test("a 'messages.update' event with status READ advances the message log row to read, including straight from sent (skipping delivered)", async () => {
  const { manager, db, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "hello");
  const waMessageId = result.waMessageId!;
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "out",
    fromNumber: "972501234567",
    toNumber: "972509998888",
    body: "hello",
    status: "sent",
    waMessageId,
  });

  // Real WhatsApp traffic can skip straight from sent to read (e.g. the
  // recipient opens the chat before a separate DELIVERY_ACK is observed).
  createdSockets[0].emitMessagesUpdate([{ key: { id: waMessageId }, update: { status: 4 } }]);
  await new Promise((resolve) => setImmediate(resolve));

  const { messages } = listWhatsAppMessages(db, "proj1");
  assert.equal(messages[0].status, "read", "READ must advance the row to read even without an observed intermediate DELIVERY_ACK");
});

test("a 'messages.update' event with status READ never downgrades an already-delivered row, and a later DELIVERY_ACK never downgrades an already-read row", async () => {
  const { manager, db, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "hello");
  const waMessageId = result.waMessageId!;
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "out",
    fromNumber: "972501234567",
    toNumber: "972509998888",
    body: "hello",
    status: "sent",
    waMessageId,
  });

  createdSockets[0].emitMessagesUpdate([{ key: { id: waMessageId }, update: { status: 4 } }]);
  await new Promise((resolve) => setImmediate(resolve));
  let { messages } = listWhatsAppMessages(db, "proj1");
  assert.equal(messages[0].status, "read");

  // A stale/out-of-order DELIVERY_ACK arriving after READ must never
  // downgrade the row -- see markWhatsAppMessageDeliveryStatus's own doc
  // comment on DELIVERY_STATUS_ALLOWED_FROM for why.
  createdSockets[0].emitMessagesUpdate([{ key: { id: waMessageId }, update: { status: 3 } }]);
  await new Promise((resolve) => setImmediate(resolve));
  ({ messages } = listWhatsAppMessages(db, "proj1"));
  assert.equal(messages[0].status, "read", "a late DELIVERY_ACK must never downgrade an already-read row");
});

test("a 'messages.update' event with status PENDING or SERVER_ACK leaves the message log row untouched", async () => {
  const { manager, db, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "hello");
  const waMessageId = result.waMessageId!;
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "out",
    fromNumber: "972501234567",
    toNumber: "972509998888",
    body: "hello",
    status: "sent",
    waMessageId,
  });

  createdSockets[0].emitMessagesUpdate([{ key: { id: waMessageId }, update: { status: 1 } }]);
  createdSockets[0].emitMessagesUpdate([{ key: { id: waMessageId }, update: { status: 2 } }]);
  await new Promise((resolve) => setImmediate(resolve));

  const { messages } = listWhatsAppMessages(db, "proj1");
  assert.equal(messages[0].status, "sent", "PENDING/SERVER_ACK are not forward progress a user could tell apart from plain sent");
});

test("a 'messages.update' delivery-failure event for an id this project never sent is a harmless no-op, not a crash", async () => {
  const { manager, db, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "out",
    fromNumber: "972501234567",
    toNumber: "972509998888",
    body: "hello",
    status: "sent",
    waMessageId: "a-real-id",
  });

  createdSockets[0].emitMessagesUpdate([{ key: { id: "some-unrelated-id" }, update: { status: 0 } }]);
  await new Promise((resolve) => setImmediate(resolve));

  const { messages } = listWhatsAppMessages(db, "proj1");
  assert.equal(messages[0].status, "sent", "an id that matches no row must never touch an unrelated row");
});

/**
 * Round 794: a legitimate workflow (EntityPanel.tsx's bulk-update "Apply to
 * N", deliberately left firing automations normally per round 643/644,
 * unlike CSV import's suppression) can fire many concurrent sendMessage()
 * calls for the same project at once, each independently matching an
 * automation rule. Before this round, nothing serialized them -- they all
 * raced the one shared Baileys socket in the same instant, exactly the
 * "automated behavior" burst pattern this file's own module doc comment
 * warns can get a real WhatsApp number flagged or temporarily blocked
 * (flagged as a known gap in round 744's survey, deliberately left open).
 * The fake socket here holds its own sendMessage open for a few
 * milliseconds (unlike createFakeSocket's default, which resolves
 * instantly and so could never actually observe an overlap) so a real
 * concurrency violation would be caught instead of coincidentally passing.
 */
test("sendMessage serializes concurrent sends for the same project so the socket never sees two in flight at once", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const fake = createFakeSocket();
  const originalSendMessage = fake.sock.sendMessage.bind(fake.sock);
  fake.sock.sendMessage = async (jid, content) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await originalSendMessage(jid, content);
    if ("text" in content) order.push(content.text);
    active--;
    return result;
  };

  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-test-sessions-serialize",
    createSocket: async () => ({ sock: fake.sock, saveCreds: async () => {} }),
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
    // No real-world delay needed to prove ordering/non-overlap -- only
    // the fake socket's own artificial 5ms hold-open above matters for that.
    sendSpacingMs: 0,
  });

  await manager.connect("proj1");
  fake.sock.user = { id: "972501234567:1@s.whatsapp.net" };
  fake.emitConnectionUpdate({ connection: "open" });

  const results = await Promise.all([
    manager.sendMessage("proj1", "972501111111", "one"),
    manager.sendMessage("proj1", "972502222222", "two"),
    manager.sendMessage("proj1", "972503333333", "three"),
  ]);

  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, true],
  );
  assert.equal(maxActive, 1, "the socket must never see two sends in flight at the same time");
  assert.deepEqual(order, ["one", "two", "three"], "sends must go out in call order, one at a time, not interleaved");
});

/**
 * Round 1326: a real Baileys sock.sendMessage() call can hang indefinitely
 * (a stalled/half-open TCP session, a WhatsApp-server ack that never
 * arrives) -- before this round, nothing bounded how long performSend
 * would wait, and since every send for a project is chained onto one
 * shared sendQueue (see its own doc comment above), a single hung call
 * would block every later send for that project forever, with no error.
 * This fake socket's sendMessage never resolves at all for its first call,
 * the same way a real hung Baileys call never would -- proving both that
 * the hung call itself times out with a stable "timeout" code, AND that a
 * later queued send for the same project still goes through instead of
 * waiting behind it forever.
 */
test("sendMessage times out a hung Baileys sendMessage() call instead of blocking every later send for the project forever", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const fake = createFakeSocket();
  const originalSendMessage = fake.sock.sendMessage.bind(fake.sock);
  let hangNextCall = true;
  fake.sock.sendMessage = (jid, content) => {
    if (hangNextCall) {
      hangNextCall = false;
      return new Promise(() => {}); // never resolves/rejects, like a real hung Baileys call
    }
    return originalSendMessage(jid, content);
  };

  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-test-sessions-timeout",
    createSocket: async () => ({ sock: fake.sock, saveCreds: async () => {} }),
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
    sendSpacingMs: 0,
    sendTimeoutMs: 20,
  });

  await manager.connect("proj1");
  fake.sock.user = { id: "972501234567:1@s.whatsapp.net" };
  fake.emitConnectionUpdate({ connection: "open" });

  const hungResult = await manager.sendMessage("proj1", "972501111111", "one");
  assert.equal(hungResult.ok, false);
  assert.equal(hungResult.error, "timeout");

  const nextResult = await manager.sendMessage("proj1", "972502222222", "two");
  assert.equal(nextResult.ok, true, "the queue must still advance to the next send instead of waiting behind the hung one forever");
  assert.deepEqual(fake.sendCalls, [{ jid: "972502222222@s.whatsapp.net", text: "two" }]);
});

/**
 * Same mechanism, the other half: serializing sends for ONE project must
 * never block a completely unrelated project's own sends behind it --
 * sendQueue is keyed by projectId precisely so two projects' sockets stay
 * fully independent.
 */
test("sendMessage for one project does not wait behind a slow in-flight send for a different project", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  await manager.connect("proj2");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });
  createdSockets[1].sock.user = { id: "972509999999:1@s.whatsapp.net" };
  createdSockets[1].emitConnectionUpdate({ connection: "open" });

  let resolveProj1Send!: () => void;
  const originalSend = createdSockets[0].sock.sendMessage.bind(createdSockets[0].sock);
  createdSockets[0].sock.sendMessage = (jid, content) =>
    new Promise((resolve) => {
      resolveProj1Send = () => resolve(originalSend(jid, content));
    });

  const proj1Send = manager.sendMessage("proj1", "972501111111", "slow");
  const proj2Result = await manager.sendMessage("proj2", "972502222222", "fast");

  assert.equal(proj2Result.ok, true, "project 2's send must not be stuck waiting on project 1's still-unresolved send");
  resolveProj1Send();
  assert.equal((await proj1Send).ok, true);
});

/**
 * Round 786: automations.ts's findTemplateFileAttachment resolves a real
 * file field's value down to a path on disk -- this is the layer below
 * it that actually reads that file and hands it to Baileys as a document,
 * alongside its text as the caption, instead of ever sending only text.
 */
test("sendMessage attaches a real file from disk as a document, with the message text as its caption, when given an attachment", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const dir = await mkdtemp(path.join(tmpdir(), "forge-whatsapp-attachment-test-"));
  try {
    const filePath = path.join(dir, "invoice.pdf");
    await writeFile(filePath, "%PDF-fake-invoice-contents");

    const result = await manager.sendMessage("proj1", "972509998888", "הנה החשבונית שלך", {
      filePath,
      fileName: "invoice-203.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(createdSockets[0].sendCalls, [
      {
        jid: "972509998888@s.whatsapp.net",
        document: Buffer.from("%PDF-fake-invoice-contents"),
        mimetype: "application/pdf",
        fileName: "invoice-203.pdf",
        caption: "הנה החשבונית שלך",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Round 786: the referenced upload can be gone by the time an automation
 * actually fires (deleted, replaced by a later edit) -- degrading to a
 * plain text send (still mentioning the filename, since that text comes
 * from interpolateTemplate independently) is strictly more useful than
 * failing the whole send over a missing attachment, and must not be
 * reported as a send FAILURE the way a genuine Baileys/network error is.
 */
test("sendMessage falls back to a plain text send when the attachment's file no longer exists on disk, instead of failing the whole send", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "הנה החשבונית שלך: invoice-203.pdf", {
    filePath: "/tmp/forge-whatsapp-attachment-test-does-not-exist/invoice.pdf",
    fileName: "invoice-203.pdf",
    mimeType: "application/pdf",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(createdSockets[0].sendCalls, [{ jid: "972509998888@s.whatsapp.net", text: "הנה החשבונית שלך: invoice-203.pdf" }]);
});

/**
 * Round 1441: a real bug the survey found -- the exact same class round
 * 1420 already fixed for the audio branch, but on this function's OTHER
 * fallback: automations.ts's own round-1341 multi-attachment follow-up
 * sends every attachment after the first via this exact function with
 * body hardcoded to "" (deliberately caption-less). When that SECOND (or
 * later) attachment's file has been deleted/replaced since the rule last
 * ran (the exact scenario the round-786 test above covers with a real
 * body), the round-786 fallback used to send `{ text: "" }` unconditionally
 * -- a real, visible, blank WhatsApp message to the actual customer, with
 * the run still logged as a successful send. Confirms an empty body now
 * suppresses the fallback text send entirely, matching round 1420's own
 * "silently absent, not an extra blank message" precedent.
 */
test("sendMessage sends nothing at all, not a blank text message, when a load-failed attachment's body is empty (round-1341's caption-less multi-attachment follow-up)", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "", {
    filePath: "/tmp/forge-whatsapp-attachment-test-does-not-exist/invoice.pdf",
    fileName: "invoice-203.pdf",
    mimeType: "application/pdf",
  });
  // Round 1443: this used to assert `ok: true` here -- correct about no
  // blank message going out, but it also meant a customer who received
  // literally nothing was logged as a clean "sent". See this round's own
  // fix just below in performSend.
  assert.equal(result.ok, false, "nothing was actually sent, so this must not be reported as a successful send");
  assert.deepEqual(
    createdSockets[0].sendCalls,
    [],
    "an empty body against a load-failed attachment must never produce a blank WhatsApp text message",
  );
});

/**
 * Round 966's own audio branch has no `caption` field to pass through (see
 * performSend's own doc comment there), so it sends the caption text and
 * the audio clip as two independent Baileys calls -- this confirms the
 * happy path sends both, and in the real order (round 1242: audio first,
 * caption text second -- see the next test for why).
 */
test("sendMessage attaches a real audio file from disk, sending the audio clip first and the caption text second", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const dir = await mkdtemp(path.join(tmpdir(), "forge-whatsapp-audio-attachment-test-"));
  try {
    const filePath = path.join(dir, "voice-note.ogg");
    await writeFile(filePath, "fake-ogg-audio-bytes");

    const result = await manager.sendMessage("proj1", "972509998888", "הנה הקלטה", {
      filePath,
      fileName: "voice-note.ogg",
      mimeType: "audio/ogg",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(createdSockets[0].sendCalls, [
      { jid: "972509998888@s.whatsapp.net", audio: Buffer.from("fake-ogg-audio-bytes"), mimetype: "audio/ogg", ptt: false },
      { jid: "972509998888@s.whatsapp.net", text: "הנה הקלטה" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Round 1420: a real bug the survey found -- automations.ts's own round-1341
 * multi-attachment follow-up (fireRule, when an automation's template
 * references two or more distinct file fields) sends every attachment
 * after the first via this exact function with body hardcoded to "",
 * deliberately caption-less -- for image/video/document that's a genuine
 * no-op (an empty `caption` field on their single Baileys call), but this
 * branch's second call used to be unconditional, so an empty body here
 * meant an extra, separate, visible BLANK WhatsApp message sent to the
 * real recipient right after the audio clip. Confirms an empty body now
 * suppresses that second call entirely, leaving only the audio clip sent.
 */
test("sendMessage's audio branch sends only the audio clip, with no second blank text message, when invoked with an empty body", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const dir = await mkdtemp(path.join(tmpdir(), "forge-whatsapp-audio-attachment-test-"));
  try {
    const filePath = path.join(dir, "voice-note.ogg");
    await writeFile(filePath, "fake-ogg-audio-bytes");

    const result = await manager.sendMessage("proj1", "972509998888", "", {
      filePath,
      fileName: "voice-note.ogg",
      mimeType: "audio/ogg",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      createdSockets[0].sendCalls,
      [{ jid: "972509998888@s.whatsapp.net", audio: Buffer.from("fake-ogg-audio-bytes"), mimetype: "audio/ogg", ptt: false }],
      "an empty body must never produce a second, blank WhatsApp text message -- only the audio clip itself must be sent",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Round 1242: a real bug the survey found -- the audio branch used to send
 * the caption TEXT first and the audio clip second. A real Baileys media
 * upload (the audio send) is a far more failure-prone network round-trip
 * than a plain text send, so the common real-world partial failure was
 * "caption text delivered, then the audio upload throws" -- performSend's
 * own outer catch reports the WHOLE send as failed, automations.ts's
 * fireRule records the run as "failed", and clicking the Automations
 * History panel's own "Retry" action (fireRule fired again from scratch,
 * with zero partial-progress tracking -- see automations.ts's own fireRule
 * doc comment) resent the identical caption text a SECOND time to the real
 * customer, before attempting the audio again. This test reproduces the
 * underlying send-order bug directly: forces the FIRST Baileys call this
 * branch makes to throw, and confirms nothing else was sent alongside it --
 * with the fix (audio first), that first-call failure now means nothing
 * was delivered at all, so a subsequent Retry is safe to resend both from
 * scratch exactly once.
 */
test("sendMessage's audio branch sends nothing at all when its first Baileys call fails, so a later Retry resending both from scratch can never duplicate anything", async () => {
  const { manager, createdSockets } = setupManager({ failWhen: (content) => "audio" in content });
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const dir = await mkdtemp(path.join(tmpdir(), "forge-whatsapp-audio-attachment-test-"));
  try {
    const filePath = path.join(dir, "voice-note.ogg");
    await writeFile(filePath, "fake-ogg-audio-bytes");

    const result = await manager.sendMessage("proj1", "972509998888", "הנה הקלטה", {
      filePath,
      fileName: "voice-note.ogg",
      mimeType: "audio/ogg",
    });
    assert.equal(result.ok, false, "the overall send must still be reported as failed");
    assert.deepEqual(
      createdSockets[0].sendCalls,
      [],
      "the caption text must NOT have gone out at all once the audio upload (the first call) failed -- otherwise a later Retry duplicates it",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sendMessage refuses honestly when 'to' is a bare local-format number missing its country code, instead of addressing a wrong/nonexistent JID", async () => {
  // This app's own seed data and Hebrew templates store phone numbers in
  // exactly this local format (e.g. "050-123-4567"), and EntityPanel's
  // "Send WhatsApp" row action feeds a record's raw stored value straight
  // through -- this is the common real path, not a contrived edge case.
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "050-123-4567", "שלום!");
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_country_code");
  assert.deepEqual(createdSockets[0].sendCalls, []);
});

/**
 * Round 1295: the sibling shape to the bare-local-format test above --
 * this app's own doc comment (whatsapp.ts's round-926 fix) already names
 * "+972-050-1234567" as an entirely ordinary way for a business owner to
 * type a familiar local number with the country code tacked on the front
 * without remembering to drop the trunk zero. Unlike the bare-local-format
 * case, this has ZERO leading zeros (the country code comes first), so the
 * existing leadingZeros check never caught it, and normalizePhone's
 * leading-zero strip can't reach the now-embedded zero either --
 * previously this silently built a real-looking but wrong 13-digit JID
 * ("9720501234567@s.whatsapp.net") instead of refusing honestly.
 */
test("sendMessage refuses honestly when 'to' is Israel's own country code with the local trunk zero still left in, instead of addressing a wrong/nonexistent 13-digit JID", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "+972-050-1234567", "שלום!");
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_country_code");
  assert.deepEqual(createdSockets[0].sendCalls, []);
});

/**
 * Round 765 regression test: the leading-zero classification only ever
 * checked for exactly 1 (reject) or exactly 2 (the "00" access code,
 * allow) -- 3 or more leading zeros fell through neither branch and was
 * silently sent. normalizePhone strips the *entire* run of leading zeros
 * regardless of count, so "000501234567" (a realistic typo: a "00"
 * access-code prefix glued onto a local-format number that still has its
 * own trunk zero) normalizes to "501234567" -- the exact same country-
 * code-missing shape the 1-zero branch exists to reject -- yet sailed
 * through to a real sendMessage call before this fix.
 */
test("sendMessage refuses honestly when 'to' has 3 or more leading zeros, instead of silently stripping them all and addressing a wrong/nonexistent JID", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "000-501-234-567", "שלום!");
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_country_code");
  assert.deepEqual(createdSockets[0].sendCalls, []);
});

test("sendMessage builds a real, fully-qualified JID for a number typed with a 00 international access code", async () => {
  // Unlike the local-format case above ("050-123-4567" -> missing its
  // country code entirely, now refused honestly instead of silently
  // mis-addressed), a number typed as "00972-50-123-4567" (the
  // international access code convention) IS meant to resolve to a
  // fully-qualified number -- it must not keep a spurious leading "0"
  // that was never part of the number, which would address a
  // wrong/nonexistent JID.
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "00972-50-123-4567", "שלום!");
  assert.equal(result.ok, true);
  assert.deepEqual(createdSockets[0].sendCalls, [{ jid: "972501234567@s.whatsapp.net", text: "שלום!" }]);
});

test("sendMessage sends successfully to an already-fully-qualified number from a shorter-numbered country than the connected account's own number", async () => {
  // Israeli numbers (connected account here) are 12 digits once normalized;
  // a fully-qualified US number ("+1 202-555-0123") is only 11 -- comparing
  // digit *counts* against the connected account's own number (an earlier,
  // now-replaced version of this check) would wrongly flag every such
  // cross-country send as missing its country code, even though it already
  // has one. The actual signal (exactly one leading zero in the raw input)
  // must not depend on any other number at all.
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "+1 202-555-0123", "hi");
  assert.equal(result.ok, true);
  assert.deepEqual(createdSockets[0].sendCalls, [{ jid: "12025550123@s.whatsapp.net", text: "hi" }]);
});

test("sendMessage refuses honestly when not connected, instead of pretending to send", async () => {
  const { manager } = setupManager();
  const result = await manager.sendMessage("proj1", "972500000000", "hi");
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_connected");
});

test("sendMessage rejects a 'to' value with no digits at all, instead of sending to an empty JID", async () => {
  // The route's own zod schema only enforces a non-empty string, not that
  // it contains a real phone number -- normalizePhone("abc") strips every
  // character, so without this check the socket would receive
  // "@s.whatsapp.net" as a real send target.
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "abc", "hi");
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_phone_number");
  assert.deepEqual(createdSockets[0].sendCalls, []);
});

test("an incoming text message is logged and matched to the right customer record by phone number", async () => {
  const { manager, createdSockets, db } = setupManager();
  ensureProjectsTable(db);
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);
  insertRecord(db, project.id, project.spec.entities[0], { name: "Dana Levi", phone: "050-123-4567" });

  await manager.connect(project.id);
  createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { conversation: "מתי התור שלי?" },
      },
    ],
  });

  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, "in");
  assert.equal(messages[0].body, "מתי התור שלי?");
  assert.equal(messages[0].matchedEntityName, "Customer");
  assert.equal(messages[0].matchedLabel, "Dana Levi");
});

/**
 * Round 1729: findMatchingRecord's own per-call SELECT * (one per
 * phone-bearing entity) is now built ONCE per upsert.messages batch and
 * reused for every message in it -- Baileys can and does deliver several
 * queued messages in one such batch. This proves both halves of that
 * change at the integration level: (1) each message in a multi-message
 * batch is still matched to the right, independent record, and (2) the
 * underlying db.prepare count for the batch is bounded (does not grow
 * with the number of messages), not just that the final matches look
 * right.
 */
test("a batch of several incoming messages from different senders reuses one candidate list, matching each to its own record without re-querying per message", async () => {
  const { manager, createdSockets, db } = setupManager();
  ensureProjectsTable(db);
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);
  insertRecord(db, project.id, project.spec.entities[0], { name: "Dana Levi", phone: "050-123-4567" });
  insertRecord(db, project.id, project.spec.entities[0], { name: "Noam Cohen", phone: "050-999-8888" });

  await manager.connect(project.id);
  createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  // Counts only the candidate-list query itself (listRecords' own `SELECT
  // * FROM "entity_<project>_<entity>" ORDER BY id DESC`, confirmed by
  // repository.ts) -- not insertWhatsAppMessage's own unrelated per-call
  // prepares (its INSERT, and its own retention-prune DELETE), which are
  // expected to scale with the number of messages regardless of this fix.
  let candidateSelectCalls = 0;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (sql.includes(`entity_${project.id}_Customer`)) candidateSelectCalls++;
    return originalPrepare(sql);
  }) as typeof db.prepare;

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { conversation: "היי, מתי התור שלי?" } },
      { key: { remoteJid: "972509998888@s.whatsapp.net", fromMe: false }, message: { conversation: "אפשר לשנות שעה?" } },
    ],
  });

  db.prepare = originalPrepare;

  assert.equal(candidateSelectCalls, 1, "the candidate list's SELECT must be issued once for the whole batch, not once per message");

  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  const byBody = new Map(messages.map((m) => [m.body, m]));
  assert.equal(byBody.get("היי, מתי התור שלי?")?.matchedLabel, "Dana Levi");
  assert.equal(byBody.get("אפשר לשנות שעה?")?.matchedLabel, "Noam Cohen");
});

test("an incoming message is skipped when it is from the linked device itself or from a group chat", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: true }, message: { conversation: "own outgoing message" } },
      { key: { remoteJid: "123456789@g.us", fromMe: false }, message: { conversation: "group chatter" } },
    ],
  });

  assert.equal(listWhatsAppMessages(db, project.id).messages.length, 0);
});

/**
 * Round 1612: Baileys emits a structurally separate "call" socket event
 * (never a `messages.upsert` entry) for an incoming WhatsApp call to the
 * linked number -- before this round, nothing in this manager ever
 * subscribed to it, so a customer who called the business instead of
 * texting it left zero trace anywhere in the app. A missed call (declined
 * or unanswered) should log into the exact same WhatsApp message log an
 * incoming text does, matched to the same customer record by phone number.
 */
test("an incoming call that goes unanswered (rejected or timed out) is logged as a missed call, matched to the right customer record", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);
  insertRecord(db, project.id, project.spec.entities[0], { name: "Dana Levi", phone: "050-123-4567" });

  await manager.connect(project.id);
  createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitCall([{ from: "972501234567@s.whatsapp.net", status: "reject" }]);
  createdSockets[0].emitCall([{ from: "972501234567@s.whatsapp.net", status: "timeout", isVideo: true }]);

  // listWhatsAppMessages returns newest-first (see its own doc comment), so
  // the second call emitted above -- the video one -- is messages[0].
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].direction, "in");
  assert.equal(messages[0].body, "[Missed video call]");
  assert.equal(messages[0].matchedEntityName, "Customer");
  assert.equal(messages[0].matchedLabel, "Dana Levi");
  assert.equal(messages[1].body, "[Missed call]");
});

test("an incoming call is NOT logged while it is still ringing, once it's answered, or when it's a group call", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitCall([{ from: "972501234567@s.whatsapp.net", status: "offer" }]);
  createdSockets[0].emitCall([{ from: "972501234567@s.whatsapp.net", status: "ringing" }]);
  createdSockets[0].emitCall([{ from: "972501234567@s.whatsapp.net", status: "accept" }]);
  createdSockets[0].emitCall([{ from: "123456789@g.us", status: "reject", isGroup: true }]);

  assert.equal(listWhatsAppMessages(db, project.id).messages.length, 0);
});

/**
 * Regression test for a real round-743 Explore survey finding: Baileys
 * relays a connected account's own contacts' WhatsApp Status/Story updates
 * through this exact same messages.upsert/"notify" event stream, with
 * fromMe: false and remoteJid "status@broadcast" (a broadcast list uses
 * "<id>@broadcast" the same way) -- nothing else in the handler
 * incidentally excludes them, since a plain-text Status update carries
 * the identical conversation/extendedTextMessage shape a real chat
 * message does. Before this fix, every Status post from the owner's own
 * contacts got logged as a real incoming message from a customer
 * literally named "status" (remoteJid.split("@")[0]) that could never
 * match a real record -- permanent noise in the one panel this feature
 * exists to keep reliable, and far more frequent in practice than most
 * individual real chat messages for a typical small business.
 */
test("an incoming message is skipped when it is a WhatsApp Status update or broadcast-list message, not a real chat message", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "status@broadcast", fromMe: false }, message: { conversation: "my status update" } },
      { key: { remoteJid: "123456789@broadcast", fromMe: false }, message: { extendedTextMessage: { text: "broadcast list message" } } },
    ],
  });

  assert.equal(listWhatsAppMessages(db, project.id).messages.length, 0);
});

/**
 * Round 1164: WhatsApp Channels ("newsletters") relay their posts through
 * this exact same messages.upsert/"notify" stream, with fromMe: false and
 * remoteJid "<id>@newsletter" -- confirmed directly against the installed
 * Baileys library's own isJidNewsletter/decodeMessageNode handling of the
 * "newsletter" msgType, the same way the existing "@broadcast" exclusion
 * above was confirmed. A business owner who follows any WhatsApp Channel
 * (actively promoted by WhatsApp itself) would otherwise have every
 * channel post logged as an unmatched incoming customer message, the
 * identical "permanent noise" problem the "@broadcast" fix already solved
 * for Status/broadcast-list messages, just for a sibling JID domain that
 * fix never covered.
 */
test("an incoming message is skipped when it is from a WhatsApp Channel (newsletter), not a real chat message", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [{ key: { remoteJid: "120363012345678901@newsletter", fromMe: false }, message: { conversation: "channel broadcast post" } }],
  });

  assert.equal(listWhatsAppMessages(db, project.id).messages.length, 0);
});

/**
 * Round 1164: a real Explore survey, verified directly against the
 * installed @whiskeysockets/baileys library's own source (WABinary's
 * isLidUser/jid-utils.js, Utils/decode-wa-message.js's decodeMessageNode,
 * Signal/lid-mapping.js's getPNForLID), found that WhatsApp's privacy-mode
 * "LID" sender addressing was never resolved to a real phone number: a
 * genuine inbound 1:1 DM can carry remoteJid "<opaque-id>@lid" instead of
 * "<phone>@s.whatsapp.net" (Baileys' own decoder treats this as a normal
 * chat-message case, not an edge case), and before this fix
 * remoteJid.split("@")[0] would feed that opaque LID straight into
 * findMatchingRecord as if it were a phone number -- breaking this
 * feature's entire "auto-match inbound WhatsApp to a customer record"
 * purpose for exactly the customers who've enabled WhatsApp's own
 * phone-number privacy protection. Covers all three resolution paths: (1)
 * key.remoteJidAlt present (the real-number JID WhatsApp's own server
 * attaches to the message when available) is preferred, with no mapping
 * lookup needed; (2) remoteJidAlt absent, resolved via the async
 * signalRepository.lidMapping.getPNForLID() Baileys itself exposes; (3)
 * neither resolves (e.g. the very first message from a brand-new LID
 * contact), falling back to today's raw-LID-as-"from" behavior rather than
 * dropping the message outright.
 */
test("an incoming message from a WhatsApp privacy-mode 'LID' sender is matched by the sender's real phone number, resolved via remoteJidAlt or the async LID-to-phone-number lookup", async () => {
  const { manager, createdSockets, db } = setupManager({
    getPNForLID: async (lid) => (lid === "987654321098765@lid" ? "972507654321@s.whatsapp.net" : null),
  });
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);
  insertRecord(db, project.id, project.spec.entities[0], { name: "Dana Levi", phone: "050-123-4567" });
  insertRecord(db, project.id, project.spec.entities[0], { name: "Yossi Cohen", phone: "050-765-4321" });

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  // Path 1: remoteJidAlt is present -- used directly, no lidMapping lookup needed.
  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      {
        key: { remoteJid: "123456789012345@lid", remoteJidAlt: "972501234567@s.whatsapp.net", fromMe: false },
        message: { conversation: "from remoteJidAlt" },
      },
    ],
  });

  // Path 2: no remoteJidAlt, resolved via the async lidMapping.getPNForLID lookup.
  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [{ key: { remoteJid: "987654321098765@lid", fromMe: false }, message: { conversation: "from lidMapping lookup" } }],
  });
  // handleIncomingMessages is fired-and-forgotten by the manager; the LID
  // path above introduces a genuine async boundary (the lidMapping await)
  // that path 1 above and every pre-existing synchronous test here don't,
  // so this one yields a tick before asserting.
  await new Promise((resolve) => setImmediate(resolve));

  // Path 3: neither resolves -- falls back to the raw LID digits (still
  // logged, just unmatched) instead of being dropped.
  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [{ key: { remoteJid: "111222333444555@lid", fromMe: false }, message: { conversation: "unresolvable LID" } }],
  });
  await new Promise((resolve) => setImmediate(resolve));

  // listWhatsAppMessages orders newest-first, the reverse of emission order above.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].fromNumber, "111222333444555");
  assert.equal(messages[0].matchedEntityName, null);
  assert.equal(messages[1].fromNumber, "972507654321");
  assert.equal(messages[1].matchedLabel, "Yossi Cohen");
  assert.equal(messages[2].fromNumber, "972501234567");
  assert.equal(messages[2].matchedLabel, "Dana Levi");
});

/**
 * Round 785: a photo/video/voice-note/document/sticker is shaped
 * completely differently from a plain text message (no conversation or
 * extendedTextMessage at all, only a type-specific key with its own
 * optional caption) -- before this fix, the plain text lookup returned
 * undefined for every one of these and the whole message was silently
 * dropped, with no row ever inserted and nothing telling the business
 * owner a message had even arrived.
 */
test("an incoming photo, video, voice note, document, and sticker are each logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { imageMessage: { caption: "המוצר הגיע שבור" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { imageMessage: {} } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { videoMessage: {} } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { audioMessage: { ptt: true } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { audioMessage: { ptt: false } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { documentMessage: { fileName: "invoice.pdf" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { stickerMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first (see its own doc comment), the
  // reverse of the emission order above.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 7);
  assert.equal(messages[0].body, "[Sticker]");
  assert.equal(messages[1].body, "[Document: invoice.pdf]");
  assert.equal(messages[2].body, "[Audio]");
  assert.equal(messages[3].body, "[Voice note]");
  assert.equal(messages[4].body, "[Video]");
  assert.equal(messages[5].body, "[Photo]");
  assert.equal(messages[6].body, "[Photo] המוצר הגיע שבור");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1035: a shared location pin and a shared contact card -- both
 * previously dropped with zero trace (round 785's own doc comment left
 * them unverified) -- are now logged with a descriptive placeholder, the
 * same convention round 785 already established for photo/video/voice
 * note/document/sticker. A location's own `name`/`address` (when the
 * sender attached one) is shown; a bare pin with neither still gets a
 * plain "[Location]" rather than printing raw, meaningless lat/long
 * numbers. A contact's `displayName` is shown when present, with a plain
 * "[Contact]" fallback for a vcard with no display name set.
 */
test("an incoming location pin (with and without a name/address) and a shared contact card are each logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { locationMessage: { name: "חנות ראשית", address: "דיזנגוף 1, תל אביב" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { locationMessage: { address: "דיזנגוף 1, תל אביב" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { locationMessage: { degreesLatitude: 32.08, degreesLongitude: 34.78 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { contactMessage: { displayName: "דנה לוי" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { contactMessage: { vcard: "BEGIN:VCARD..." } } },
    ],
  });

  // listWhatsAppMessages orders newest-first (see its own doc comment), the
  // reverse of the emission order above.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].body, "[Contact]", "a vcard with no displayName must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[Contact: דנה לוי]");
  assert.equal(messages[2].body, "[Location]", "a bare pin with neither name nor address must fall back to a plain placeholder, never raw lat/long numbers");
  assert.equal(messages[3].body, "[Location] דיזנגוף 1, תל אביב", "address must be used when name is absent");
  assert.equal(messages[4].body, "[Location] חנות ראשית", "name must be preferred over address when both are present");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1106: sharing TWO OR MORE contacts in one tap (WhatsApp's own
 * "select multiple -> Send" flow) -- previously dropped with zero trace,
 * the one sibling round 1035's own singular-contact fix missed, since
 * WhatsApp populates a distinct field (contactsArrayMessage) for this
 * case, never contactMessage. Confirms the real contact count is shown
 * when present, with a plain "[Contacts]" fallback when it isn't.
 */
test("sharing multiple contacts at once is logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { contactsArrayMessage: { contacts: [{ displayName: "דנה לוי" }, { displayName: "יוסי כהן" }, { displayName: "מיכל אברהם" }] } },
      },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { contactsArrayMessage: {} } },
    ],
  });

  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "[Contacts]", "an empty/malformed contacts array must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[3 Contacts]", "the real contact count must be shown when present");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1051: an incoming WhatsApp poll -- previously dropped with zero
 * trace, the exact gap round 1035's own doc comment explicitly left open
 * -- is now logged with a descriptive placeholder showing the poll's own
 * question text, the same convention established for location/contact.
 * Covers all three client-version fields Baileys may populate
 * (pollCreationMessage/V2/V3), plus a poll with no name at all (shouldn't
 * happen in practice, but mirrors the file's other placeholder fallbacks).
 */
test("an incoming WhatsApp poll (across client-version field variants, and with no name at all) is logged with its question text instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollCreationMessage: { name: "איזה יום מתאים?" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollCreationMessageV2: { name: "Which day works?" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollCreationMessageV3: { name: "Pick a slot" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollCreationMessageV5: { name: "V5 poll" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollCreationMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].body, "[Poll]", "a poll with no name at all must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[Poll] V5 poll");
  assert.equal(messages[2].body, "[Poll] Pick a slot");
  assert.equal(messages[3].body, "[Poll] Which day works?");
  assert.equal(messages[4].body, "[Poll] איזה יום מתאים?");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1449: an incoming WhatsApp poll VOTE (tapping an option on a poll
 * someone already created) -- previously dropped with zero trace, the one
 * remaining gap in round 1051's own poll handling, which only covered poll
 * *creation* -- is now logged with a generic placeholder. The vote's own
 * encrypted payload still can't be decoded here (same as round 1051's doc
 * comment already noted), so this only proves a vote arrived at all.
 */
test("an incoming WhatsApp poll vote is logged with a generic placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [{ key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollUpdateMessage: {} } }],
  });

  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "[Poll vote]");
  assert.equal(messages[0].direction, "in");
});

/**
 * Round 1508: a poll being closed/finalized (the creator taps "Stop this
 * poll") -- previously dropped with zero trace, the one remaining gap in
 * round 1051's own poll handling, which only covered creation (and round
 * 1449's own vote handling) -- is now logged with a placeholder showing
 * the poll's own question text, the exact same convention round 1051
 * established for poll creation. Covers both client-version field
 * variants Baileys may populate (pollResultSnapshotMessage/V3), plus a
 * closed poll with no name at all.
 */
test("an incoming WhatsApp poll-closed snapshot is logged with its question text instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollResultSnapshotMessage: { name: "איזה יום מתאים?" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollResultSnapshotMessageV3: { name: "Which day works?" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pollResultSnapshotMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].body, "[Poll closed]", "a closed poll with no name at all must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[Poll closed] Which day works?");
  assert.equal(messages[2].body, "[Poll closed] איזה יום מתאים?");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1509: an incoming WhatsApp buttonsMessage/listMessage -- the
 * "offer" half of the buttonsResponseMessage/listResponseMessage pair this
 * file already handled -- is now logged with a placeholder instead of
 * being silently dropped. These are WhatsApp's own interactive "pick one
 * of these buttons"/"pick from this list" messages, typically sent by
 * another business's own WhatsApp Business number. Covers a populated
 * buttonsMessage, a listMessage with only a description (no title), and a
 * listMessage with neither, which must still fall back to a placeholder
 * rather than printing nothing or throwing.
 */
test("an incoming WhatsApp buttons/list offer message is logged with a placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { buttonsMessage: { contentText: "Pick an option" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { listMessage: { description: "Choose a time slot" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { listMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].body, "[List Options]", "a listMessage with neither title nor description must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[List Options] Choose a time slot");
  assert.equal(messages[2].body, "[Buttons] Pick an option");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1515: an incoming WhatsApp templateMessage/interactiveMessage --
 * the "offer" halves round 1509's own survey missed, of the
 * templateButtonReplyMessage/interactiveResponseMessage pair this file
 * already handled -- is now logged with its text instead of being
 * silently dropped. A templateMessage is a WhatsApp Business "template"
 * notification (e.g. an appointment reminder); an interactiveMessage is
 * the offer half of a catalog/collection/native-flow interactive message.
 * Covers a populated templateMessage and interactiveMessage.
 */
test("an incoming WhatsApp template/interactive offer message is logged with its text instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { templateMessage: { hydratedTemplate: { hydratedContentText: "Your appointment is tomorrow at 10am" } } },
      },
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { interactiveMessage: { body: { text: "Browse our new collection" } } },
      },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "[Interactive] Browse our new collection");
  assert.equal(messages[1].body, "[Template] Your appointment is tomorrow at 10am");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1088: an incoming WhatsApp emoji reaction (long-press a message,
 * tap an emoji) -- previously dropped with zero trace, the same gap round
 * 1051's own doc comment left open for "every other still-unrecognized
 * message kind" -- is now logged with a descriptive placeholder showing
 * the reacted emoji, the same convention established for location/
 * contact/polls. Covers both a real reaction and a removed one (Baileys
 * sends an empty `text` when a reaction is taken back).
 */
test("an incoming WhatsApp emoji reaction (and its removal) is logged with the reacted emoji instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { reactionMessage: { text: "👍" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { reactionMessage: { text: "" } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "[Reaction removed]", "an empty text (a taken-back reaction) must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[Reaction] 👍");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 785 (narrowed by rounds 1035 and 1051): a genuinely unrecognized
 * message shape is deliberately NOT guessed at -- it's still skipped
 * exactly as before this fix, the same as a message with no body at all.
 */
/**
 * Round 1121: a "View once" photo/video -- WhatsApp's own one-tap toggle on
 * the camera UI, ordinary usage (e.g. a payment-proof photo), not an edge
 * case -- was previously dropped with zero trace. Baileys wraps the real
 * imageMessage/videoMessage one level down inside viewOnceMessage/
 * viewOnceMessageV2 instead of populating imageMessage/videoMessage
 * directly, so the existing branches never matched. Covers both wrapper
 * field versions, an inner type that already has its own placeholder
 * (photo with caption, video without), and no match at all (an empty
 * wrapper) to confirm it falls back to a plain "[View once]" rather than
 * throwing or printing nothing.
 */
test("an incoming WhatsApp 'View once' photo/video (across both wrapper field versions) is logged with its inner placeholder prefixed with [View once] instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { viewOnceMessageV2: { message: { imageMessage: { caption: "אישור תשלום" } } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { viewOnceMessage: { message: { videoMessage: {} } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { viewOnceMessageV2: { message: {} } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].body, "[View once]", "an empty inner message must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[View once] [Video]", "the older viewOnceMessage field must be unwrapped too, not just viewOnceMessageV2");
  assert.equal(messages[2].body, "[View once] [Photo] אישור תשלום", "the inner photo's own caption must still come through");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1139: deleting or editing a message you already sent (long-press ->
 * "Delete"/"Edit") delivers as a `protocolMessage` -- previously dropped
 * with zero trace, the same gap every other still-unrecognized message
 * kind fell into before its own fix. REVOKE (a delete) has no recoverable
 * content at all, so it gets the same "[Reaction removed]"-style plain
 * placeholder; MESSAGE_EDIT carries the edit's full replacement content in
 * `editedMessage`, reusing the View once recursive-inner-describe
 * convention so an edited photo/location/etc. still shows its own real
 * placeholder, not a bare "[Edited]".
 */
test("an incoming WhatsApp message deletion or edit is logged with a placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { protocolMessage: { type: 0 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { protocolMessage: { type: 14, editedMessage: { conversation: "actually, 3 units please" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { protocolMessage: { type: 14 } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].body, "[Edited]", "an edit with no recoverable editedMessage content must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[Edited] actually, 3 units please", "a genuine text edit's own new content must still come through");
  assert.equal(messages[2].body, "[Message deleted]", "a revoke (delete) has no recoverable content, so only the plain placeholder is expected");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1507: WhatsApp's own "Pin message"/"Unpin message" chat action
 * (long-press a message -> Pin/Unpin) delivers as a `pinInChatMessage`,
 * a plaintext int enum (proto.Message.PinInChatMessage.Type:
 * UNKNOWN_TYPE=0, PIN_FOR_ALL=1, UNPIN_FOR_ALL=2) -- previously dropped
 * with zero trace, the same gap round 1139 already fixed for
 * protocolMessage's delete/edit actions.
 */
test("an incoming WhatsApp pin/unpin message action is logged with a placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pinInChatMessage: { type: 1 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pinInChatMessage: { type: 2 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { pinInChatMessage: { type: 0 } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2, "the UNKNOWN_TYPE (0) pin action has no recoverable meaning and must stay genuinely dropped, not guessed at");
  assert.equal(messages[0].body, "[Message unpinned]");
  assert.equal(messages[1].body, "[Message pinned]");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1142: a chat with WhatsApp's own "Disappearing messages" toggle on
 * (an ordinary, user-controlled, widely-used per-chat setting) wraps EVERY
 * message in that chat inside an `ephemeralMessage` envelope, of any
 * shape -- not just one still-unrecognized type like every prior round in
 * this family, but the entire conversation, silently, with zero trace.
 * Covers a plain text message, a photo (confirming the unwrap is generic,
 * not text-only), and a never-answered empty wrapper (falls back to null
 * -- genuinely skipped, not guessed at).
 */
test("an incoming WhatsApp message from a disappearing-messages chat is logged normally, instead of the entire chat being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { ephemeralMessage: { message: { conversation: "מתי אתם פתוחים?" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { ephemeralMessage: { message: { imageMessage: { caption: "תמונה של המוצר" } } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { ephemeralMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2, "the empty ephemeralMessage wrapper (no recoverable content) must still be genuinely skipped, not guessed at or logged as a stray row");
  assert.equal(messages[0].body, "[Photo] תמונה של המוצר", "a photo wrapped in ephemeralMessage must unwrap to its own real placeholder, not just a text message");
  assert.equal(messages[1].body, "מתי אתם פתוחים?", "a plain text message wrapped in ephemeralMessage must unwrap transparently, with no added placeholder prefix");
  for (const m of messages) assert.equal(m.direction, "in", "every unwrapped row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1152: a "View once" *video* sent from a newer WhatsApp client uses
 * `viewOnceMessageV2Extension` instead of `viewOnceMessage`/
 * `viewOnceMessageV2` -- confirmed against the installed
 * @whiskeysockets/baileys library's own normalizeMessageContent, which
 * groups all three as the same kind of envelope. Likewise, a document sent
 * with a caption from a newer client arrives wrapped in
 * `documentWithCaptionMessage` instead of populating `documentMessage`
 * directly -- the same fully transparent wrapper `ephemeralMessage` already
 * gets, confirmed by the library grouping it there too. Both previously
 * fell through every branch and were silently dropped with zero trace, the
 * same gap every other still-unrecognized shape in this family fell into
 * before its own fix.
 */
test("an incoming WhatsApp 'View once' video via its newer wrapper field, and a document-with-caption via its own wrapper field, are both logged instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { viewOnceMessageV2Extension: { message: { videoMessage: { caption: "הדגמה" } } } } },
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "חוזה.pdf", caption: "לחתימה" } } } },
      },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "[Document: חוזה.pdf] לחתימה", "documentWithCaptionMessage must unwrap transparently to its inner documentMessage's own real placeholder, with no added prefix");
  assert.equal(messages[1].body, "[View once] [Video] הדגמה", "viewOnceMessageV2Extension must be checked alongside viewOnceMessage/viewOnceMessageV2, not silently dropped");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1445: `associatedChildMessage`, `groupStatusMessage`, and
 * `groupStatusMessageV2` are three more fully transparent wrappers this
 * file had never ported -- confirmed against the installed
 * @whiskeysockets/baileys library's own normalizeMessageContent
 * (lib/Utils/messages.js), whose getFutureProofMessage helper lists all
 * nine wrapper fields (ephemeralMessage/viewOnceMessage/
 * documentWithCaptionMessage/viewOnceMessageV2/
 * viewOnceMessageV2Extension/editedMessage/associatedChildMessage/
 * groupStatusMessage/groupStatusMessageV2) in the exact same bucket; this
 * file had only ever ported six of the nine. A message carrying any of
 * these three previously fell through every branch and was silently
 * dropped with zero trace, the same gap every other still-unrecognized
 * shape in this family fell into before its own fix.
 */
test("an incoming WhatsApp message wrapped in associatedChildMessage, groupStatusMessage, or groupStatusMessageV2 is logged instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { associatedChildMessage: { message: { conversation: "הודעה מקושרת" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { groupStatusMessage: { message: { conversation: "סטטוס קבוצה" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { groupStatusMessageV2: { message: { conversation: "סטטוס קבוצה V2" } } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].body, "סטטוס קבוצה V2", "groupStatusMessageV2 must unwrap transparently, with no added placeholder prefix");
  assert.equal(messages[1].body, "סטטוס קבוצה", "groupStatusMessage must unwrap transparently, with no added placeholder prefix");
  assert.equal(messages[2].body, "הודעה מקושרת", "associatedChildMessage must unwrap transparently, with no added placeholder prefix");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1121: a live-location share (WhatsApp's continuous-sharing mode,
 * started from the attachment picker) is a distinct field from the
 * already-handled locationMessage (a single pinned location, round 1035)
 * and was previously dropped with zero trace the same way.
 */
test("an incoming WhatsApp live-location share is logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { liveLocationMessage: { caption: "בדרך אליכם" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { liveLocationMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "[Live location]", "a live-location share with no caption must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[Live location] בדרך אליכם");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1306: WhatsApp's own interactive-reply message kinds -- a customer
 * tapping a quick-reply button (buttonsResponseMessage/
 * templateButtonReplyMessage), picking an item from a list menu
 * (listResponseMessage), or tapping a newer "native flow" button
 * (interactiveResponseMessage) -- were previously dropped with zero trace,
 * the same silent-vanish gap every prior round in this message-type-
 * coverage family (1035/1051/1088/1106/1121/1139/1142/1152) fixed for a
 * different message shape. All four fields are plaintext, exactly like
 * the already-handled pollCreationMessage/reactionMessage.
 */
test("incoming WhatsApp button taps and list selections are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { buttonsResponseMessage: { selectedButtonId: "yes", selectedDisplayText: "כן" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { buttonsResponseMessage: { selectedButtonId: "yes" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { listResponseMessage: { title: "פיצה משפחתית", singleSelectReply: { selectedRowId: "pizza_family" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { listResponseMessage: { singleSelectReply: { selectedRowId: "pizza_family" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { templateButtonReplyMessage: { selectedId: "confirm", selectedDisplayText: "אשר" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { interactiveResponseMessage: { body: { text: "תור ליום שני" } } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 6);
  assert.equal(messages[0].body, "[Button] תור ליום שני");
  assert.equal(messages[1].body, "[Button] אשר");
  assert.equal(messages[2].body, "[List] pizza_family", "a list reply with no title/description must fall back to the selected row id, not print nothing or throw");
  assert.equal(messages[3].body, "[List] פיצה משפחתית", "the real list item title must be shown when present");
  assert.equal(messages[4].body, "[Button] yes", "a button reply with no display text must fall back to the selected button id, not print nothing or throw");
  assert.equal(messages[5].body, "[Button] כן", "the real button display text must be shown when present");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1307: a sibling wrapper to the already-handled nested
 * `protocolMessage.editedMessage` shape (round 1139) -- Baileys' own
 * `normalizeMessageContent` (lib/Utils/messages.js's `getFutureProofMessage`
 * helper) groups a top-level `message.editedMessage` field in the exact
 * same transparent-envelope bucket as `ephemeralMessage`/
 * `documentWithCaptionMessage`, both already unwrapped by this function --
 * but this third sibling was never ported. Previously dropped with zero
 * trace, the same gap every prior round in this family fixed for a
 * different wrapper shape.
 */
test("an incoming WhatsApp message delivered via the top-level editedMessage wrapper is logged with its new content instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { editedMessage: { message: { conversation: "actually, 3 units please" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { editedMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "[Edited]", "a top-level editedMessage wrapper with no recoverable content must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[1].body, "[Edited] actually, 3 units please", "a genuine text edit's own new content must still come through");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

test("an incoming message of a completely unrecognized shape is still skipped, not guessed at", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: {} },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false } },
    ],
  });

  assert.equal(listWhatsAppMessages(db, project.id).messages.length, 0);
});

test("disconnect logs out the real socket, clears the live session, and keeps the last known phone number in the DB", async () => {
  const { manager, createdSockets, db } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  await manager.disconnect("proj1");

  assert.ok(createdSockets[0].isLoggedOut());
  const state = manager.getStatus("proj1");
  assert.equal(state.status, "disconnected");
  const stored = getWhatsAppConnection(db, "proj1");
  assert.equal(stored?.phoneNumber, "972501234567");
  assert.equal(stored?.connectedAt, null);
});

test("connect() waits for a concurrent disconnect()'s auth-dir cleanup to finish before creating a new socket in the same directory", async () => {
  // disconnect() deletes the session from the map immediately (so
  // getStatus() reports "disconnected" right away) but only removes the
  // auth dir from disk asynchronously afterward. A connect() that arrives
  // in that window must not start useMultiFileAuthState() on a directory
  // still being deleted -- confirmed here by holding the (injected) auth-dir
  // removal open and checking createSocket is never called until it resolves.
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  let resolveRemoveAuthDir!: () => void;
  let createSocketCalls = 0;
  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-test-sessions-cleanup",
    createSocket: async () => {
      createSocketCalls++;
      return { sock: createFakeSocket().sock, saveCreds: async () => {} };
    },
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
    removeAuthDir: () => new Promise((resolve) => { resolveRemoveAuthDir = resolve; }),
  });

  await manager.connect("proj1");
  const disconnectPromise = manager.disconnect("proj1");
  // Let disconnect() run past its own awaited logout() call and reach the
  // point where it deletes the session and starts the (held-open) cleanup.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getStatus("proj1").status, "disconnected", "status must flip before cleanup finishes");

  const connectPromise = manager.connect("proj1");
  // Give the new connect() a real turn of the event loop -- if it weren't
  // waiting on the cleanup, createSocket would already have been called again.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createSocketCalls, 1, "connect() must not create a second socket while cleanup is still pending");

  resolveRemoveAuthDir();
  await disconnectPromise;
  await connectPromise;
  assert.equal(createSocketCalls, 2, "connect() must proceed once cleanup has actually finished");
});

/**
 * Round 990: the test just above only ever exercises ONE connect() racing
 * ONE disconnect()'s own pending cleanup -- that single caller correctly
 * awaits pendingCleanup and then proceeds safely, since nothing else
 * touched the session map while it waited. Before this round's fix, a
 * SECOND connect() landing in the exact same cleanup window read `existing`
 * as undefined too (it's read once, before the pendingCleanup await, and
 * never re-checked after resuming), passed the same guard, and awaited the
 * identical pendingCleanup promise -- so when it resolved, BOTH calls'
 * continuations went on to build their own fresh session and call
 * createSocket() concurrently against the same auth directory, before
 * either one's own identity check could react. Two real project
 * collaborators clicking "Connect" near-simultaneously shortly after
 * either disconnects reaches this exact window -- the frontend's own
 * per-tab disable state only prevents one tab from firing two connects
 * itself, not two different callers racing the same backend manager.
 */
test("two connect() calls landing in the same disconnect-cleanup window join a single connect attempt, instead of both calling createSocket against the same auth directory", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  let resolveRemoveAuthDir!: () => void;
  let createSocketCalls = 0;
  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-test-sessions-double-connect",
    createSocket: async () => {
      createSocketCalls++;
      return { sock: createFakeSocket().sock, saveCreds: async () => {} };
    },
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
    removeAuthDir: () => new Promise((resolve) => { resolveRemoveAuthDir = resolve; }),
  });

  await manager.connect("proj1");
  assert.equal(createSocketCalls, 1, "sanity check: the initial connect must have created one socket");
  void manager.disconnect("proj1");
  // Let disconnect() run past its own logout() call and reach the point
  // where it deletes the session and starts the (held-open) cleanup.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getStatus("proj1").status, "disconnected", "status must flip before cleanup finishes");

  // Two SEPARATE callers both arrive while the exact same cleanup is still pending.
  const connectA = manager.connect("proj1");
  const connectB = manager.connect("proj1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createSocketCalls, 1, "neither connect() call must have created a socket yet -- cleanup is still pending");

  resolveRemoveAuthDir();
  await Promise.all([connectA, connectB]);

  assert.equal(
    createSocketCalls,
    2,
    "exactly one new socket must be created for this pair of concurrent calls, not two racing createSocket() calls against the same auth directory",
  );
});

test("a DB error inside a connection.update handler is caught, recorded on the session, and never escapes as an unhandled promise rejection", async () => {
  const { manager, createdSockets, db } = setupManager();
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    await manager.connect("proj1");
    createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
    db.close(); // any further write (recordWhatsAppConnected) will now throw
    createdSockets[0].emitConnectionUpdate({ connection: "open" });

    // Let the fire-and-forget async handler run to completion before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], "a handler's DB error must never become an unhandled promise rejection");
    const state = manager.getStatus("proj1");
    assert.match(state.error ?? "", /database is not open/);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

test("connect() logs out the real socket immediately if the session was replaced (e.g. by a concurrent disconnect) while createSocket() was still in flight", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const fake = createFakeSocket();
  let resolveCreateSocket!: (value: { sock: WhatsAppSocket; saveCreds: () => Promise<void> }) => void;
  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-test-sessions-race",
    // Never resolves until the test says so, giving a real window for a
    // concurrent disconnect() to run while this socket is still being
    // created -- the same timing a slow real Baileys/`useMultiFileAuthState`
    // call could hit in production.
    createSocket: () => new Promise((resolve) => { resolveCreateSocket = resolve; }),
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
  });

  const connectPromise = manager.connect("proj1");
  await manager.disconnect("proj1");

  resolveCreateSocket({ sock: fake.sock, saveCreds: async () => {} });
  await connectPromise;

  assert.ok(
    fake.isLoggedOut(),
    "the orphaned socket must be logged out -- otherwise it stays linked to the real WhatsApp account with nothing left able to close it",
  );
  assert.equal(manager.getStatus("proj1").status, "disconnected");
});

/**
 * Regression test for a real race found by round 379's Explore survey:
 * the opposite direction from the "connect() waits for a concurrent
 * disconnect()'s auth-dir cleanup" test above. That one defends a
 * connect() landing while a PRIOR disconnect()'s own cleanup is still
 * removing the auth dir. Nothing defended the reverse: a disconnect()
 * landing while a connect() is still inside its OWN createSocket() call
 * -- exactly when useMultiFileAuthState reads/writes that same directory
 * -- used to start removing it immediately, racing those file operations.
 * Confirms removeAuthDir is now deferred until the in-flight connect()
 * attempt has genuinely finished, while disconnect() itself still returns
 * promptly (its own synchronous session.delete() already made
 * getStatus() report "disconnected" -- that must never depend on how
 * long the OTHER, in-flight connect() attempt takes).
 */
test("disconnect() waits for a concurrent connect()'s still-in-flight createSocket() call before removing the auth dir from disk", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const fake = createFakeSocket();
  let resolveCreateSocket!: (value: { sock: WhatsAppSocket; saveCreds: () => Promise<void> }) => void;
  let removeAuthDirCalls = 0;
  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-test-sessions-disconnect-race",
    createSocket: () => new Promise((resolve) => { resolveCreateSocket = resolve; }),
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
    removeAuthDir: async () => {
      removeAuthDirCalls++;
    },
  });

  const connectPromise = manager.connect("proj1");
  const disconnectPromise = manager.disconnect("proj1");

  await disconnectPromise;
  assert.equal(manager.getStatus("proj1").status, "disconnected", "disconnect() must still report disconnected right away");
  assert.equal(removeAuthDirCalls, 0, "removeAuthDir must not run while createSocket() is still in flight for this project");

  resolveCreateSocket({ sock: fake.sock, saveCreds: async () => {} });
  await connectPromise;
  // Give the now-unblocked cleanup chain a real turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(removeAuthDirCalls, 1, "removeAuthDir must run once the in-flight connect() attempt has actually finished");
});

test("a stale close event from a disconnected socket does not clobber a newer session created by a fresh connect()", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  const oldSocket = createdSockets[0];
  oldSocket.sock.user = { id: "972501234567:12@s.whatsapp.net" };
  oldSocket.emitConnectionUpdate({ connection: "open" });

  await manager.disconnect("proj1");
  await manager.connect("proj1");
  const newSocket = createdSockets[1];
  newSocket.sock.user = { id: "972500000001:1@s.whatsapp.net" };
  newSocket.emitConnectionUpdate({ connection: "open" });

  // The old socket's own "close" event arrives late over the wire, after
  // disconnect() already logged it out and after a brand new connection
  // has since been established -- a real, plausible timing.
  oldSocket.emitConnectionUpdate({ connection: "close" });

  const state = manager.getStatus("proj1");
  assert.equal(state.status, "connected");
  assert.equal(state.phoneNumber, "972500000001");
});

/**
 * Round 1379: a shared WhatsApp group invite, a product shared from the
 * business's own WhatsApp Catalog, and a real order placed through
 * WhatsApp Business's own built-in ordering flow were all previously
 * dropped with zero trace, the same silent-vanish gap every prior round in
 * this message-type-coverage family (1035/1051/1088/1106/1121/1139/1142/
 * 1152/1306) fixed for a different message shape. All three are plaintext
 * fields confirmed directly against the installed Baileys protobuf types.
 */
test("incoming WhatsApp group invites, catalog products, and orders are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { groupInviteMessage: { groupName: "לקוחות VIP" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { groupInviteMessage: {} } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { productMessage: { product: { title: "נעל ריצה" } } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { orderMessage: { orderTitle: "הזמנה #42" } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].body, "[Order] הזמנה #42");
  assert.equal(messages[1].body, "[Product] נעל ריצה");
  assert.equal(messages[2].body, "[Group Invite]", "a group invite with no groupName must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(messages[3].body, "[Group Invite] לקוחות VIP");
  for (const m of messages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1502: WhatsApp's native "Create Event" feature (the calendar/
 * event-creation action in a chat's own "+" menu) was previously dropped
 * with zero trace, the same silent-vanish gap every prior round in this
 * message-type-coverage family (1035/1051/1088/1106/1121/1139/1142/1152/
 * 1306/1379/1445/1449) fixed for a different message shape. eventMessage's
 * name/description/isCanceled fields are plaintext, confirmed directly
 * against the installed Baileys protobuf types (IEventMessage).
 */
test("incoming WhatsApp events (the chat's own calendar/event-creation action) are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { eventMessage: { name: "איסוף משלוח - שלישי 15:00" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { eventMessage: {} } },
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { eventMessage: { name: "פגישת ייעוץ", isCanceled: true } },
      },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: eventMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(eventMessages.length, 3);
  assert.equal(eventMessages[0].body, "[Event canceled] פגישת ייעוץ", "a canceled event must say so, not just show its name like a live one");
  assert.equal(eventMessages[1].body, "[Event]", "an event with no name must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(eventMessages[2].body, "[Event] איסוף משלוח - שלישי 15:00");
  for (const m of eventMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1606: the RSVP (Going/Not Going/Maybe) half of eventMessage just
 * above (round 1502) was previously dropped with zero trace, the same
 * silent-vanish gap every prior round in this message-type-coverage family
 * fixed for a different message shape. eventResponseMessage.response is a
 * plaintext int enum, confirmed directly against the installed Baileys
 * protobuf types (IEventResponseMessage/EventResponseType). Its genuinely-
 * encrypted sibling encEventResponseMessage carries only encPayload/encIv --
 * round 1600 surfaced it but deferred it for lacking this plaintext enum
 * precedent, which this round supplies.
 */
test("incoming WhatsApp event RSVPs (Going/Not Going/Maybe, and their encrypted sibling) are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { eventResponseMessage: { response: 1 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { eventResponseMessage: { response: 2 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { eventResponseMessage: { response: 3 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { eventResponseMessage: {} } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { encEventResponseMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: rsvpMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(rsvpMessages.length, 5);
  assert.equal(rsvpMessages[0].body, "[Event response]", "the genuinely-encrypted sibling can only detect presence, not the chosen response");
  assert.equal(rsvpMessages[1].body, "[Event response]", "an unrecognized/unset response enum must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(rsvpMessages[2].body, "[Event: Maybe]");
  assert.equal(rsvpMessages[3].body, "[Event: Not going]");
  assert.equal(rsvpMessages[4].body, "[Event: Going]");
  for (const m of rsvpMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1537: WhatsApp's native "Schedule a call" chat-menu action was
 * previously dropped with zero trace, the same silent-vanish gap round
 * 1502 fixed for eventMessage. ScheduledCallCreationMessage's title/
 * callType fields are plaintext, confirmed directly against the installed
 * Baileys protobuf (WAProto.proto: scheduledTimestampMs int64, callType
 * enum [UNKNOWN=0, VOICE=1, VIDEO=2], title plaintext string).
 */
test("incoming WhatsApp scheduled-call messages (the chat's own 'Schedule a call' action) are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { scheduledCallCreationMessage: { title: "שיחת תיאום", callType: 1 } },
      },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { scheduledCallCreationMessage: {} } },
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { scheduledCallCreationMessage: { title: "ראיון עבודה", callType: 2 } },
      },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: callMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(callMessages.length, 3);
  assert.equal(callMessages[0].body, "[Scheduled video call] ראיון עבודה", "callType VIDEO must be distinguished from a plain voice call");
  assert.equal(callMessages[1].body, "[Scheduled call]", "a scheduled call with no title must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(callMessages[2].body, "[Scheduled call] שיחת תיאום", "callType VOICE must use the plain (non-video) label");
  for (const m of callMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1569: the direct cancel-sibling of scheduledCallCreationMessage
 * (round 1537) -- canceling a pending scheduled call from the chat's own
 * scheduled-call UI was previously dropped with zero trace.
 * ScheduledCallEditMessage's editType is a plaintext int enum, confirmed
 * directly against the installed Baileys protobuf (WAProto.proto:
 * optional MessageKey key = 1; optional EditType editType = 2; enum
 * EditType { UNKNOWN = 0; CANCEL = 1; }).
 */
test("incoming WhatsApp scheduled-call-cancel messages are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { scheduledCallEditMessage: { editType: 1 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { scheduledCallEditMessage: { editType: 0 } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: editMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(editMessages.length, 1, "the UNKNOWN (0) editType has no recoverable meaning and must stay genuinely dropped, same as pinInChatMessage's own UNKNOWN_TYPE handling");
  assert.equal(editMessages[0].body, "[Scheduled call canceled]");
  assert.equal(editMessages[0].direction, "in", "the placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1570: WhatsApp's native "Keep"/"Undo Keep" chat action on a
 * view-once photo/video (tap Keep to save it past its single view)
 * delivers as `keepInChatMessage`, a plaintext int enum (proto.Message
 * .KeepInChatMessage.KeepType: UNKNOWN=0, KEEP_FOR_ALL=1,
 * UNDO_KEEP_FOR_ALL=2) -- confirmed directly against the installed
 * Baileys protobuf. Previously dropped with zero trace, same gap as
 * pinInChatMessage (round 1507) and scheduledCallEditMessage (round 1569).
 */
test("incoming WhatsApp keep/undo-keep (view-once) messages are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { keepInChatMessage: { keepType: 1 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { keepInChatMessage: { keepType: 2 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { keepInChatMessage: { keepType: 0 } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: keepMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(keepMessages.length, 2, "the UNKNOWN (0) keepType has no recoverable meaning and must stay genuinely dropped, same as pinInChatMessage's own UNKNOWN_TYPE handling");
  assert.equal(keepMessages[0].body, "[Un-kept photo/video]");
  assert.equal(keepMessages[1].body, "[Kept photo/video]");
  for (const m of keepMessages) assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1538: WhatsApp's native Pay feature ("Request Payment"/"Send
 * Payment") was previously dropped with zero trace, the same silent-vanish
 * gap round 1537 fixed for scheduledCallCreationMessage. requestPaymentMessage/
 * sendPaymentMessage's title/currency/amount/noteMessage fields are plaintext,
 * confirmed directly against the installed Baileys protobuf (WAProto.proto:
 * Money's value/currencyCode, RequestPaymentMessage's currencyCodeIso4217/
 * amount1000, both messages' noteMessage is itself a Message).
 */
test("incoming WhatsApp payment-request/payment-sent messages are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { requestPaymentMessage: { amount: { value: 50, currencyCode: "ILS" }, noteMessage: { conversation: "עבור הזמנה #42" } } },
      },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { requestPaymentMessage: {} } },
      {
        key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
        message: { sendPaymentMessage: { noteMessage: { conversation: "תודה!" } } },
      },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { sendPaymentMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: paymentMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(paymentMessages.length, 4);
  assert.equal(paymentMessages[0].body, "[Payment sent]", "a payment-sent message with no note must fall back to a plain placeholder, not print nothing or throw");
  assert.equal(paymentMessages[1].body, "[Payment sent] תודה!");
  assert.equal(paymentMessages[2].body, "[Payment request]", "a payment-request message with no amount/currency must fall back to a plain placeholder");
  assert.equal(paymentMessages[3].body, "[Payment request: 50 ILS] עבור הזמנה #42");
  for (const m of paymentMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1546: declinePaymentRequestMessage/cancelPaymentRequestMessage are
 * the direct reply-half siblings of requestPaymentMessage (round 1538) --
 * when either side taps Decline/Cancel on a pending payment request.
 * Confirmed directly against the installed Baileys protobuf (WAProto.proto:
 * both messages are just `optional MessageKey key = 1;`, no content beyond
 * presence, the same bar pollUpdateMessage's own "[Poll vote]" already met).
 */
test("incoming WhatsApp payment-request decline/cancel messages are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { declinePaymentRequestMessage: {} } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { cancelPaymentRequestMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: paymentMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(paymentMessages.length, 2);
  assert.equal(paymentMessages[0].body, "[Payment request canceled]");
  assert.equal(paymentMessages[1].body, "[Payment request declined]");
  for (const m of paymentMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1600: encReactionMessage is the separate, genuinely-encrypted
 * sibling of reactionMessage (round 1088) this file's own doc comment
 * already named but never actually handled. Confirmed directly against
 * the installed Baileys library itself: messages-send.js treats it as a
 * fully equivalent sibling of reactionMessage for message-type
 * classification, and reporting-utils.js groups it with pollUpdateMessage
 * (round 1449) in the same "modifies/reacts to an earlier message" bucket
 * -- its encPayload/encIv can't be recovered, but detecting that a
 * reaction arrived at all needs no decryption, the same bar
 * pollUpdateMessage/declinePaymentRequestMessage already met.
 */
test("an incoming WhatsApp encrypted emoji reaction (encReactionMessage) is logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [{ key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { encReactionMessage: {} } }],
  });

  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "[Reaction]");
  assert.equal(messages[0].direction, "in", "the placeholder row must still be a real, matched-against incoming message, not metadata");
});

/**
 * Round 1576: WhatsApp Business's native "Create/Send Invoice" chat action
 * produces invoiceMessage. Confirmed directly against the installed
 * Baileys protobuf (WAProto.proto: InvoiceMessage's `note` field is
 * plaintext; the rest is encrypted attachment media -- the same
 * "plaintext top-level field" shape requestPaymentMessage's own
 * noteMessage already met).
 */
test("incoming WhatsApp invoice messages are logged with their note instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { invoiceMessage: { note: "חשבונית עבור הזמנה #42" } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { invoiceMessage: {} } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: invoiceMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(invoiceMessages.length, 2);
  assert.equal(invoiceMessages[0].body, "[Invoice]");
  assert.equal(invoiceMessages[1].body, "[Invoice] חשבונית עבור הזמנה #42");
  for (const m of invoiceMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1581: WhatsApp's native multi-select "share several photos/videos
 * together" action sends one albumMessage header (expectedImageCount/
 * expectedVideoCount) alongside the individual imageMessage/videoMessage
 * items -- confirmed directly against the installed Baileys source that
 * this is a plain top-level Message field (not an IFutureProofMessage
 * wrapper) that Baileys' own send path actively builds and sends.
 */
test("incoming WhatsApp album header messages are logged with their item count instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { albumMessage: { expectedImageCount: 3, expectedVideoCount: 1 } } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { albumMessage: { expectedImageCount: 1 } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: albumMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(albumMessages.length, 2);
  assert.equal(albumMessages[0].body, "[Album] 1 item");
  assert.equal(albumMessages[1].body, "[Album] 4 items");
  for (const m of albumMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1582: WhatsApp Business's native "Request phone number" chat action
 * sends a requestPhoneNumberMessage, and the direct reply half (the other
 * party agreeing to share their number) is a protocolMessage whose type is
 * SHARE_PHONE_NUMBER (11) -- confirmed directly against the installed
 * Baileys source (not just its protobuf types) that both are actively
 * built and sent by generateWAMessageContent, not reserved/unused slots.
 */
test("incoming WhatsApp 'request phone number' / 'share phone number' messages are logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { requestPhoneNumberMessage: {} } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { protocolMessage: { type: 11 } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: phoneMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(phoneMessages.length, 2);
  assert.equal(phoneMessages[0].body, "[Phone number shared]");
  assert.equal(phoneMessages[1].body, "[Phone number requested]");
  for (const m of phoneMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});

/**
 * Round 1554: WhatsApp's "video note" (the circular, Instagram-style clip
 * sent by switching the compose bar's mic into video-recording mode) was
 * previously dropped with zero trace -- round 785 handled plain
 * `videoMessage` but never `ptvMessage`, its own undocumented sibling.
 * Confirmed directly against the installed Baileys protobuf
 * (WAProto/index.d.ts): `ptvMessage` is a plain top-level field of
 * `IMessage`, typed identically to `videoMessage` (`IVideoMessage`, same
 * `caption` field), never nested inside any wrapper.
 */
test("an incoming WhatsApp video note (ptvMessage) is logged with a descriptive placeholder instead of being silently dropped", async () => {
  const { manager, createdSockets, db } = setupManager();
  insertProject(db, project);
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  await manager.connect(project.id);
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  createdSockets[0].emitMessagesUpsert({
    type: "notify",
    messages: [
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { ptvMessage: {} } },
      { key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false }, message: { ptvMessage: { caption: "תגובה מהירה" } } },
    ],
  });

  // listWhatsAppMessages orders newest-first, the reverse of emission order.
  const { messages: videoNoteMessages } = listWhatsAppMessages(db, project.id);
  assert.equal(videoNoteMessages.length, 2);
  assert.equal(videoNoteMessages[0].body, "[Video note] תגובה מהירה");
  assert.equal(videoNoteMessages[1].body, "[Video note]", "a video note with no caption must fall back to a plain placeholder, not print nothing or throw");
  for (const m of videoNoteMessages) {
    assert.equal(m.direction, "in", "every placeholder row must still be a real, matched-against incoming message, not metadata");
  }
});
