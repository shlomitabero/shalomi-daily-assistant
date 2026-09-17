import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  ensureWhatsAppMessagesTable,
  ensureWhatsAppSettingsTable,
  getWhatsAppSettings,
  insertWhatsAppMessage,
  listWhatsAppMessages,
  upsertWhatsAppSettings,
} from "./whatsapp.js";

test("getWhatsAppSettings returns undefined for a project with no settings saved yet", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppSettingsTable(db);
  assert.equal(getWhatsAppSettings(db, "proj1"), undefined);
});

test("upsertWhatsAppSettings inserts new settings and returns them back", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppSettingsTable(db);
  const saved = upsertWhatsAppSettings(db, "proj1", {
    phoneNumberId: "123456",
    accessToken: "EAAtoken",
    verifyToken: "my-verify-token",
  });
  assert.equal(saved.projectId, "proj1");
  assert.equal(saved.phoneNumberId, "123456");
  assert.equal(saved.accessToken, "EAAtoken");
  assert.equal(saved.verifyToken, "my-verify-token");
  assert.ok(saved.updatedAt);
});

test("upsertWhatsAppSettings overwrites existing settings for the same project, not creating a duplicate row", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppSettingsTable(db);
  upsertWhatsAppSettings(db, "proj1", { phoneNumberId: "111", accessToken: "old", verifyToken: "v1" });
  const updated = upsertWhatsAppSettings(db, "proj1", { phoneNumberId: "222", accessToken: "new", verifyToken: "v2" });
  assert.equal(updated.phoneNumberId, "222");
  assert.equal(updated.accessToken, "new");

  const fetched = getWhatsAppSettings(db, "proj1");
  assert.equal(fetched?.phoneNumberId, "222");
});

test("settings for one project never leak into another project's read", () => {
  const db = openDatabase(":memory:");
  ensureWhatsAppSettingsTable(db);
  upsertWhatsAppSettings(db, "proj1", { phoneNumberId: "111", accessToken: "a", verifyToken: "v1" });
  assert.equal(getWhatsAppSettings(db, "proj2"), undefined);
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
