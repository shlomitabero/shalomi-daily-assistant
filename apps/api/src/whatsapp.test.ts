import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, insertRecord, openDatabase } from "@forge/db";
import { findMatchingRecord, normalizePhone } from "./whatsapp.js";

test("normalizePhone strips non-digits and a single leading trunk zero", () => {
  assert.equal(normalizePhone("050-123-4567"), "501234567");
  assert.equal(normalizePhone("972501234567"), "972501234567");
  assert.equal(normalizePhone(""), "");
});

test("normalizePhone strips a leading 00 international access code fully, not just one of its two zeros", () => {
  // "00" (used when dialing out internationally from many countries,
  // including Israel/Europe) is a two-digit access code, not the same
  // thing as the single-zero national trunk prefix the doc comment above
  // describes -- a real user who types a number this way (e.g. copying it
  // from an email signature) previously ended up with a spurious leading
  // "0" still baked into the "normalized" result.
  assert.equal(normalizePhone("00972-50-123-4567"), "972501234567");
  assert.equal(normalizePhone("+972-50-123-4567"), "972501234567");
});

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

test("findMatchingRecord finds a real record whose stored phone matches the incoming number, across differing international-prefix formats", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  const inserted = insertRecord(db, project.id, customer, { name: "Dana Levi", phone: "050-123-4567" });

  const match = findMatchingRecord(db, project, "972501234567");
  assert.ok(match);
  assert.equal(match!.entityName, "Customer");
  assert.equal(match!.recordId, inserted.id);
  assert.equal(match!.label, "Dana Levi");
});

test("findMatchingRecord returns null for a genuinely unknown number instead of guessing", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Dana Levi", phone: "0501234567" });

  assert.equal(findMatchingRecord(db, project, "972509999999"), null);
});

test("findMatchingRecord skips entities that have no phone field, rather than throwing", () => {
  const noPhone: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [{ name: "Item", fields: [{ name: "name", type: "text", required: true }] }],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, noPhone.id, noPhone.spec);
  assert.equal(findMatchingRecord(db, noPhone, "972501234567"), null);
});
