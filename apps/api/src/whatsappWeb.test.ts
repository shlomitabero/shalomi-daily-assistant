import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, ensureProjectsTable, ensureWhatsAppConnectionsTable, ensureWhatsAppMessagesTable, getWhatsAppConnection, insertProject, insertRecord, listWhatsAppMessages, markProjectBuilt, openDatabase } from "@forge/db";
import { WhatsAppWebManager, type BaileysConnectionUpdate, type BaileysMessagesUpsert, type WhatsAppSocket } from "./whatsappWeb.js";

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
function createFakeSocket() {
  const handlers: {
    creds?: () => void;
    connectionUpdate?: (u: BaileysConnectionUpdate) => void;
    messagesUpsert?: (u: BaileysMessagesUpsert) => void;
  } = {};
  const sendCalls: { jid: string; text: string }[] = [];
  let loggedOut = false;

  const sock: WhatsAppSocket = {
    ev: {
      on(event, listener) {
        if (event === "creds.update") handlers.creds = listener as () => void;
        if (event === "connection.update") handlers.connectionUpdate = listener as (u: BaileysConnectionUpdate) => void;
        if (event === "messages.upsert") handlers.messagesUpsert = listener as (u: BaileysMessagesUpsert) => void;
      },
    },
    user: null,
    async sendMessage(jid, content) {
      sendCalls.push({ jid, text: content.text });
      return {};
    },
    async logout() {
      loggedOut = true;
    },
  };

  return {
    sock,
    sendCalls,
    isLoggedOut: () => loggedOut,
    emitConnectionUpdate: (u: BaileysConnectionUpdate) => handlers.connectionUpdate?.(u),
    emitMessagesUpsert: (u: BaileysMessagesUpsert) => handlers.messagesUpsert?.(u),
  };
}

function setupManager() {
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
      const fake = createFakeSocket();
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
 * then drops (a non-401 close after "open", not while still awaiting a
 * QR scan) must get a real explanation too, but a different, accurate one
 * -- "the QR code expired" would be misleading for a session that was
 * never waiting on a QR scan in the first place.
 */
test("a connection that drops after being fully connected (not a QR timeout) surfaces a different, accurate explanation", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:12@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });
  assert.equal(manager.getStatus("proj1").status, "connected");

  createdSockets[0].emitConnectionUpdate({ connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });

  const state = manager.getStatus("proj1");
  assert.equal(state.status, "disconnected");
  assert.ok(state.error, "expected a real explanation, not a silent revert to disconnected");
  assert.doesNotMatch(state.error!, /qr/i, "a session that was never waiting on a QR scan must not blame a QR code");
});

test("sendMessage succeeds once connected, addressing the real WhatsApp JID format", async () => {
  const { manager, createdSockets } = setupManager();
  await manager.connect("proj1");
  createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
  createdSockets[0].emitConnectionUpdate({ connection: "open" });

  const result = await manager.sendMessage("proj1", "972509998888", "שלום!");
  assert.equal(result.ok, true);
  assert.deepEqual(createdSockets[0].sendCalls, [{ jid: "972509998888@s.whatsapp.net", text: "שלום!" }]);
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
