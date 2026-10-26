import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, EntityRecord, Field } from "@forge/shared";
import { buildCalendarFeedIcs, findDateField, findEndDateField } from "./calendarFeed.js";

const dateField: Field = { name: "appointmentDate", label: "תאריך תור", type: "date", required: true };
const nameField: Field = { name: "customerName", label: "שם לקוח", type: "text", required: true };
const confirmedField: Field = { name: "confirmed", label: "אישור", type: "boolean", required: false };

const entity: Entity = {
  name: "Appointment",
  label: "תור",
  fields: [dateField, nameField, confirmedField],
};

const startDateField: Field = { name: "startDate", label: "תאריך התחלה", type: "date", required: true };
const endDateField: Field = { name: "endDate", label: "תאריך סיום", type: "date", required: true };
const itemNameField: Field = { name: "itemName", label: "שם הפריט", type: "text", required: true };

const rentalEntity: Entity = {
  name: "Rental",
  label: "השכרה",
  fields: [itemNameField, startDateField, endDateField],
};

function parseEvents(ics: string): string[] {
  return ics.split("BEGIN:VEVENT").slice(1).map((chunk) => "BEGIN:VEVENT" + chunk.split("END:VEVENT")[0] + "END:VEVENT");
}

test("buildCalendarFeedIcs returns null for an entity with no date field at all, so the caller can 404 instead of serving an always-empty feed", () => {
  const noDateEntity: Entity = { name: "Note", label: "Note", fields: [nameField] };
  assert.equal(buildCalendarFeedIcs(noDateEntity, [], "proj1"), null);
});

test("buildCalendarFeedIcs wraps output in a real VCALENDAR with VERSION/PRODID/CALSCALE, one all-day VEVENT per record", () => {
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", confirmed: true }];
  const ics = buildCalendarFeedIcs(entity, records, "proj1");
  assert.ok(ics);
  assert.match(ics!, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/Forge AI\/\/.*\/\/EN\r\nCALSCALE:GREGORIAN/);
  assert.match(ics!, /END:VCALENDAR$/);
  const events = parseEvents(ics!);
  assert.equal(events.length, 1);
  assert.match(events[0], /DTSTART;VALUE=DATE:20260315/);
  assert.match(events[0], /DTEND;VALUE=DATE:20260316/, "an all-day single-day event's DTEND must be the next day (RFC 5545 exclusive end), not the same day");
  assert.match(events[0], /SUMMARY:Dana Levi/, "SUMMARY must use the auto-detected display field's value");
});

test("buildCalendarFeedIcs includes EVERY record with a valid date, not just one month -- the whole point of a live feed vs. the one-shot export", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2024-01-01", customerName: "Old One", confirmed: false },
    { id: 2, appointmentDate: "2026-06-15", customerName: "Recent", confirmed: true },
    { id: 3, appointmentDate: "2030-12-31", customerName: "Far Future", confirmed: true },
  ];
  const ics = buildCalendarFeedIcs(entity, records, "proj1");
  const events = parseEvents(ics!);
  assert.equal(events.length, 3);
});

test("buildCalendarFeedIcs's UID is unique per entity+record id, scoped by projectId so two different projects' same-shaped entity never collides", () => {
  const records: EntityRecord[] = [{ id: 7, appointmentDate: "2026-01-01", customerName: "Yossi Cohen", confirmed: null }];
  const icsA = buildCalendarFeedIcs(entity, records, "projA");
  const icsB = buildCalendarFeedIcs(entity, records, "projB");
  assert.match(icsA!, /UID:Appointment-7@projA\.forge-ai/);
  assert.match(icsB!, /UID:Appointment-7@projB\.forge-ai/);
});

test("buildCalendarFeedIcs skips a record with a missing or unparseable date value instead of emitting a broken VEVENT", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: null, customerName: "No date", confirmed: null },
    { id: 2, appointmentDate: "not-a-date", customerName: "Bad date", confirmed: null },
    { id: 3, appointmentDate: "2026-05-01", customerName: "Good date", confirmed: null },
  ];
  const ics = buildCalendarFeedIcs(entity, records, "proj1");
  const events = parseEvents(ics!);
  assert.equal(events.length, 1);
  assert.match(events[0], /SUMMARY:Good date/);
});

test("buildCalendarFeedIcs spans DTEND through a record's own end-date field (one day after it, RFC 5545's exclusive end), matching the domain library's Rental entity", () => {
  const records: EntityRecord[] = [{ id: 1, itemName: "Tent", startDate: "2026-07-01", endDate: "2026-07-05" }];
  const ics = buildCalendarFeedIcs(rentalEntity, records, "proj1");
  const events = parseEvents(ics!);
  assert.equal(events.length, 1);
  assert.match(events[0], /DTSTART;VALUE=DATE:20260701/);
  assert.match(events[0], /DTEND;VALUE=DATE:20260706/, "DTEND must be one day after the end field's own date, not the end date itself");
});

test("findDateField/findEndDateField auto-detect the same way the client-side export does -- a named hint wins, then falls back to the first date field", () => {
  assert.equal(findDateField(entity.fields)?.name, "appointmentDate");
  assert.equal(findDateField([nameField]), null, "an entity with no date field at all returns null");
  assert.equal(findEndDateField(rentalEntity.fields, startDateField)?.name, "endDate");
  assert.equal(findEndDateField(entity.fields, dateField), null, "an entity with no end-date-shaped sibling field returns null");
});
