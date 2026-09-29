import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, EntityRecord, Field } from "@forge/shared";
import { buildCalendarIcs } from "./calendarIcs.js";

const dateField: Field = { name: "appointmentDate", label: "תאריך תור", type: "date", required: true };
const nameField: Field = { name: "customerName", label: "שם לקוח", type: "text", required: true };
const notesField: Field = { name: "notes", label: "הערות", type: "text", required: false };
const courierField: Field = { name: "courierId", label: "שליח", type: "relation", relationTo: "Courier", required: false };

const entity: Entity = {
  name: "Appointment",
  label: "תור",
  fields: [dateField, nameField, notesField, courierField],
};

function parseEvents(ics: string): string[] {
  return ics.split("BEGIN:VEVENT").slice(1).map((chunk) => "BEGIN:VEVENT" + chunk.split("END:VEVENT")[0] + "END:VEVENT");
}

test("buildCalendarIcs wraps output in a real VCALENDAR with VERSION/PRODID/CALSCALE", () => {
  const ics = buildCalendarIcs(entity, dateField, nameField, [], [], {});
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/Forge AI\/\/.*\/\/EN\r\nCALSCALE:GREGORIAN/);
  assert.match(ics, /END:VCALENDAR$/);
});

test("buildCalendarIcs emits one all-day VEVENT per record with correct DTSTART/DTEND (next-day exclusive end)", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: null, courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  const events = parseEvents(ics);
  assert.equal(events.length, 1);
  assert.match(events[0], /DTSTART;VALUE=DATE:20260315/);
  assert.match(events[0], /DTEND;VALUE=DATE:20260316/, "an all-day single-day event's DTEND must be the next day (RFC 5545 exclusive end), not the same day");
});

test("buildCalendarIcs's SUMMARY uses the label field's value, and UID is unique per entity+record id", () => {
  const records: EntityRecord[] = [
    { id: 7, appointmentDate: "2026-01-01", customerName: "Yossi Cohen", notes: null, courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  assert.match(ics, /SUMMARY:Yossi Cohen/);
  assert.match(ics, /UID:Appointment-7@forge-ai/);
});

test("buildCalendarIcs's DESCRIPTION includes every other field as 'Label: value', excluding the date and label fields themselves", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: "First visit", courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  const events = parseEvents(ics);
  assert.match(events[0], /DESCRIPTION:הערות: First visit/);
  assert.doesNotMatch(events[0], /תאריך תור:/, "the date field itself must never appear in DESCRIPTION -- it's already DTSTART");
  assert.doesNotMatch(events[0], /שם לקוח:/, "the label field itself must never appear in DESCRIPTION -- it's already SUMMARY");
});

test("buildCalendarIcs resolves a relation field to the related record's real display label in DESCRIPTION, not the raw stored id", () => {
  const courierEntity: Entity = { name: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: null, courierId: 42 },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [courierEntity], {
    Courier: [{ id: 42, name: "Avi Mizrahi" }],
  });
  assert.match(ics, /שליח: Avi Mizrahi/);
  assert.doesNotMatch(ics, /שליח: 42/, "must never leak the raw foreign-key id when a real related record was found");
});

test("buildCalendarIcs skips a record with a missing or unparseable date value instead of emitting a broken VEVENT", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "", customerName: "No date", notes: null, courierId: null },
    { id: 2, appointmentDate: "not-a-date", customerName: "Bad date", notes: null, courierId: null },
    { id: 3, appointmentDate: "2026-06-01", customerName: "Good date", notes: null, courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  const events = parseEvents(ics);
  assert.equal(events.length, 1, "only the record with a real parseable date should produce a VEVENT");
  assert.match(events[0], /SUMMARY:Good date/);
});

test("buildCalendarIcs escapes commas, semicolons, backslashes, and newlines in TEXT values per RFC 5545", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Cohen, Levi; Backslash\\test", notes: "line one\nline two", courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  assert.match(ics, /SUMMARY:Cohen\\, Levi\\; Backslash\\\\test/);
  assert.match(ics, /line one\\nline two/);
});

/**
 * Regression test for the enum-field gap this round fixes: DESCRIPTION
 * previously showed an enum field's raw stored value (e.g. "shipped")
 * instead of the same Hebrew enumLabels translation every other view of
 * this data (table, Kanban, CSV export) already shows for that field.
 */
test("buildCalendarIcs resolves an enum field to its Hebrew enumLabels translation in DESCRIPTION, not the raw stored value", () => {
  const statusField: Field = {
    name: "status",
    label: "סטטוס",
    type: "enum",
    required: false,
    enumValues: ["pending", "shipped"],
    enumLabels: { pending: "ממתין", shipped: "נשלח" },
  };
  const statusEntity: Entity = { name: "Appointment", label: "תור", fields: [dateField, nameField, statusField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", status: "shipped" }];
  const ics = buildCalendarIcs(statusEntity, dateField, nameField, records, [], {});
  assert.match(ics, /סטטוס: נשלח/);
  assert.doesNotMatch(ics, /סטטוס: shipped/, "must never leak the raw enum value once a real Hebrew label exists for it");
});

/**
 * Same gap, other affected line: SUMMARY uses whatever field
 * calendarChipLabelField picked as the label field, which falls back to
 * the entity's first non-date field when no text/name field exists --
 * for an entity like this one, that field can itself be an enum.
 */
test("buildCalendarIcs resolves an enum field to its Hebrew enumLabels translation in SUMMARY when the label field itself is an enum", () => {
  const statusField: Field = {
    name: "status",
    label: "סטטוס",
    type: "enum",
    required: false,
    enumValues: ["pending", "shipped"],
    enumLabels: { pending: "ממתין", shipped: "נשלח" },
  };
  const statusOnlyEntity: Entity = { name: "Order", label: "הזמנה", fields: [dateField, statusField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", status: "shipped" }];
  const ics = buildCalendarIcs(statusOnlyEntity, dateField, statusField, records, [], {});
  assert.match(ics, /SUMMARY:נשלח/);
  assert.doesNotMatch(ics, /SUMMARY:shipped/, "must never leak the raw enum value in SUMMARY once a real Hebrew label exists for it");
});

test("buildCalendarIcs folds a long DESCRIPTION line at 75 octets with a CRLF + single leading space continuation", () => {
  const longNote = "x".repeat(120);
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: longNote, courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  const lines = ics.split("\r\n");
  const descriptionLineIndex = lines.findIndex((l) => l.startsWith("DESCRIPTION:"));
  assert.ok(descriptionLineIndex >= 0);
  assert.ok(lines[descriptionLineIndex].length <= 75, `folded first line must be <=75 chars, was ${lines[descriptionLineIndex].length}`);
  assert.ok(lines[descriptionLineIndex + 1].startsWith(" "), "a folded continuation line must start with a single leading space");
});
