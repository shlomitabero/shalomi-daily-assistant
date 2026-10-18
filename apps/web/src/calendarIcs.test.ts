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

/**
 * Round 686: the same orderedFields convention rounds 615/621/670/678/684
 * already enforce across EntityPanel.tsx's whole-record render paths
 * (CSV export, print, the Columns menu, board cards, the record form, the
 * bulk-edit/filter/group-by pickers) never reached this module at all --
 * descriptionFields read entity.fields directly, so a reordered column
 * ("courier" dragged before "notes") still listed DESCRIPTION lines in the
 * entity's original declared order, the same bug this routine has already
 * fixed five times elsewhere. The default (omitting the new 9th argument)
 * must still read entity.fields, exactly as every call above does.
 */
test("buildCalendarIcs's DESCRIPTION lines follow the user's drag-reordered column order when given one, and entity.fields's own order when not", () => {
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: "First visit", courierId: 42 },
  ];
  const courierEntity: Entity = { name: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const relatedRecords = { Courier: [{ id: 42, name: "Avi Mizrahi" }] };

  const unordered = buildCalendarIcs(entity, dateField, nameField, records, [courierEntity], relatedRecords);
  const unorderedDesc = parseEvents(unordered)[0].match(/DESCRIPTION:.*/)![0];
  assert.ok(
    unorderedDesc.indexOf("הערות") < unorderedDesc.indexOf("שליח"),
    "with no orderedFields argument, DESCRIPTION must still follow entity.fields's own declared order (notes before courier)",
  );

  const reordered = [courierField, dateField, nameField, notesField];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [courierEntity], relatedRecords, new Date(), null, reordered);
  const desc = parseEvents(ics)[0].match(/DESCRIPTION:.*/)![0];
  assert.ok(
    desc.indexOf("שליח") < desc.indexOf("הערות"),
    `DESCRIPTION must list the reordered fields (courier before notes), got: ${desc}`,
  );
});

/**
 * Regression test for a real bug found by round 636's Explore survey: the
 * same label-collision gap round 635 fixed in twin.ts's Business Twin
 * observations, but never checked anywhere else. Only field.name is unique
 * on an entity (FieldSchema/EntitySchema never enforce label uniqueness),
 * so two fields can legally share a label via the field-label rename route
 * -- here, two number fields on the same entity both renamed to "Amount".
 * Before this fix, DESCRIPTION showed two identical-looking "Amount: ..."
 * lines with no way to tell which was which once opened in a real
 * calendar app.
 */
