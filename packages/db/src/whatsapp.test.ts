import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import { NotFoundError } from "./repository.js";
import {
  clearWhatsAppMessages,
  deleteWhatsAppMessage,
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

  const { messages, hasMore } = listWhatsAppMessages(db, "proj1");
  assert.equal(messages.length, 2);
  // Newest first: the "out" reply was inserted second.
  assert.equal(messages[0].direction, "out");
  assert.equal(messages[1].direction, "in");
  assert.equal(messages[1].body, "היי, מתי התור שלי?");
  assert.equal(hasMore, false, "there is nothing beyond these 2 messages");
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

  assert.equal(listWhatsAppMessages(db, "proj1").messages.length, 5);
  assert.equal(listWhatsAppMessages(db, "proj1", 2).messages.length, 2);
  assert.equal(listWhatsAppMessages(db, "proj2").messages.length, 1);
});

/**
 * New in this round: before, once a conversation passed the default limit
 * of 50, everything older became permanently unreachable -- there was no
 * offset param to ask for the next page, and nothing in the response even
 * hinted that more messages existed (see formatWhatsAppMessageCount's own
 * "N of N (all)" phrasing, which trusted the returned array's length as
 * the real total). hasMore -- computed from an extra row past `limit`,
 * never a second COUNT(*) query -- now tells the caller honestly whether
 * there's a next page, and offset lets it actually ask for one.
 */
test("listWhatsAppMessages reports hasMore honestly and offset actually reaches older messages", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  // Insert 5 messages with strictly increasing createdAt so "page order" is
  // unambiguous: body "message 4" is newest, "message 0" is oldest.
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

  const firstPage = listWhatsAppMessages(db, "proj1", 2, 0);
  assert.deepEqual(firstPage.messages.map((m) => m.body), ["message 4", "message 3"]);
  assert.equal(firstPage.hasMore, true, "3 older messages still exist beyond this page of 2");

  const secondPage = listWhatsAppMessages(db, "proj1", 2, 2);
  assert.deepEqual(secondPage.messages.map((m) => m.body), ["message 2", "message 1"]);
  assert.equal(secondPage.hasMore, true, "1 older message (message 0) still exists");

  const thirdPage = listWhatsAppMessages(db, "proj1", 2, 4);
  assert.deepEqual(thirdPage.messages.map((m) => m.body), ["message 0"]);
  assert.equal(thirdPage.hasMore, false, "message 0 is the oldest -- nothing left to load");
});

/**
 * The edge case formatWhatsAppMessageCount's own doc comment calls out:
 * hasMore must not be a mere `messages.length === limit` check, because
 * that's ALSO true on a genuinely final page whose count happens to equal
 * the limit exactly -- a project with precisely `limit` messages total
 * must report hasMore: false, not falsely invite a "load more" click that
 * would come back empty.
 */
test("listWhatsAppMessages reports hasMore: false when the total is an exact multiple of the limit", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  for (let i = 0; i < 4; i++) {
    insertWhatsAppMessage(db, {
      projectId: "proj1",
      direction: "in",
      fromNumber: "972500000000",
      toNumber: "15550001111",
      body: `message ${i}`,
      status: "received",
    });
  }

  const { messages, hasMore } = listWhatsAppMessages(db, "proj1", 4, 0);
  assert.equal(messages.length, 4);
  assert.equal(hasMore, false, "exactly 4 messages exist and the limit is 4 -- there is nothing more");
});

test("clearWhatsAppMessages wipes only the given project's message log, leaving other projects untouched", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "in",
    fromNumber: "972500000000",
    toNumber: "15550001111",
    body: "message to clear",
    status: "received",
  });
  insertWhatsAppMessage(db, {
    projectId: "proj2",
    direction: "in",
    fromNumber: "972500000001",
    toNumber: "15550001111",
    body: "someone else's message",
    status: "received",
  });

  clearWhatsAppMessages(db, "proj1");

  assert.equal(listWhatsAppMessages(db, "proj1").messages.length, 0);
  assert.equal(listWhatsAppMessages(db, "proj2").messages.length, 1);
});

test("clearWhatsAppMessages is a harmless no-op for a project with no messages", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  clearWhatsAppMessages(db, "proj-empty");
  assert.equal(listWhatsAppMessages(db, "proj-empty").messages.length, 0);
});

/**
 * New in this round: clearWhatsAppMessages above was previously the only
 * way to remove anything from the log at all -- one junk or test message
 * meant wiping the whole history to get rid of it. deleteWhatsAppMessage
 * removes exactly the one given message, leaving every other message (in
 * this project and any other) untouched.
 */
test("deleteWhatsAppMessage removes exactly the one message, leaving the rest of this project's log and every other project's log untouched", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  const target = insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "in",
    fromNumber: "972500000000",
    toNumber: "15550001111",
    body: "delete me",
    status: "received",
  });
  insertWhatsAppMessage(db, {
    projectId: "proj1",
    direction: "in",
    fromNumber: "972500000000",
    toNumber: "15550001111",
    body: "keep me",
    status: "received",
  });
  insertWhatsAppMessage(db, {
    projectId: "proj2",
    direction: "in",
    fromNumber: "972500000001",
    toNumber: "15550001111",
    body: "someone else's message",
    status: "received",
  });

  deleteWhatsAppMessage(db, "proj1", target.id);

  const { messages: remaining } = listWhatsAppMessages(db, "proj1");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].body, "keep me");
  assert.equal(listWhatsAppMessages(db, "proj2").messages.length, 1, "a different project's log must be completely untouched");
});

/**
 * The projectId scope in deleteWhatsAppMessage's own WHERE clause (matching
 * deleteRecord's convention in repository.ts) means a real message id that
 * happens to belong to a DIFFERENT project can never be deleted by passing
 * the wrong projectId -- it must be treated as not-found for that project,
 * not silently succeed against someone else's message.
 */
test("deleteWhatsAppMessage throws NotFoundError for a real message id that belongs to a different project", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  const message = insertWhatsAppMessage(db, {
    projectId: "proj2",
    direction: "in",
    fromNumber: "972500000001",
    toNumber: "15550001111",
    body: "belongs to proj2",
    status: "received",
  });

  assert.throws(() => deleteWhatsAppMessage(db, "proj1", message.id), NotFoundError);
  assert.equal(listWhatsAppMessages(db, "proj2").messages.length, 1, "the message must still exist under its real project");
});

test("deleteWhatsAppMessage throws NotFoundError for an id that doesn't exist at all", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppMessagesTable(db);
  assert.throws(() => deleteWhatsAppMessage(db, "proj1", "no-such-id"), NotFoundError);
});
