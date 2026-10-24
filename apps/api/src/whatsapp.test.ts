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

/**
 * Regression test for the OTHER direction of findMatchingRecord's
 * shorter/longer swap: the test above only ever exercises the case where
 * the STORED phone normalizes shorter than the incoming number (local
 * format vs. WhatsApp's own international format) -- the ternary's other
 * branch, where the stored number is the longer one, had no test
 * exercising it at all. The swap exists specifically so the match works
 * regardless of which side happens to be longer (findMatchingRecord's own
 * docstring makes no assumption about which); a future edit that
 * "simplified" the ternary into always treating the incoming number as
 * the longer one (a plausible-looking simplification, since in today's
 * only tested case it happens to be true) would silently break matching
 * for a record stored in full international format matched against a
 * shorter incoming value, with no test catching it.
 */
test("findMatchingRecord matches when the STORED phone normalizes longer than the incoming number, not just the reverse", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  const inserted = insertRecord(db, project.id, customer, { name: "Yossi Cohen", phone: "+972-50-123-4567" });

  // Shorter than the stored, normalized number above (12 digits) -- exactly
  // the reverse length relationship of the sibling test.
  const match = findMatchingRecord(db, project, "501234567");
  assert.ok(match);
  assert.equal(match!.entityName, "Customer");
  assert.equal(match!.recordId, inserted.id);
  assert.equal(match!.label, "Yossi Cohen");
});

test("findMatchingRecord returns null for a genuinely unknown number instead of guessing", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Dana Levi", phone: "0501234567" });

  assert.equal(findMatchingRecord(db, project, "972509999999"), null);
});

/**
 * Round 926: a number stored with BOTH the country code and the local
 * trunk zero still in the middle (e.g. "+972-050-1234567" -- an ordinary
 * way to type a familiar local number with a country code tacked on the
 * front without remembering to drop the 0) normalizes to one digit LONGER
 * than the exact same number as WhatsApp actually delivers it, since
 * normalizePhone's own leading-zero strip can't see a zero that isn't at
 * the very start of the digit string. Before this round's fix, that
 * customer's real incoming messages never auto-matched their own record
 * at all, silently, forever.
 */
test("findMatchingRecord matches a stored phone that still has an embedded trunk zero after its country code", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  const inserted = insertRecord(db, project.id, customer, { name: "Michal Azulai", phone: "+972-050-1234567" });

  const match = findMatchingRecord(db, project, "972501234567");
  assert.ok(match, "the embedded trunk zero must not prevent the match");
  assert.equal(match!.entityName, "Customer");
  assert.equal(match!.recordId, inserted.id);
  assert.equal(match!.label, "Michal Azulai");
});

/** The reverse length relationship of the test above -- the INCOMING number is the one with the embedded zero, not the stored one. */
test("findMatchingRecord matches when the INCOMING number has the embedded trunk zero instead of the stored one", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  const inserted = insertRecord(db, project.id, customer, { name: "Noa Ben-David", phone: "972501234567" });

  const match = findMatchingRecord(db, project, "9720501234567");
  assert.ok(match, "the embedded trunk zero on the incoming side must not prevent the match either");
  assert.equal(match!.recordId, inserted.id);
});

/**
 * The embedded-zero fallback must stay narrow: two genuinely DIFFERENT
 * numbers that merely happen to be the same length apart must never be
 * treated as a match just because removing some "0" somewhere produces a
 * same-length string -- it must require the FULL remaining digits to be
 * identical to the other number, not just the same length.
 */
test("findMatchingRecord's embedded-zero fallback never matches two genuinely different numbers", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Dana Levi", phone: "+972-050-1234567" });

  // One digit longer than "972501234567" (the number that WOULD match),
  // but not reachable by removing a single "0" from the stored number --
  // a genuinely different person's number of the same shape.
  assert.equal(findMatchingRecord(db, project, "972509999999"), null);
});

/**
 * Regression test for PHONE_FIELD_NAME_HINTS: the domain library's own
 * entities all happen to name this field exactly "phone", but a spec
 * generated by the AI from a freeform idea description has no such
 * guarantee -- a field named "mobile" (a different word entirely, not just
 * different casing) is just as plausible a name for a real business's
 * customer/contact entity, and previously findMatchingRecord's hardcoded
 * exact-match against "phone" silently skipped every entity that used a
 * synonym field name instead, so WhatsApp messages from a real, existing
 * contact never matched and always fell through to "unknown number".
 */
test("findMatchingRecord matches a phone field named with a common synonym, not just the literal name \"phone\"", () => {
  const mobileProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Customer",
          label: "לקוחות",
          fields: [
            { name: "name", label: "שם", type: "text", required: true },
            { name: "mobile", label: "נייד", type: "text", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, mobileProject.id, mobileProject.spec);
  const customer = mobileProject.spec.entities[0];
  const inserted = insertRecord(db, mobileProject.id, customer, { name: "Roni Bar", mobile: "050-999-8888" });

  const match = findMatchingRecord(db, mobileProject, "972509998888");
  assert.ok(match);
  assert.equal(match!.entityName, "Customer");
  assert.equal(match!.recordId, inserted.id);
  assert.equal(match!.label, "Roni Bar");
});

/**
 * Regression test for the case-insensitive half of the same fix: a field
 * literally named "Phone" (capital P) is a plausible, common AI-generated
 * or hand-authored spelling that a naive exact-string hint match (without
 * .toLowerCase()) would still miss even after adding synonyms.
 */
test("findMatchingRecord matches a phone field regardless of its name's casing", () => {
  const casedProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Customer",
          label: "לקוחות",
          fields: [
            { name: "name", label: "שם", type: "text", required: true },
            { name: "Phone", label: "טלפון", type: "text", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, casedProject.id, casedProject.spec);
  const customer = casedProject.spec.entities[0];
  const inserted = insertRecord(db, casedProject.id, customer, { name: "Tal Green", Phone: "050-111-2222" });

  const match = findMatchingRecord(db, casedProject, "972501112222");
  assert.ok(match);
  assert.equal(match!.recordId, inserted.id);
  assert.equal(match!.label, "Tal Green");
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

/**
 * Round 774: findMatchingRecord used to pick only the FIRST field on an
 * entity whose name matched PHONE_FIELD_NAME_HINTS (entity.fields.find),
 * then only ever checked that one field for every record -- so an entity
 * with two plausible phone-like fields (e.g. "phone", an office line,
 * declared before "mobile", the number that actually receives WhatsApp
 * messages -- an entirely ordinary real-world combination) silently
 * never matched against the second field at all, for any record,
 * regardless of which field actually held the incoming sender's number.
 */
test("findMatchingRecord checks every phone-like field on an entity, not just the first one declared", () => {
  const twoPhoneFieldsProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Customer",
          label: "לקוחות",
          fields: [
            { name: "name", label: "שם", type: "text", required: true },
            { name: "phone", label: "טלפון", type: "text", required: false },
            { name: "mobile", label: "נייד", type: "text", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, twoPhoneFieldsProject.id, twoPhoneFieldsProject.spec);
  const customer = twoPhoneFieldsProject.spec.entities[0];
  const inserted = insertRecord(db, twoPhoneFieldsProject.id, customer, {
    name: "Dana Levi",
    phone: "03-555-1234",
    mobile: "050-999-8888",
  });

  const match = findMatchingRecord(db, twoPhoneFieldsProject, "972509998888");
  assert.ok(match, "must match via the second phone-like field (mobile) even though it's declared after the first (phone)");
  assert.equal(match!.recordId, inserted.id);
  assert.equal(match!.label, "Dana Levi");
});