test("buildCalendarIcs disambiguates two description fields that share a label", () => {
  const subtotalField: Field = { name: "subtotal", label: "Amount", type: "number", required: true };
  const shippingField: Field = { name: "shipping", label: "Amount", type: "number", required: true };
  const orderEntity: Entity = {
    name: "Order",
    label: "Orders",
    fields: [dateField, nameField, subtotalField, shippingField],
  };
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", subtotal: 800, shipping: 30 },
  ];
  const ics = buildCalendarIcs(orderEntity, dateField, nameField, records, [], {});
  assert.match(ics, /Amount \(subtotal\): 800/, "the subtotal field must be disambiguated by its own name");
  assert.match(ics, /Amount \(shipping\): 30/, "the shipping field must be disambiguated by its own name");
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

test("buildCalendarIcs spans DTEND through a record's own end-date field (one day after it, RFC 5545's exclusive end), matching the domain library's Rental entity", () => {
  const records: EntityRecord[] = [{ id: 1, itemName: "Drill", startDate: "2026-03-10", endDate: "2026-03-12" }];
  const ics = buildCalendarIcs(rentalEntity, startDateField, itemNameField, records, [], {}, new Date(), endDateField);
  const events = parseEvents(ics);
  assert.equal(events.length, 1);
  assert.match(events[0], /DTSTART;VALUE=DATE:20260310/);
  assert.match(events[0], /DTEND;VALUE=DATE:20260313/, "a 3-day rental's DTEND must be the day after its real end date, not start+1");
});

test("buildCalendarIcs falls back to the previous single-day-plus-one DTEND when the end-date field is missing", () => {
  const records: EntityRecord[] = [{ id: 1, itemName: "Ladder", startDate: "2026-03-10", endDate: null }];
  const ics = buildCalendarIcs(rentalEntity, startDateField, itemNameField, records, [], {}, new Date(), endDateField);
  const events = parseEvents(ics);
  assert.match(events[0], /DTEND;VALUE=DATE:20260311/);
});

test("buildCalendarIcs falls back to the previous single-day-plus-one DTEND when the end-date field is before the start date (an invalid range)", () => {
  const records: EntityRecord[] = [{ id: 1, itemName: "Bad range", startDate: "2026-03-10", endDate: "2026-03-01" }];
  const ics = buildCalendarIcs(rentalEntity, startDateField, itemNameField, records, [], {}, new Date(), endDateField);
  const events = parseEvents(ics);
  assert.match(events[0], /DTEND;VALUE=DATE:20260311/);
});

test("buildCalendarIcs excludes the end-date field itself from DESCRIPTION, same as the date and label fields", () => {
  const records: EntityRecord[] = [{ id: 1, itemName: "Drill", startDate: "2026-03-10", endDate: "2026-03-12" }];
  const ics = buildCalendarIcs(rentalEntity, startDateField, itemNameField, records, [], {}, new Date(), endDateField);
  assert.doesNotMatch(ics, /תאריך סיום:/, "the end-date field is already DTEND, it must never also appear in DESCRIPTION");
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
 * Round 589: entity.name is exactly as unbounded and AI/spec-controlled as
 * entity.label already is in PRODID (EntitySchema.name has no character
 * restriction actually enforced), but unlike PRODID/SUMMARY/DESCRIPTION,
 * the UID line interpolated it with no icsEscapeText call at all -- an
 * entity name containing a semicolon, comma, backslash, or embedded
 * newline reached the UID content line raw, breaking RFC 5545's content-
 * line structure (a bare newline splits one UID line into two with no
 * continuation marker) instead of being escaped like every other
 * unbounded TEXT value this function emits.
 */
test("buildCalendarIcs escapes an entity name containing RFC-5545-significant characters in UID, same as PRODID/SUMMARY/DESCRIPTION", () => {
  const unsafeEntity: Entity = { ...entity, name: "Weird;Name,With\\Chars" };
  const records: EntityRecord[] = [
    { id: 3, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: null, courierId: null },
  ];
  const ics = buildCalendarIcs(unsafeEntity, dateField, nameField, records, [], {});
  assert.match(ics, /UID:Weird\\;Name\\,With\\\\Chars-3@forge-ai/);
  assert.doesNotMatch(ics, /UID:Weird;Name,With\\Chars-3@forge-ai/, "the raw unescaped name must never reach the UID line");
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

test("buildCalendarIcs resolves a file field to just its filename in DESCRIPTION, not the raw JSON descriptor it's actually stored as", () => {
  const photoField: Field = { name: "photo", label: "תמונה", type: "file", required: false };
  const photoEntity: Entity = { name: "Appointment", label: "תור", fields: [dateField, nameField, photoField] };
  const fileValue = JSON.stringify({ url: "/api/uploads/p1/Appointment/abc.jpg", name: "receipt.jpg", size: 2048, mimeType: "image/jpeg" });
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", photo: fileValue },
    { id: 2, appointmentDate: "2026-03-16", customerName: "Yossi Cohen", photo: null },
  ];
  const ics = buildCalendarIcs(photoEntity, dateField, nameField, records, [], {});
  const events = parseEvents(ics);
  assert.match(events[0]!, /תמונה: receipt\.jpg/, "a set file field must render just the filename, not the raw JSON descriptor");
  assert.doesNotMatch(ics, /api\/uploads/, "the server's own internal upload URL path must never leak into an exported calendar file");
  assert.doesNotMatch(events[1]!, /תמונה/, "an unset file field must produce no description line at all, same as any other empty field");
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

test("buildCalendarIcs folds a long DESCRIPTION line at 75 UTF-8 octets with a CRLF + single leading space continuation", () => {
  const longNote = "x".repeat(120);
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: longNote, courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  const lines = ics.split("\r\n");
  const descriptionLineIndex = lines.findIndex((l) => l.startsWith("DESCRIPTION:"));
  assert.ok(descriptionLineIndex >= 0);
  // Asserting real UTF-8 byte length (not .length, which is only equal to
  // byte length for pure-ASCII content like this test's) -- the Hebrew
  // test right below this one is where that distinction actually bites.
  const firstLineBytes = new TextEncoder().encode(lines[descriptionLineIndex]).length;
  assert.ok(firstLineBytes <= 75, `folded first line must be <=75 UTF-8 octets, was ${firstLineBytes}`);
  assert.ok(lines[descriptionLineIndex + 1].startsWith(" "), "a folded continuation line must start with a single leading space");
});

/**
 * Regression test for round 430: RFC 5545 §3.1's 75-octet fold limit
 * counts bytes of the UTF-8 encoding, not JS string length (UTF-16 code
 * units). A Hebrew character is 1 UTF-16 unit but 2 UTF-8 bytes, so the
 * original character-counting foldIcsLine let a Hebrew DESCRIPTION line
 * well over 75 real bytes pass through completely unfolded -- its
 * *character* count alone looked compliant -- defeating line-folding for
 * exactly the content this Hebrew-primary app actually generates.
 */
test("buildCalendarIcs folds a Hebrew DESCRIPTION line by real UTF-8 byte count, not character count", () => {
  const hebrewNote = "לקוח חדש הגיע למשרד וביקש הצעת מחיר מפורטת לפרויקט שיפוץ גדול בבית פרטי";
  assert.ok(hebrewNote.length < 75, "sanity check: this note's character count alone looks compliant with the old (wrong) check");
  assert.ok(
    new TextEncoder().encode(hebrewNote).length > 75,
    "sanity check: its real UTF-8 byte count is NOT compliant -- this is the actual RFC 5545 limit",
  );

  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", notes: hebrewNote, courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  const lines = ics.split("\r\n");
  const descriptionLineIndex = lines.findIndex((l) => l.startsWith("DESCRIPTION:"));
  assert.ok(descriptionLineIndex >= 0);

  const descriptionPhysicalLines = [lines[descriptionLineIndex]];
  let i = descriptionLineIndex;
  while (lines[i + 1]?.startsWith(" ")) {
    i += 1;
    descriptionPhysicalLines.push(lines[i]);
  }
  assert.ok(
    descriptionPhysicalLines.length > 1,
    "a Hebrew line this long in real bytes must actually be folded into more than one physical line",
  );
  for (const line of descriptionPhysicalLines) {
    const byteLength = new TextEncoder().encode(line).length;
    assert.ok(byteLength <= 75, `every folded physical line must be <=75 UTF-8 octets, was ${byteLength}: ${JSON.stringify(line)}`);
  }
});

/**
 * Regression test for round 551's finding: PRODID's own content
 * (entity.label) is exactly as unbounded as UID/SUMMARY/DESCRIPTION, which
 * all already go through foldIcsLine -- but PRODID itself was pushed raw,
 * so a long entity label produced an over-75-byte PRODID line a strict
 * RFC 5545 parser could reject, the same failure mode foldIcsLine exists
 * everywhere else in this function to prevent.
 */
test("buildCalendarIcs folds a long PRODID line the same way it folds DESCRIPTION", () => {
  const longLabel = "לקוח ".repeat(30);
  assert.ok(
    new TextEncoder().encode(`PRODID:-//Forge AI//${longLabel}//EN`).length > 75,
    "sanity check: this label makes the raw PRODID line exceed 75 UTF-8 octets",
  );
  const longEntity: Entity = { ...entity, label: longLabel };
  const ics = buildCalendarIcs(longEntity, dateField, nameField, [], [], {});
  const lines = ics.split("\r\n");
  const prodidLineIndex = lines.findIndex((l) => l.startsWith("PRODID:"));
  assert.ok(prodidLineIndex >= 0);

  const prodidPhysicalLines = [lines[prodidLineIndex]];
  let i = prodidLineIndex;
  while (lines[i + 1]?.startsWith(" ")) {
    i += 1;
    prodidPhysicalLines.push(lines[i]);
  }
  assert.ok(prodidPhysicalLines.length > 1, "a PRODID line this long in real bytes must actually be folded into more than one physical line");
  for (const line of prodidPhysicalLines) {
    const byteLength = new TextEncoder().encode(line).length;
    assert.ok(byteLength <= 75, `every folded PRODID physical line must be <=75 UTF-8 octets, was ${byteLength}: ${JSON.stringify(line)}`);
  }
});
