import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  ensureWhatsAppConnectionsTable,
  ensureWhatsAppMessagesTable,
  getWhatsAppConnection,
  insertWhatsAppMessage,
  listWhatsAppMessages,
  recordWhatsAppConnected,
  recordWhatsAppDisconnected,
} from "./whatsapp.js";

test("getWhatsAppConnection returns undefined for a project that never connected", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppConnectionsTable(db);
  assert.equal(getWhatsAppConnection(db, "proj1"), undefined);
});

test("recordWhatsAppConnected stores the linked phone number and a connectedAt timestamp", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppConnectionsTable(db);
  const saved = recordWhatsAppConnected(db, "proj1", "972501234567");
  assert.equal(saved.projectId, "proj1");
  assert.equal(saved.phoneNumber, "972501234567");
  assert.ok(saved.connectedAt);
  assert.ok(saved.updatedAt);
});

test("recordWhatsAppConnected overwrites the previous connection for the same project, not creating a duplicate row", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppConnectionsTable(db);
  recordWhatsAppConnected(db, "proj1", "972500000001");
  const updated = recordWhatsAppConnected(db, "proj1", "972500000002");
  assert.equal(updated.phoneNumber, "972500000002");

  const fetched = getWhatsAppConnection(db, "proj1");
  assert.equal(fetched?.phoneNumber, "972500000002");
});

test("recordWhatsAppDisconnected clears connectedAt but keeps the last known phone number for display", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppConnectionsTable(db);
  recordWhatsAppConnected(db, "proj1", "972501234567");
  recordWhatsAppDisconnected(db, "proj1");

  const fetched = getWhatsAppConnection(db, "proj1");
  assert.equal(fetched?.phoneNumber, "972501234567");
  assert.equal(fetched?.connectedAt, null);
});

test("recordWhatsAppDisconnected is a harmless no-op for a project that never connected", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppConnectionsTable(db);
  recordWhatsAppDisconnected(db, "proj-never-connected");
  assert.equal(getWhatsAppConnection(db, "proj-never-connected"), undefined);
});

test("connection state for one project never leaks into another project's read", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppConnectionsTable(db);
  recordWhatsAppConnected(db, "proj1", "972501234567");
  assert.equal(getWhatsAppConnection(db, "proj2"), undefined);
});

test("insertWhatsAppMessage stores a real message and listWhatsAppMessages returns it back, newest first", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "in",
    fromNumber: "972501234567",
    toNumber: "15550001111",
    body: "היי, מתי התור שלי?",
    status: "received",
  });
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "out",
    fromNumber: "15550001111",
    toNumber: "972501234567",
    body: "התור שלך מחר בעשר",
    status: "sent",
  });

  const messages = listWhatsAppMessages(db, "proj1");
  assert.equal(messages.length, 2);
  // Newest first: the "out" reply was inserted second.
  assert.equal(messages[0].direction, "out");
  assert.equal(messages[1].direction, "in");
  assert.equal(messages[1].body, "היי, מתי התור שלי?");
});

test("insertWhatsAppMessage records a matched entity record when given one, and null when not matched", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  const matched = insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "in",
    fromNumber: "972501234567",
    toNumber: "15550001111",
    body: "שלום",
    status: "received",
    matchedEntityName: "Customer",
    matchedRecordId: 7,
    matchedLabel: "דנה לוי",
  });
  assert.equal(matched.matchedEntityName, "Customer");
  assert.equal(matched.matchedRecordId, 7);
  assert.equal(matched.matchedLabel, "דנה לוי");

  const unmatched = insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "in",
    fromNumber: "972500000000",
    toNumber: "15550001111",
    body: "מספר לא מוכר",
    status: "received",
  });
  assert.equal(unmatched.matchedEntityName, null);
  assert.equal(unmatched.matchedRecordId, null);
  assert.equal(unmatched.matchedLabel, null);
});

test("listWhatsAppMessages scopes to the given project and respects the limit", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  for (let i = 0; i < 5; i++) {
    insertWhatsAppMessage(db, {
      projectId: "proj1",
      direction: "in",
      fromNumber: "972500000000",
      toNumber: "15550001111",
      body: `message ${i}`,
      status: "received",
    });
  }
  insertWhatsAppMessage(db, {
    projectId: "proj2",
    direction: "in",
    fromNumber: "972500000001",
    toNumber: "15550001111",
    body: "someone else's message",
    status: "received",
  });

  assert.equal(listWhatsAppMessages(db, "proj1").length, 5);
  assert.equal(listWhatsAppMessages(db, "proj1", 2).length, 2);
  assert.equal(listWhatsAppMessages(db, "proj2").length, 1);
});
