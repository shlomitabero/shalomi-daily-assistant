import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  const sendCalls: ({ jid: string; text: string } | { jid: string; document: Buffer; mimetype: string; fileName: string; caption?: string })[] = [];
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
      if ("text" in content) {
        sendCalls.push({ jid, text: content.text });
      } else {
        sendCalls.push({ jid, document: content.document, mimetype: content.mimetype, fileName: content.fileName, caption: content.caption });
      }
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

  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(maxActive, 1, "the socket must never see two sends in flight at the same time");
  assert.deepEqual(order, ["one", "two", "three"], "sends must go out in call order, one at a time, not interleaved");
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
