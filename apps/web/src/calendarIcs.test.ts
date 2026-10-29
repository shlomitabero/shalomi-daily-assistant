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
  // projectId defaults to "" when omitted (as here) -- round 936's own
  // project-scoping test below covers passing a real one.
  assert.match(ics, /UID:Appointment-7@\.forge-ai/);
});

/**
 * Round 936: entity.name+record.id alone is only unique *within* one
 * project -- record ids restart from 1 per entity per project
 * (insertRecord's own auto-increment), and entity names routinely repeat
 * across unrelated projects (this app's own domain-library templates
 * generate common names like "Booking"/"Appointment"/"Order"). RFC 5545
 * requires UID to be unique across every calendar it's imported into,
 * and every mainstream calendar client treats importing an already-seen
 * UID as an UPDATE of that existing event, not a new one -- so exporting
 * two different projects' same-named entity's record #1 into the same
 * real calendar app would silently overwrite one project's event with
 * the other's, with no error anywhere. Confirms the UID now also
 * includes projectId, so the identical entity+record id from two
 * different projects produces two genuinely distinct UIDs.
 */
test("buildCalendarIcs's UID also scopes by projectId, so the same entity+record id from two different projects never collides", () => {
  const records: EntityRecord[] = [
    { id: 7, appointmentDate: "2026-01-01", customerName: "Yossi Cohen", notes: null, courierId: null },
  ];
  const icsA = buildCalendarIcs(entity, dateField, nameField, records, [], {}, new Date(), null, undefined, "en", "projA");
  const icsB = buildCalendarIcs(entity, dateField, nameField, records, [], {}, new Date(), null, undefined, "en", "projB");

  assert.match(icsA, /UID:Appointment-7@projA\.forge-ai/);
  assert.match(icsB, /UID:Appointment-7@projB\.forge-ai/);
  const uidA = icsA.match(/UID:[^\r\n]+/)?.[0];
  const uidB = icsB.match(/UID:[^\r\n]+/)?.[0];
  assert.notEqual(uidA, uidB, "the identical entity+record id from two different projects must produce two genuinely distinct UIDs");
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
  assert.match(ics, /UID:Weird\\;Name\\,With\\\\Chars-3@\.forge-ai/);
  assert.doesNotMatch(ics, /UID:Weird;Name,With\\Chars-3@\.forge-ai/, "the raw unescaped name must never reach the UID line");
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

test("buildCalendarIcs renders a boolean field in DESCRIPTION as uppercase TRUE/FALSE, matching this app's own CSV export and automation-message convention", () => {
  const confirmedField: Field = { name: "confirmed", label: "מאושר", type: "boolean", required: false };
  const confirmedEntity: Entity = { name: "Appointment", label: "תור", fields: [dateField, nameField, confirmedField] };
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", confirmed: true },
    { id: 2, appointmentDate: "2026-03-16", customerName: "Yossi Cohen", confirmed: false },
  ];
  const ics = buildCalendarIcs(confirmedEntity, dateField, nameField, records, [], {});
  const events = parseEvents(ics);
  assert.match(events[0]!, /מאושר: TRUE/, "a true boolean field must render uppercase TRUE, not JS's own lowercase \"true\"");
  assert.match(events[1]!, /מאושר: FALSE/, "a false boolean field must still produce a description line (false is a real, meaningful value here, not an empty one) rendering uppercase FALSE, not JS's own lowercase \"false\"");
});

/**
 * Round 1141: every sibling branch in this exact ternary (relation, enum,
 * file, date, number) correctly propagates a real stored `null` -- a
 * never-answered field, reachable via migrate.ts's additive refine (round
 * 1134) -- through to the `if (value === null ...) return null;` filter
 * right below, so the line is omitted. Only the boolean branch did
 * `record[f.name] ? "TRUE" : "FALSE"` with no null-check first, so a
 * never-answered boolean (real `null`) fell through as JS's own
 * falsy-coercion to the literal string "FALSE" -- a real, silently WRONG
 * calendar description line, not an honestly-omitted one, and the exact
 * opposite of this null-safe boolean's own on-screen EntityPanel treatment
 * (round 1134's own `Boolean(r[fieldName])` filter fix).
 */
test("buildCalendarIcs omits a never-answered (null) boolean field from DESCRIPTION, instead of rendering a false 'FALSE' line", () => {
  const confirmedField: Field = { name: "confirmed", label: "מאושר", type: "boolean", required: false };
  const confirmedEntity: Entity = { name: "Appointment", label: "תור", fields: [dateField, nameField, confirmedField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", confirmed: null }];
  const ics = buildCalendarIcs(confirmedEntity, dateField, nameField, records, [], {});
  const events = parseEvents(ics);
  assert.doesNotMatch(events[0]!, /מאושר/, "a never-answered boolean must be omitted entirely, not rendered as a false 'FALSE' line");
});

/**
 * Round 763: a number/date field in DESCRIPTION fell through to the raw
 * stored value -- unlike relation/enum/file/boolean, each already given
 * their own branch in an earlier round. apps/api/src/automations.ts's own
 * interpolateTemplate locale-formats these same two types for a WhatsApp
 * message referencing the same field, explicitly reasoning that the CSV-
 * export rationale for leaving them raw (an exact round-trip through
 * buildImportRecords' re-parse) doesn't apply to a one-way export -- this
 * .ics export is exactly as one-way, so it now follows the same
 * convention, using the real `lang` passed through from the caller.
 */
test("buildCalendarIcs locale-formats a number/date field in DESCRIPTION, not the raw stored value", () => {
  const budgetField: Field = { name: "budget", label: "תקציב", type: "number", required: false };
  const deadlineField: Field = { name: "deadline", label: "מועד", type: "date", required: false };
  const projectEntity: Entity = { name: "Project", label: "פרויקט", fields: [dateField, nameField, budgetField, deadlineField] };
  const records: EntityRecord[] = [
    { id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", budget: 50000, deadline: "2026-04-01" },
  ];
  const ics = buildCalendarIcs(projectEntity, dateField, nameField, records, [], {}, new Date(), null, projectEntity.fields, "he");
  const events = parseEvents(ics);
  assert.match(
    events[0]!,
    /תקציב: 50\\,000/,
    "a number field must render locale-formatted with a thousands separator (escaped per RFC 5545's own comma rule), not the raw \"50000\"",
  );
  assert.match(events[0]!, /מועד: 1\.4\.2026/, "a date field (other than the primary one) must render locale-formatted, not the raw \"2026-04-01\"");
});

/**
 * Round 1090: V8/ICU's "he-IL" locale silently prepends a real, invisible
 * U+200E LEFT-TO-RIGHT MARK before the minus sign of any negative number
 * -- confirmed directly via Node (`(-1234.5).toLocaleString("he-IL")`
 * embeds it, the identical "en-US" call doesn't). A number field has no
 * positivity constraint (a balance/discount/profit-loss field can be
 * genuinely negative), and this .ics file is downloaded/subscribed-to by
 * a real calendar app -- no bidi-rendering context left to protect once
 * it leaves this app, the same gap round 1089 already fixed in
 * automations.ts's interpolateTemplate.
 */
test("buildCalendarIcs strips the invisible bidi mark toLocaleString adds before a negative number field's minus sign under 'he'", () => {
  const balanceField: Field = { name: "balance", label: "יתרה", type: "number", required: false };
  const projectEntity: Entity = { name: "Project", label: "פרויקט", fields: [dateField, nameField, balanceField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", customerName: "Dana Levi", balance: -150 }];
  const ics = buildCalendarIcs(projectEntity, dateField, nameField, records, [], {}, new Date(), null, projectEntity.fields, "he");
  const events = parseEvents(ics);
  assert.match(events[0]!, /יתרה: -150/, "a negative number field must render with a plain minus sign, no invisible character before it");
  assert.ok(!events[0]!.includes("‎") && !events[0]!.includes("‏"), "the DESCRIPTION line must contain no invisible bidi mark at all");
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

/**
 * Round 778: same gap, the other type the enum fix above never covered --
 * a `boolean` display field (reachable the same way round 771 found for
 * recordDisplayLabel: an entity with no name/title/text field whose
 * fallback lands on a boolean, e.g. `CheckIn { date: date, confirmed:
 * boolean }`) previously printed the raw stored value, lowercase
 * "true"/"false", instead of this codebase's own uniform "TRUE"/"FALSE"
 * convention every other boolean render path already follows.
 */
test("buildCalendarIcs resolves a boolean label field to uppercase TRUE/FALSE in SUMMARY, not lowercase true/false", () => {
  const confirmedField: Field = { name: "confirmed", label: "אישור", type: "boolean", required: false };
  const checkInEntity: Entity = { name: "CheckIn", label: "צ'ק אין", fields: [dateField, confirmedField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", confirmed: false }];
  const ics = buildCalendarIcs(checkInEntity, dateField, confirmedField, records, [], {});
  assert.match(ics, /SUMMARY:FALSE/, "a boolean false value must render as uppercase FALSE, and must not fall back to the entity's own name");
  assert.doesNotMatch(ics, /SUMMARY:false/, "must never leak the raw lowercase boolean value");
});

/**
 * Round 1048: same gap as the boolean/enum fixes above, for the one type
 * calendarChipLabelField's own last-resort fallback can equally land on --
 * a second `date` field (reachable the same way: an entity with two+ date
 * fields and no name/title/text/longtext field, e.g. Flight{ departureDate,
 * returnDate, confirmed: boolean }). Before this round, the raw stored
 * "YYYY-MM-DD" string leaked straight into SUMMARY unformatted.
 */
test("buildCalendarIcs resolves a date label field to a formatted date in SUMMARY, not the raw 'YYYY-MM-DD' string", () => {
  const returnDateField: Field = { name: "returnDate", label: "תאריך חזרה", type: "date", required: false };
  const flightEntity: Entity = { name: "Flight", label: "טיסה", fields: [dateField, returnDateField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", returnDate: "2026-04-02" }];
  const ics = buildCalendarIcs(flightEntity, dateField, returnDateField, records, [], {}, new Date(), null, undefined, "en");
  assert.match(ics, /SUMMARY:4\/2\/2026/, "a date label field must render as a formatted date (en locale), not the raw ISO string");
  assert.doesNotMatch(ics, /SUMMARY:2026-04-02/, "must never leak the raw unformatted 'YYYY-MM-DD' string");
});

/**
 * Round 1229: same gap as the boolean/enum/date fixes above, for the one
 * remaining type calendarChipLabelField's own last-resort fallback can
 * equally land on -- a `number` field (reachable the same way: an entity
 * with no name/title/text/longtext/enum/boolean/date field, only a
 * number and a date, e.g. DailyLog { loggedAt: date, temperature: number }).
 * Before this round, the raw un-grouped digits leaked straight into
 * SUMMARY unformatted.
 */
test("buildCalendarIcs resolves a number label field to a locale-formatted number in SUMMARY, not the raw ungrouped digits", () => {
  const temperatureField: Field = { name: "temperature", label: "טמפרטורה", type: "number", required: false };
  const dailyLogEntity: Entity = { name: "DailyLog", label: "יומן", fields: [dateField, temperatureField] };
  const records: EntityRecord[] = [{ id: 1, appointmentDate: "2026-03-15", temperature: 1500 }];
  const ics = buildCalendarIcs(dailyLogEntity, dateField, temperatureField, records, [], {}, new Date(), null, undefined, "en");
  assert.match(ics, /SUMMARY:1\\,500/, "a number label field must render with real locale thousands separators (RFC 5545 escapes the comma as \\,)");
  assert.doesNotMatch(ics, /SUMMARY:1500\r?\n/, "must never leak the raw ungrouped digits with no thousands separator");
});

/**
 * Round 1022: `??` only falls through on null/undefined, never on a
 * genuinely blank string -- a text display field left empty on one
 * record (pickDisplayField never requires one to be `required: true`)
 * used to produce a literally blank SUMMARY line, while the live
 * subscription feed's own identical computation (calendarFeed.ts) used
 * `||` and fell back to entity.label/entity.name for the exact same
 * case -- two calendar-export surfaces disagreeing on what title the
 * same record gets. Confirms this now falls back to `#<id>` instead,
 * the one established "no usable label" convention recordDisplayLabel
 * already uses everywhere else (and that a genuinely non-empty label
 * is completely unaffected).
 */
test("buildCalendarIcs falls back to #<id> in SUMMARY when the label field's own value is a blank string, not to the entity's name", () => {
  const records: EntityRecord[] = [
    { id: 42, appointmentDate: "2026-03-15", customerName: "", notes: null, courierId: null },
  ];
  const ics = buildCalendarIcs(entity, dateField, nameField, records, [], {});
  assert.match(ics, /SUMMARY:#42/, "a blank label must fall back to #<id>, the app's own established convention, not entity.label/entity.name");
  assert.doesNotMatch(ics, /SUMMARY:תור/, "must never fall back to the entity's own label for a genuinely blank field value");
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
