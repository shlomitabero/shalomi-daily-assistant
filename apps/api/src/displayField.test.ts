import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@forge/shared";
import { pickDisplayField, recordDisplayLabel } from "./displayField.js";

test("pickDisplayField prefers a field literally named name or title over any other field", () => {
  const entity: Entity = {
    name: "Customer",
    fields: [
      { name: "phone", type: "text", required: false },
      { name: "name", type: "text", required: true },
      { name: "email", type: "text", required: false },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "name");
});

test("pickDisplayField falls back to the first text field when there's no name/title field", () => {
  const entity: Entity = {
    name: "Order",
    fields: [
      { name: "total", type: "number", required: true },
      { name: "notes", type: "text", required: false },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "notes");
});

/**
 * Round 762 regression test: a plain "text" field and a "longtext" field
 * are treated as the same free-text kind everywhere else in this codebase
 * (AutomationsPanel.tsx's phoneFields, pipeline.ts's seed-value check,
 * validateAutomationToField, migrate.ts's type_changed branch) -- but
 * pickDisplayField's "first text field" step only ever checked "text",
 * never "longtext". An entity like a feedback form with no name/title/
 * text field, only a longtext "message" and a number "rating", would
 * otherwise skip past "message" and land on "rating" as the display
 * field, labeling every record by its numeric rating.
 */
test("pickDisplayField falls back to the first longtext field when there's no name/title/text field", () => {
  const entity: Entity = {
    name: "Feedback",
    fields: [
      { name: "rating", type: "number", required: true },
      { name: "message", type: "longtext", required: false },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "message");
});

test("pickDisplayField prefers a real text field over a longtext field, even when the longtext field is declared first", () => {
  const entity: Entity = {
    name: "Feedback",
    fields: [
      { name: "message", type: "longtext", required: false },
      { name: "summary", type: "text", required: false },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "summary");
});

test("pickDisplayField falls back to the entity's first field of any type as a last resort", () => {
  const entity: Entity = {
    name: "Metric",
    fields: [{ name: "value", type: "number", required: true }],
  };
  assert.equal(pickDisplayField(entity)?.name, "value");
});

/**
 * A join/line-item entity (e.g. an Enrollment linking a Student to a
 * Course) can legitimately have no name/title/text field at all --
 * EntitySchema only requires at least one field, nothing requires a text
 * one. Without skipping relation fields in the last-resort fallback,
 * pickDisplayField would pick the first relation field, and
 * recordDisplayLabel would then render that field's raw stored value --
 * the *related* record's own internal id, e.g. "4" -- as if it were this
 * record's own human label, everywhere a record is shown by name (a
 * relation picker's own options, CSV export/import's relation-cell
 * matching, WhatsApp template interpolation).
 */
test("pickDisplayField skips a relation field in its last-resort fallback, preferring any other non-relation field instead", () => {
  const entity: Entity = {
    name: "Enrollment",
    fields: [
      { name: "studentId", type: "relation", relationTo: "Student", required: true },
      { name: "grade", type: "enum", required: false, enumValues: ["A", "B", "C"] },
      { name: "courseId", type: "relation", relationTo: "Course", required: true },
    ],
  };
  assert.equal(
    pickDisplayField(entity)?.name,
    "grade",
    "with no name/title/text field, the first non-relation field (grade) must win over the first-declared relation field (studentId)",
  );
});

test("pickDisplayField falls back to the first relation field only when literally every field on the entity is itself a relation", () => {
  const entity: Entity = {
    name: "Membership",
    fields: [
      { name: "userId", type: "relation", relationTo: "User", required: true },
      { name: "groupId", type: "relation", relationTo: "Group", required: true },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "userId", "there's nothing else to fall back to, so the first field regardless is the only option left");
});

/**
 * Round 749: the same gap the test above covers for a relation field, but
 * for "file" -- a document-centric join entity (e.g. an Enrollment with a
 * signed certificate attached) can just as legitimately have no name/
 * title/text field. Without skipping "file" too in the last-resort
 * fallback, recordDisplayLabel would String() the file's raw JSON upload
 * descriptor ({url,name,size,mimeType}) as this record's own human label.
 */
test("pickDisplayField skips a file field in its last-resort fallback, preferring any other displayable field instead", () => {
  const entity: Entity = {
    name: "Enrollment",
    fields: [
      { name: "studentId", type: "relation", relationTo: "Student", required: true },
      { name: "certificate", type: "file", required: false },
      { name: "grade", type: "enum", required: false, enumValues: ["A", "B", "C"] },
    ],
  };
  assert.equal(
    pickDisplayField(entity)?.name,
    "grade",
    "with no name/title/text field, the enum field (grade) must win over both the relation (studentId) and the file field (certificate)",
  );
});

test("pickDisplayField falls back to the first field regardless when every remaining field is either a relation or a file", () => {
  const entity: Entity = {
    name: "Enrollment",
    fields: [
      { name: "studentId", type: "relation", relationTo: "Student", required: true },
      { name: "certificate", type: "file", required: false },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "studentId", "there's nothing else to fall back to, so the first field regardless is the only option left");
});

/**
 * Round 793 regression test: the name-hint step itself never checked
 * field type, unlike the last-resort step just above (which explicitly
 * skips relation/file). An Employee entity whose "title" field is a
 * relation to a normalized JobTitle lookup entity (a perfectly reasonable
 * real-world schema) would have pickDisplayField return that relation
 * field purely because it's named "title" -- before the later, type-aware
 * steps ever got a chance to prefer the plain "department" text field
 * instead. recordDisplayLabel would then String() the raw foreign-key id
 * (e.g. "4") as the employee's own label, everywhere one is shown by name.
 */
test("pickDisplayField skips a relation field even when it's literally named 'title', preferring a later text field instead", () => {
  const entity: Entity = {
    name: "Employee",
    fields: [
      { name: "title", type: "relation", relationTo: "JobTitle", required: true },
      { name: "department", type: "text", required: false },
    ],
  };
  assert.equal(
    pickDisplayField(entity)?.name,
    "department",
    "a relation field named 'title' must not win just by name -- the plain text field (department) should win instead",
  );
});

/**
 * Same gap, for "file" -- a Document entity whose uploaded-file field
 * happens to be named "name" (also a perfectly reasonable real-world
 * schema) would otherwise win by name alone, and recordDisplayLabel would
 * String() the file's raw JSON upload descriptor ({url,name,size,
 * mimeType}) as the record's own label.
 */
test("pickDisplayField skips a file field even when it's literally named 'name', preferring a later text field instead", () => {
  const entity: Entity = {
    name: "Document",
    fields: [
      { name: "name", type: "file", required: true },
      { name: "category", type: "text", required: false },
    ],
  };
  assert.equal(
    pickDisplayField(entity)?.name,
    "category",
    "a file field named 'name' must not win just by name -- the plain text field (category) should win instead",
  );
});

test("pickDisplayField's tie-break between a name field and a title field follows field declaration order, not name-before-title priority", () => {
  // DISPLAY_FIELD_NAME_HINTS lists "name" before "title", which reads like a
  // priority order, but pickDisplayField iterates entity.fields (not the
  // hints list) and returns the first field whose own name matches any
  // hint -- so when an entity happens to declare "title" before "name",
  // "title" wins, not "name". This is a real, if accidental, behavior that
  // a future refactor (e.g. "look up each hint in priority order instead")
  // would plausibly and silently flip.
  const titleFirst: Entity = {
    name: "Article",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "name", type: "text", required: true },
    ],
  };
  assert.equal(pickDisplayField(titleFirst)?.name, "title");

  const nameFirst: Entity = {
    name: "Article",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "title", type: "text", required: true },
    ],
  };
  assert.equal(pickDisplayField(nameFirst)?.name, "name");
});

test("recordDisplayLabel renders #<id> when the display field's value is missing or empty", () => {
  const entity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  assert.equal(recordDisplayLabel(entity, { id: 7, createdAt: "", name: "" }), "#7");
  assert.equal(recordDisplayLabel(entity, { id: 8, createdAt: "", name: null }), "#8");
  assert.equal(recordDisplayLabel(entity, { id: 9, createdAt: "", name: "Dana Levi" }), "Dana Levi");
});

/**
 * Round 761 regression test: when pickDisplayField's last-resort fallback
 * lands on an enum field (the exact "Enrollment" fixture the round-749
 * file-exclusion test above already uses, where "grade" is an enum
 * picked over the relation/file fields), recordDisplayLabel used to
 * String() the field's raw stored value instead of resolving it through
 * the field's own enumLabels -- the uniform convention every other enum
 * render path in this codebase already follows. A real-world instance:
 * an entity with no name/title/text field whose only other field is an
 * enum with translated labels (e.g. a "movementType" enum valued
 * "in"/"out" with Hebrew labels) would show the raw English key anywhere
 * a record of it is displayed by name -- a relation picker, an
 * Automation Rule's WhatsApp message, Business Twin's narrative.
 */
test("recordDisplayLabel resolves an enum display field through its own enumLabels, not its raw stored value", () => {
  const entity: Entity = {
    name: "Enrollment",
    fields: [
      { name: "studentId", type: "relation", relationTo: "Student", required: true },
      { name: "certificate", type: "file", required: false },
      { name: "grade", type: "enum", required: false, enumValues: ["A", "B", "C"], enumLabels: { A: "מצטיין", B: "טוב", C: "עובר" } },
    ],
  };
  assert.equal(
    recordDisplayLabel(entity, { id: 3, createdAt: "", studentId: 1, certificate: "", grade: "A" }),
    "מצטיין",
    "the enum field's own translated label must be shown, not the raw stored value \"A\"",
  );
});

/**
 * Round 771 regression test: the exact same bug class as the enum fix
 * just above, never done for "boolean" -- when pickDisplayField's
 * last-resort fallback lands on a boolean field, recordDisplayLabel used
 * to String() the raw value ("true"/"false") instead of this codebase's
 * own uniform "TRUE"/"FALSE" convention.
 */
test("recordDisplayLabel resolves a boolean display field to TRUE/FALSE, not its raw lowercase stored value", () => {
  const entity: Entity = {
    name: "Consent",
    fields: [
      { name: "studentId", type: "relation", relationTo: "Student", required: true },
      { name: "courseId", type: "relation", relationTo: "Course", required: true },
      { name: "signed", type: "boolean", required: false },
    ],
  };
  assert.equal(
    recordDisplayLabel(entity, { id: 5, createdAt: "", studentId: 1, courseId: 1, signed: true }),
    "TRUE",
    "the boolean field's own uniform TRUE/FALSE convention must be shown, not the raw stored value \"true\"",
  );
  assert.equal(
    recordDisplayLabel(entity, { id: 6, createdAt: "", studentId: 1, courseId: 2, signed: false }),
    "FALSE",
    "a false boolean display field must render FALSE, not fall through the empty-value check and then String() to \"false\"",
  );
});

/**
 * Round 968 regression test: the exact same bug class as the enum (761)
 * and boolean (771) fixes above, never done for "relation" -- when
 * pickDisplayField's own last-resort step (its "falls back to the first
 * relation field only when literally every field is itself a relation"
 * case, tested above) lands on a relation field, recordDisplayLabel used
 * to String() the raw *target* foreign-key id as this record's own
 * label. That id is the related PARENT's id, not this record's own --
 * two different Membership rows for the same user (different groups)
 * share the exact same userId, so both rendered the identical, genuinely
 * ambiguous label "4" with no way to tell them apart in a relation
 * picker, CSV export, or WhatsApp template.
 */
test("recordDisplayLabel falls back to this record's own #<id>, not the relation field's raw target id, when the display field is itself a relation", () => {
  const entity: Entity = {
    name: "Membership",
    fields: [
      { name: "userId", type: "relation", relationTo: "User", required: true },
      { name: "groupId", type: "relation", relationTo: "Group", required: true },
    ],
  };
  const membership1 = { id: 1, createdAt: "", userId: 4, groupId: 10 };
  const membership2 = { id: 2, createdAt: "", userId: 4, groupId: 20 };
  assert.equal(
    recordDisplayLabel(entity, membership1),
    "#1",
    "must fall back to this record's own id, not the bare raw target id \"4\" shared by every other membership for the same user",
  );
  assert.equal(
    recordDisplayLabel(entity, membership2),
    "#2",
    "a second, genuinely different record sharing the exact same relation value (userId: 4) must get its own distinct label",
  );
  assert.notEqual(
    recordDisplayLabel(entity, membership1),
    recordDisplayLabel(entity, membership2),
    "two different records must never render as the exact same, indistinguishable label",
  );
});
