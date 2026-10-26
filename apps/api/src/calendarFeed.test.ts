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

/** Undoes RFC 5545 §3.1 line folding (a CRLF + single leading space continuation) so a long DESCRIPTION's own folded line breaks don't accidentally split a substring a test is matching against. */
function unfold(icsEvent: string): string {
  return icsEvent.replace(/\r\n /g, "");
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

/**
 * Round 1022: the live preview's own identical computation (calendarIcs.ts,
 * the one-shot "Export ICS" button) used `??`, which only falls through on
 * null/undefined, never a genuinely blank string -- so a blank display
 * field produced a literally blank SUMMARY there, while this feed's own
 * `||` fell back to entity.label/entity.name for the exact same case: two
 * calendar-export surfaces disagreeing on what title the same record
 * gets. Confirms this now falls back to `#<id>` instead, the one
 * established "no usable label" convention this app uses everywhere else
 * (recordDisplayLabel/displayField.ts), matching calendarIcs.ts's own
 * identical fix.
 */
test("buildCalendarFeedIcs falls back to #<id> in SUMMARY when the display field's own value is a blank string, not to the entity's name", () => {
  const records: EntityRecord[] = [{ id: 42, appointmentDate: "2026-03-15", customerName: "", confirmed: true }];
  const ics = buildCalendarFeedIcs(entity, records, "proj1");
  assert.ok(ics);
  assert.match(ics!, /SUMMARY:#42/, "a blank label must fall back to #<id>, the app's own established convention, not entity.label/entity.name");
  assert.doesNotMatch(ics!, /SUMMARY:תור/, "must never fall back to the entity's own label for a genuinely blank field value");
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

/**
 * Round 1034: DESCRIPTION parity with the one-shot export (calendarIcs.ts's
 * buildCalendarIcs). Before this round the live feed's own VEVENTs carried
 * only SUMMARY/DTSTART/DTEND -- every one of these tests would have found
 * no DESCRIPTION line at all against the pre-round-1034 implementation.
 */

const statusField: Field = {
  name: "status",
  label: "סטטוס",
  type: "enum",
  required: true,
  enumValues: ["confirmed", "cancelled"],
  enumLabels: { confirmed: "מאושר", cancelled: "מבוטל" },
};
const amountField: Field = { name: "amount", label: "סכום", type: "number", required: false };
const receiptField: Field = { name: "receipt", label: "קבלה", type: "file", required: false };
const customerField: Field = { name: "customerId", label: "לקוח", type: "relation", relationTo: "Customer", required: false };

const richEntity: Entity = {
  name: "Appointment",
  label: "תור",
  fields: [dateField, nameField, confirmedField, statusField, amountField, receiptField, customerField],
};

const customerEntity: Entity = {
  name: "Customer",
  label: "לקוח",
  fields: [{ name: "fullName", label: "שם מלא", type: "text", required: true }],
};

function makeFileValue(name: string): string {
  return JSON.stringify({ url: `/api/uploads/proj1/Appointment/${name}`, name, size: 100, mimeType: "application/pdf" });
}

test("buildCalendarFeedIcs's DESCRIPTION resolves enum/boolean/file/number fields, mirroring calendarIcs.ts's own branches", () => {
  const records: EntityRecord[] = [
    {
      id: 1,
      appointmentDate: "2026-03-15",
      customerName: "Dana Levi",
      confirmed: true,
      status: "confirmed",
      amount: 1500,
      receipt: makeFileValue("invoice.pdf"),
    },
  ];
  const ics = buildCalendarFeedIcs(richEntity, records, "proj1");
  const events = parseEvents(ics!).map(unfold);
  assert.equal(events.length, 1);
  assert.match(events[0], /DESCRIPTION:/, "a record with non-empty description fields must get a DESCRIPTION line");
  assert.match(events[0], /אישור: TRUE/, "boolean must render as the app's uppercase TRUE, not the raw lowercase JS value");
  assert.match(events[0], /סטטוס: מאושר/, "enum must render its translated enumLabel, not the raw stored key");
  assert.match(events[0], /סכום: 1\\,500/, "number must render through locale-formatted thousands separators (en default); RFC 5545 escapes the literal comma as \\, (icsEscapeText)");
  assert.match(events[0], /קבלה: invoice\.pdf/, "file must render just the filename, never the raw JSON upload descriptor");
});

test("buildCalendarFeedIcs's DESCRIPTION resolves a relation field to its related record's display label when allEntities/relatedRecords are supplied", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", confirmed: null, customerId: 9 },
  ];
  const customerRecords: EntityRecord[] = [{ id: 9, fullName: "Yossi Cohen" }];
  const ics = buildCalendarFeedIcs(richEntity, records, "proj1", new Date(), [richEntity, customerEntity], { Customer: customerRecords });
  const events = parseEvents(ics!);
  assert.match(events[0], /לקוח: Yossi Cohen/, "a relation field must resolve to the target record's own display label, not the raw foreign-key id");
});

test("buildCalendarFeedIcs's relation field degrades to #<id> when allEntities/relatedRecords aren't supplied, matching relationDisplayLabel's own degrade-gracefully contract", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", confirmed: null, customerId: 9 },
  ];
  const ics = buildCalendarFeedIcs(richEntity, records, "proj1");
  const events = parseEvents(ics!);
  assert.match(events[0], /לקוח: #9/, "with no relation data on hand, a relation field must degrade to its raw #<id>, not throw or disappear");
});

test("buildCalendarFeedIcs's DESCRIPTION disambiguates two description fields that share the same label with each field's own unique name, mirroring calendarIcs.ts's round-635 fix", () => {
  const amount2Field: Field = { name: "amount2", label: "סכום", type: "number", required: false };
  const collisionEntity: Entity = { name: "Appointment", label: "תור", fields: [dateField, nameField, amountField, amount2Field] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", amount: 100, amount2: 200 }];
  const ics = buildCalendarFeedIcs(collisionEntity, records, "proj1");
  const events = parseEvents(ics!);
  assert.match(events[0], /סכום \(amount\): 100/, "a field whose label collides with a sibling's must be disambiguated by its own unique name");
  assert.match(events[0], /סכום \(amount2\): 200/);
});

test("buildCalendarFeedIcs omits DESCRIPTION entirely when every non-date/label field is empty, matching the pre-round-1034 no-DESCRIPTION shape for that case", () => {
  // A boolean field is deliberately excluded from this fixture: mirroring
  // calendarIcs.ts's own identical boolean branch exactly, a boolean
  // description field always renders as TRUE/FALSE (record[f.name] ? ... :
  // "FALSE" is never itself null/undefined/""), so it alone could never
  // demonstrate the "every field blank -> no DESCRIPTION at all" case this
  // test is actually after -- a genuinely optional text field is.
  const notesField: Field = { name: "notes", label: "הערות", type: "text", required: false };
  const noNotesEntity: Entity = { name: "Appointment", label: "תור", fields: [dateField, nameField, notesField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: null }];
  const ics = buildCalendarFeedIcs(noNotesEntity, records, "proj1");
  const events = parseEvents(ics!);
  assert.doesNotMatch(events[0], /DESCRIPTION:/, "an entity whose only other field is blank/null must produce no DESCRIPTION line at all");
});

test("buildCalendarFeedIcs's DESCRIPTION date/number formatting honors the lang parameter, matching calendarIcs.ts's own he/en locale split", () => {
  // RFC 5545 escapes a literal comma as "\," (icsEscapeText) -- so a
  // thousands-separated "1,500" appears in the raw .ics text as "1\,500",
  // not "1,500" unescaped.
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", amount: 1500 }];
  const icsHe = buildCalendarFeedIcs(richEntity, records, "proj1", new Date(), [], {}, "he");
  const events = parseEvents(icsHe!);
  assert.match(events[0], /סכום: 1\\,500/, "he-IL's own thousands separator for this value happens to match en-US's, confirming the locale path itself runs without throwing");
});
