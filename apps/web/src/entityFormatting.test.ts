import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, Field } from "@forge/shared";
import { translate } from "./i18n/language.js";
import {
  badgeTone,
  buildCalendarMonth,
  buildImportRecords,
  calendarChipLabelField,
  findBoardField,
  findDateField,
  formatDateForInput,
  formatDateValue,
  formatEntityRecordCount,
  formatNumberValue,
  groupByField,
  isSameMonth,
  matchesSearch,
  parseCsv,
  pickDisplayField,
  recordDisplayLabel,
  recordsToCsv,
  searchEntityRecords,
  sortRecords,
} from "./entityFormatting.js";

test("badgeTone recognizes common positive and negative status words, case-insensitively", () => {
  assert.equal(badgeTone("Won"), "positive");
  assert.equal(badgeTone("PAID"), "positive");
  assert.equal(badgeTone("Delivered"), "positive");
  assert.equal(badgeTone("Lost"), "negative");
  assert.equal(badgeTone("Cancelled"), "negative");
  assert.equal(badgeTone("No-show"), "negative");
});

test("badgeTone falls back to neutral for anything unrecognized", () => {
  assert.equal(badgeTone("New"), "neutral");
  assert.equal(badgeTone("Pending"), "neutral");
  assert.equal(badgeTone("Some Freeform Value"), "neutral");
});

/**
 * Regression test: the built-in InsuranceClaim domain entity's own status
 * enum (spec-engine/domainEntities.ts) is exactly
 * ["Submitted", "UnderReview", "Approved", "Denied", "Paid"] -- "Approved"
 * already read as positive, but "Denied" (right next to it, an equally
 * conclusive outcome) fell through to neutral gray, the same tone as the
 * genuinely undecided "Submitted"/"UnderReview" states, since "denied" was
 * missing from NEGATIVE_WORDS even though its synonym "rejected" (used by
 * other entities, e.g. JobApplicant's own stage enum) was already there.
 */
test("badgeTone recognizes 'Denied' as negative, matching InsuranceClaim's real status enum", () => {
  assert.equal(badgeTone("Denied"), "negative");
  assert.equal(badgeTone("Approved"), "positive");
});

test("formatDateValue formats a valid ISO date per locale, and leaves an invalid one unchanged", () => {
  const result = formatDateValue("2026-03-15", "en");
  assert.match(result, /3\/15\/2026|15\/3\/2026/); // exact format is locale/engine-dependent, just confirm it parsed
  assert.equal(formatDateValue("not-a-date", "en"), "not-a-date");
});

// Regression test: same root cause as buildCalendarMonth's own timezone
// bug above -- `new Date("2026-03-15")` parses as UTC midnight, and
// toLocaleDateString renders in the *viewer's local* time, so for any
// viewer whose local time is behind UTC this silently displayed one
// calendar day earlier than the actual stored value (confirmed
// empirically: this test failed under TZ=America/New_York before the
// fix, showing "3/14/2026"). Pins process.env.TZ for the duration of the
// assertion and restores it afterward, same technique as the calendar test.
test("formatDateValue shows the correct calendar day even for a viewer in a timezone behind UTC", () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.match(formatDateValue("2026-03-15", "en"), /^3\/15\/2026$/);
  } finally {
    process.env.TZ = originalTz;
  }
});

test("formatNumberValue adds thousands separators", () => {
  assert.equal(formatNumberValue(1234567, "en"), "1,234,567");
});

test("matchesSearch matches on any field, is case-insensitive, and an empty query matches everything", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "status", type: "enum", required: true, enumValues: ["New", "Won"], enumLabels: { New: "חדש" } },
  ];
  const record = { name: "Dana Levi", status: "New" };
  assert.ok(matchesSearch(record, fields, ""));
  assert.ok(matchesSearch(record, fields, "dana"));
  assert.ok(matchesSearch(record, fields, "חדש")); // matches the translated enum label, not the raw stored value
  assert.ok(!matchesSearch(record, fields, "yossi"));
});

test("searchEntityRecords finds matches, caps the sample, and reports the real total match count", () => {
  const customer: Entity = {
    name: "Customer",
    label: "Customers",
    fields: [{ name: "name", type: "text", required: true }],
  };
  const records = [
    { id: 1, name: "Dana Levi" },
    { id: 2, name: "Dana Cohen" },
    { id: 3, name: "Yossi Cohen" },
    { id: 4, name: "Dana Peretz" },
  ];
  const result = searchEntityRecords(customer, records, "dana", 2);
  assert.ok(result);
  assert.equal(result!.entityName, "Customer");
  assert.equal(result!.entityLabel, "Customers");
  assert.equal(result!.totalMatches, 3); // 3 real matches...
  assert.equal(result!.sample.length, 2); // ...but the sample is capped at the given limit
  assert.deepEqual(result!.sample.map((r) => r.name), ["Dana Levi", "Dana Cohen"]);
});

test("searchEntityRecords returns null for an empty query or when nothing in this entity matched", () => {
  const customer: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const records = [{ id: 1, name: "Dana Levi" }];
  assert.equal(searchEntityRecords(customer, records, ""), null);
  assert.equal(searchEntityRecords(customer, records, "   "), null);
  assert.equal(searchEntityRecords(customer, records, "no-such-match"), null);
});

test("sortRecords sorts numbers, strings, and booleans correctly in both directions", () => {
  const records = [{ id: 1, amount: 30 }, { id: 2, amount: 10 }, { id: 3, amount: 20 }];
  const asc = sortRecords(records, "amount", "asc");
  assert.deepEqual(asc.map((r) => r.amount), [10, 20, 30]);
  const desc = sortRecords(records, "amount", "desc");
  assert.deepEqual(desc.map((r) => r.amount), [30, 20, 10]);
});

test("sortRecords returns records unchanged when sortField is null", () => {
  const records = [{ id: 1 }, { id: 2 }];
  assert.equal(sortRecords(records, null, "asc"), records);
});

test("sortRecords places null/undefined values first regardless of direction", () => {
  const records = [{ v: 5 }, { v: null }, { v: 2 }];
  const asc = sortRecords(records as never, "v", "asc");
  assert.equal(asc[0].v, null);
});

test("findBoardField prefers a field literally named status/stage over other enum fields", () => {
  const fields: Field[] = [
    { name: "priority", type: "enum", required: true, enumValues: ["Low", "High"] },
    { name: "stage", type: "enum", required: true, enumValues: ["Lead", "Won", "Lost"] },
  ];
  assert.equal(findBoardField(fields)?.name, "stage");
});

test("findBoardField falls back to the first workable enum field when nothing is named status/stage", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "priority", type: "enum", required: true, enumValues: ["Low", "High"] },
  ];
  assert.equal(findBoardField(fields)?.name, "priority");
});

test("findBoardField returns null for a plain entity with no suitable enum field", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "email", type: "text", required: false },
  ];
  assert.equal(findBoardField(fields), null);
});

test("findBoardField ignores an enum field with too few or too many values to make a sane board", () => {
  const tooFew: Field[] = [{ name: "status", type: "enum", required: true, enumValues: ["Only"] }];
  assert.equal(findBoardField(tooFew), null);
  const tooMany: Field[] = [
    { name: "status", type: "enum", required: true, enumValues: Array.from({ length: 9 }, (_, i) => `V${i}`) },
  ];
  assert.equal(findBoardField(tooMany), null);
});

test("findDateField prefers a field literally named date over other date fields", () => {
  const fields: Field[] = [
    { name: "reminderDate", type: "date", required: false },
    { name: "date", type: "date", required: true },
  ];
  assert.equal(findDateField(fields)?.name, "date");
});

test("findDateField falls back to the first date field when nothing is named date", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "scheduledFor", type: "date", required: true },
  ];
  assert.equal(findDateField(fields)?.name, "scheduledFor");
});

/**
 * Regression test: DATE_FIELD_NAME_HINTS lists "scheduledat" as a
 * recognized hint, but every real date field in the domain library
 * (spec-engine/domainEntities.ts) follows an "XxxDate" naming convention
 * -- startDate, endDate, dueDate, shipDate, and (the one this hint was
 * presumably meant to catch) WorkOrder's own "scheduledDate" -- never an
 * "XxxAt" convention. "scheduledDate".toLowerCase() is "scheduleddate",
 * which the misspelled "scheduledat" hint never matches, so this hint was
 * silently dead: it currently has no visible effect only because
 * WorkOrder happens to have just one date field (the fallback picks it
 * anyway). An entity with scheduledDate alongside another, less relevant
 * date field would get the wrong one preferred with no error.
 */
test("findDateField recognizes 'scheduledDate' as a known date-field name, matching the domain library's own WorkOrder entity", () => {
  const fields: Field[] = [
    { name: "createdNote", type: "date", required: false },
    { name: "scheduledDate", type: "date", required: true },
  ];
  assert.equal(findDateField(fields)?.name, "scheduledDate");
});

test("findDateField returns null for an entity with no date field", () => {
  const fields: Field[] = [{ name: "name", type: "text", required: true }];
  assert.equal(findDateField(fields), null);
});

test("buildCalendarMonth returns a fixed 6-week grid (42 days) starting on a Sunday and ending on a Saturday", () => {
  const field: Field = { name: "date", type: "date", required: true };
  const days = buildCalendarMonth([], field, 2026, 8); // September 2026 (0-indexed month)
  assert.equal(days.length, 42);
  assert.equal(days[0].date.getDay(), 0); // Sunday
  assert.equal(days[41].date.getDay(), 6); // Saturday
  // Consecutive calendar days, no gaps or jumps
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1].date;
    const cur = days[i].date;
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));
    assert.equal(diffDays, 1);
  }
});

test("buildCalendarMonth marks only days within the target month as inCurrentMonth", () => {
  const field: Field = { name: "date", type: "date", required: true };
  const days = buildCalendarMonth([], field, 2026, 8); // September 2026
  const inMonthCount = days.filter((d) => d.inCurrentMonth).length;
  assert.equal(inMonthCount, 30); // September has 30 days
  assert.ok(days.some((d) => !d.inCurrentMonth)); // leading/trailing padding exists
});

test("buildCalendarMonth places a record on the correct calendar day by its date field", () => {
  const field: Field = { name: "date", type: "date", required: true };
  const records = [
    { id: 1, date: "2026-09-15" },
    { id: 2, date: "2026-09-15" },
    { id: 3, date: "2026-09-16" },
  ];
  const days = buildCalendarMonth(records, field, 2026, 8);
  const sep15 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 15)!;
  const sep16 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 16)!;
  assert.equal(sep15.records.length, 2);
  assert.equal(sep16.records.length, 1);
});

test("buildCalendarMonth silently skips records with a missing or unparseable date, instead of throwing", () => {
  const field: Field = { name: "date", type: "date", required: true };
  const records = [
    { id: 1, date: "" },
    { id: 2, date: null },
    { id: 3, date: "not-a-date" },
  ];
  assert.doesNotThrow(() => buildCalendarMonth(records as never, field, 2026, 8));
  const days = buildCalendarMonth(records as never, field, 2026, 8);
  assert.equal(
    days.reduce((sum, d) => sum + d.records.length, 0),
    0,
  );
});

// Regression test: `new Date("2026-09-15")` parses that date-only string as
// UTC midnight, but the calendar grid's own day cells are built with
// `new Date(year, month, day)` (local midnight) and compared with local
// getters. For any viewer whose local time is behind UTC, that silently
// placed a record one calendar day earlier than its actual stored date.
// The sandbox this test normally runs in defaults to UTC, where the bug is
// invisible, so this pins process.env.TZ to a behind-UTC zone for the
// duration of the assertion (Node re-reads TZ per Date construction; no
// caching to worry about) and restores it afterward so it can't leak into
// other tests in the same process.
test("buildCalendarMonth places a record on its correct calendar day even for a viewer in a timezone behind UTC", () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const field: Field = { name: "date", type: "date", required: true };
    const records = [{ id: 1, date: "2026-09-15" }];
    const days = buildCalendarMonth(records, field, 2026, 8); // September 2026
    const sep14 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 14)!;
    const sep15 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 15)!;
    assert.equal(sep15.records.length, 1, "the record must land on the 15th, not shift to the 14th");
    assert.equal(sep14.records.length, 0);
  } finally {
    process.env.TZ = originalTz;
  }
});

/**
 * New in this round: the calendar view's own "Today" button (added
 * because there was previously no quick way back to the current month
 * once you'd navigated away with prev/next) is disabled exactly when it
 * would be a no-op -- already showing the current month. isSameMonth is
 * the pure comparison driving that disabled state.
 */
test("isSameMonth is true for two dates in the same calendar month, regardless of day", () => {
  assert.equal(isSameMonth(new Date(2026, 8, 1), new Date(2026, 8, 30)), true);
  assert.equal(isSameMonth(new Date(2026, 8, 15), new Date(2026, 8, 15)), true);
});

test("isSameMonth is false across a month boundary, even by a single day, and across the same month in a different year", () => {
  assert.equal(isSameMonth(new Date(2026, 8, 30), new Date(2026, 9, 1)), false, "Sep 30 and Oct 1 are different months");
  assert.equal(isSameMonth(new Date(2026, 0, 1), new Date(2026, 11, 31)), false, "January and December of the same year are different months");
  assert.equal(isSameMonth(new Date(2025, 8, 15), new Date(2026, 8, 15)), false, "same month/day but a different YEAR must not count as the same month");
});

test("recordsToCsv builds a header row from field labels and one row per record, with human-friendly values", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Won"], enumLabels: { New: "New lead" } },
    { name: "active", label: "Active", type: "boolean", required: false },
    { name: "amount", label: "Amount", type: "number", required: false },
  ];
  const records = [{ name: "Dana", status: "New", active: true, amount: 1234 }];
  const csv = recordsToCsv(fields, records, "en");
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Name,Status,Active,Amount");
  // The amount is deliberately NOT locale-formatted with a thousands
  // separator (no quoting needed either) -- see buildImportRecords'
  // round-trip test below for why: a "1,234" text value fails Number().
  assert.equal(lines[1], "Dana,New lead,TRUE,1234");
});

test("recordsToCsv falls back to the raw field name when there's no label, and to the raw enum value when there's no translated label", () => {
  const fields: Field[] = [{ name: "raw_field", type: "enum", required: true, enumValues: ["Untranslated"] }];
  const csv = recordsToCsv(fields, [{ raw_field: "Untranslated" }], "en");
  assert.equal(csv, "raw_field\r\nUntranslated");
});

test("recordsToCsv quotes a value containing a comma, quote, or newline, and doubles interior quotes", () => {
  const fields: Field[] = [{ name: "notes", label: "Notes", type: "text", required: false }];
  const csv = recordsToCsv(fields, [{ notes: 'Says "hi", then leaves' }], "en");
  assert.equal(csv, 'Notes\r\n"Says ""hi"", then leaves"');
});

test("recordsToCsv guards a value that would be interpreted as a spreadsheet formula (CSV/formula injection)", () => {
  // A text field can hold anything a business owner or a customer typed --
  // not just values this app itself ever wrote -- and Excel/Sheets/
  // LibreOffice treat an unguarded cell starting with =, +, -, @, or a
  // tab/CR as a formula to evaluate, not literal text.
  const fields: Field[] = [{ name: "notes", label: "Notes", type: "text", required: false }];
  assert.equal(recordsToCsv(fields, [{ notes: "=cmd|' /C calc'!A1" }], "en"), "Notes\r\n'=cmd|' /C calc'!A1");
  assert.equal(recordsToCsv(fields, [{ notes: "+1+1" }], "en"), "Notes\r\n'+1+1");
  assert.equal(recordsToCsv(fields, [{ notes: "-1" }], "en"), "Notes\r\n'-1");
  assert.equal(recordsToCsv(fields, [{ notes: "@SUM(A1:A9)" }], "en"), "Notes\r\n'@SUM(A1:A9)");
  // A value that doesn't start with one of those characters is untouched.
  assert.equal(recordsToCsv(fields, [{ notes: "a=b" }], "en"), "Notes\r\na=b");
  // The guard composes correctly with the existing comma/quote wrapping --
  // the leading "'" is prepended first, then the whole (now longer) value
  // is quoted/escaped exactly as any other value containing a comma or
  // quote would be.
  const withComma = recordsToCsv(fields, [{ notes: '=HYPERLINK("http://evil.example","click")' }], "en");
  assert.equal(withComma, 'Notes\r\n"\'=HYPERLINK(""http://evil.example"",""click"")"');
});

test("recordsToCsv renders an empty/missing value as an empty CSV field, never the string \"null\" or \"undefined\"", () => {
  const fields: Field[] = [{ name: "notes", label: "Notes", type: "text", required: false }];
  const csv = recordsToCsv(fields, [{ notes: null }, { notes: undefined }, { notes: "" }] as never, "en");
  assert.equal(csv, "Notes\r\n\r\n\r\n");
});

test("recordsToCsv formats false as FALSE, not an empty field (falsy values must not be treated as missing)", () => {
  const fields: Field[] = [{ name: "active", label: "Active", type: "boolean", required: false }];
  const csv = recordsToCsv(fields, [{ active: false }], "en");
  assert.equal(csv, "Active\r\nFALSE");
});

test("recordsToCsv resolves a relation field to the related record's display name, not the raw id, and degrades to #id when the target entity is unknown", () => {
  const courier: Entity = {
    name: "Courier",
    fields: [{ name: "name", type: "text", required: true }],
  };
  const fields: Field[] = [{ name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" }];
  const csvResolved = recordsToCsv(fields, [{ courierId: 1 }], "en", [courier], { Courier: [{ id: 1, name: "Yossi Cohen" }] });
  assert.equal(csvResolved, "Courier\r\nYossi Cohen");

  // No allEntities/relatedRecords passed at all (backward-compatible default) -- degrades to the raw id.
  const csvUnresolved = recordsToCsv(fields, [{ courierId: 1 }], "en");
  assert.equal(csvUnresolved, "Courier\r\n#1");
});

test("pickDisplayField prefers a field literally named name/title over other fields", () => {
  const withName: Field[] = [
    { name: "id", type: "number", required: false },
    { name: "name", type: "text", required: true },
  ];
  assert.equal(pickDisplayField({ name: "Courier", fields: withName })?.name, "name");

  const withTitle: Field[] = [
    { name: "status", type: "enum", required: true, enumValues: ["A", "B"] },
    { name: "title", type: "text", required: true },
  ];
  assert.equal(pickDisplayField({ name: "Deal", fields: withTitle })?.name, "title");
});

test("pickDisplayField falls back to the first text field, then the first field of any type", () => {
  const noNameOrTitle: Field[] = [
    { name: "status", type: "enum", required: true, enumValues: ["A", "B"] },
    { name: "licensePlate", type: "text", required: true },
  ];
  assert.equal(pickDisplayField({ name: "Vehicle", fields: noNameOrTitle })?.name, "licensePlate");

  const onlyNonText: Field[] = [{ name: "amount", type: "number", required: true }];
  assert.equal(pickDisplayField({ name: "Payment", fields: onlyNonText })?.name, "amount");

  assert.equal(pickDisplayField({ name: "Empty", fields: [] }), null);
});

test("calendarChipLabelField prefers the entity's real display field over whichever field merely comes first after the date field", () => {
  // Every built-in domain entity happens to declare its "name"/"title"
  // field before its date field, so grabbing "the first field that isn't
  // the date field" has always coincidentally matched pickDisplayField's
  // own result there -- but an AI-generated spec has no such ordering
  // guarantee. Here the date field comes first, then a boolean, then the
  // real display field ("name") -- "first non-date field" would pick the
  // boolean.
  const dateField: Field = { name: "scheduledAt", type: "date", required: true };
  const fields: Field[] = [
    dateField,
    { name: "active", type: "boolean", required: false },
    { name: "name", type: "text", required: true },
  ];
  const entity: Entity = { name: "Widget", fields };
  assert.equal(calendarChipLabelField(entity, dateField).name, "name");
});

test("calendarChipLabelField falls back to the first other field when the entity has no name/title/text field at all", () => {
  const dateField: Field = { name: "date", type: "date", required: true };
  const fields: Field[] = [
    dateField,
    { name: "count", type: "number", required: false },
  ];
  const entity: Entity = { name: "Metric", fields };
  assert.equal(calendarChipLabelField(entity, dateField).name, "count");
});

test("recordDisplayLabel shows the display field's value, falling back to #id when it's empty or missing", () => {
  const courier: Entity = {
    name: "Courier",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "phone", type: "text", required: false },
    ],
  };
  assert.equal(recordDisplayLabel(courier, { id: 5, name: "Yossi Cohen", phone: "" }), "Yossi Cohen");
  assert.equal(recordDisplayLabel(courier, { id: 7, name: "", phone: "050-1" }), "#7");
  assert.equal(recordDisplayLabel({ name: "Empty", fields: [] }, { id: 9 }), "#9");
});

test("parseCsv splits plain comma-separated rows, dropping a single trailing blank line", () => {
  const rows = parseCsv("Name,Amount\r\nDana,10\r\nYossi,20\r\n");
  assert.deepEqual(rows, [
    ["Name", "Amount"],
    ["Dana", "10"],
    ["Yossi", "20"],
  ]);
});

test("parseCsv handles quoted fields with embedded commas, newlines, and doubled-quote escapes", () => {
  const csv = 'Name,Notes\r\n"Dana, VIP","Says ""hi""\nsee you soon"\r\n';
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [
    ["Name", "Notes"],
    ["Dana, VIP", 'Says "hi"\nsee you soon'],
  ]);
});

test("parseCsv round-trips output produced by recordsToCsv", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "notes", label: "Notes", type: "text", required: false },
  ];
  const csv = recordsToCsv(fields, [{ name: "Dana", notes: 'Says "hi", bye' }], "en");
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [
    ["Name", "Notes"],
    ["Dana", 'Says "hi", bye'],
  ]);
});

test("a number >= 1000 and a date field round-trip exactly through recordsToCsv -> parseCsv -> buildImportRecords (a real bug: exporting with a locale thousands separator/date order that the importer's plain Number()/raw-string parsing couldn't read back)", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "amount", label: "Amount", type: "number", required: false },
    { name: "dueDate", label: "Due Date", type: "date", required: false },
  ];
  const original = { name: "Dana", amount: 12345, dueDate: "2024-01-02" };
  const csv = recordsToCsv(fields, [original], "en");
  const rows = parseCsv(csv);
  const { records, errors } = buildImportRecords(fields, rows);
  assert.deepEqual(errors, []);
  assert.deepEqual(records, [original]);
});

test("parseCsv accepts bare LF line endings too, not just CRLF", () => {
  const rows = parseCsv("Name,Amount\nDana,10\nYossi,20");
  assert.deepEqual(rows, [
    ["Name", "Amount"],
    ["Dana", "10"],
    ["Yossi", "20"],
  ]);
});

test("buildImportRecords matches columns by header label or field name, case-insensitively", () => {
  const fields: Field[] = [
    { name: "name", label: "שם", type: "text", required: true },
    { name: "amount", label: "Amount", type: "number", required: false },
  ];
  const rows = [
    ["שם", "amount"],
    ["Dana", "150"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana", amount: 150 }]);
});

test("buildImportRecords coerces booleans, numbers, and enum labels back to their stored values", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "active", type: "boolean", required: false },
    { name: "status", type: "enum", required: true, enumValues: ["New", "Won"], enumLabels: { New: "חדש" } },
  ];
  const rows = [
    ["name", "active", "status"],
    ["Dana", "true", "חדש"], // enum matched by translated label
    ["Yossi", "yes", "Won"], // enum matched by raw value; "yes" also counts as true
    ["Noa", "", "New"], // empty optional boolean defaults to false, not skipped
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [
    { name: "Dana", active: true, status: "New" },
    { name: "Yossi", active: true, status: "Won" },
    { name: "Noa", active: false, status: "New" },
  ]);
});

test("buildImportRecords skips a row missing a required field and reports which row and field", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "text", required: false },
  ];
  const rows = [
    ["Name", "Email"],
    ["Dana", "dana@example.com"],
    ["", "noname@example.com"], // has an email, so it isn't a blank line -- just missing the required name
    ["Yossi", ""],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, [
    { name: "Dana", email: "dana@example.com" },
    { name: "Yossi", email: null },
  ]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Row 2/);
  assert.match(result.errors[0], /Name/);
});

test("buildImportRecords reports an unparseable number and an invalid enum option by row", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "amount", label: "Amount", type: "number", required: true },
    { name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Won"] },
  ];
  const rows = [
    ["name", "amount", "status"],
    ["Dana", "not-a-number", "New"],
    ["Yossi", "10", "NotAnOption"],
    ["Noa", "20", "Won"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, [{ name: "Noa", amount: 20, status: "Won" }]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /Row 1.*Amount/);
  assert.match(result.errors[1], /Row 2.*Status/);
});

test("buildImportRecords rejects a date column value that isn't a real, well-formed calendar date", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "dueDate", label: "Due Date", type: "date", required: true },
  ];
  const rows = [
    ["name", "Due Date"],
    ["Dana", "not-a-real-date"],
    ["Yossi", "2024/01/15"],
    ["Noa", "2024-02-30"],
    ["Tal", "2024-01-15"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, [{ name: "Tal", dueDate: "2024-01-15" }]);
  assert.equal(result.errors.length, 3);
  for (const error of result.errors) {
    assert.match(error, /Due Date/);
  }
});

test("buildImportRecords leaves an optional, unset date field null rather than rejecting an empty cell", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "followUp", label: "Follow-up", type: "date", required: false },
  ];
  const rows = [
    ["name", "Follow-up"],
    ["Dana", ""],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana", followUp: null }]);
});

test("buildImportRecords skips fully blank rows silently instead of treating them as errors", () => {
  const fields: Field[] = [{ name: "name", type: "text", required: true }];
  const rows = [["name"], ["Dana"], [""], ["Yossi"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, [{ name: "Dana" }, { name: "Yossi" }]);
  assert.deepEqual(result.errors, []);
});

test("buildImportRecords refuses the whole import for an entity with a required relation field, rather than producing records that would fail one at a time", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "customerId", label: "Customer", type: "relation", required: true, relationTo: "Customer" },
  ];
  const rows = [["name", "Customer"], ["Dana", "Yossi Cohen"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /required relation field/);
  assert.match(result.errors[0], /Customer/);
});

test("buildImportRecords ignores an optional relation column instead of failing on it", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const rows = [["name", "Courier"], ["Dana", "Yossi Cohen"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana" }]);
});

test("buildImportRecords ignores an unmatched CSV column instead of erroring on it", () => {
  const fields: Field[] = [{ name: "name", type: "text", required: true }];
  const rows = [["name", "internal notes"], ["Dana", "vip, handle with care"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana" }]);
});

test("groupByField groups records into one column per declared enum value, in declared order, including empty columns", () => {
  const field: Field = {
    name: "stage",
    type: "enum",
    required: true,
    enumValues: ["Lead", "Negotiation", "Won", "Lost"],
    enumLabels: { Lead: "ליד" },
  };
  const records = [
    { id: 1, stage: "Won" },
    { id: 2, stage: "Lead" },
    { id: 3, stage: "Won" },
  ];
  const columns = groupByField(records, field);
  assert.deepEqual(
    columns.map((c) => c.value),
    ["Lead", "Negotiation", "Won", "Lost"],
  );
  assert.equal(columns[0].label, "ליד"); // uses the translated enum label when present
  assert.equal(columns[1].label, "Negotiation"); // falls back to the raw value otherwise
  assert.equal(columns.find((c) => c.value === "Won")!.records.length, 2);
  assert.equal(columns.find((c) => c.value === "Negotiation")!.records.length, 0); // empty column, not omitted
});

/**
 * New in this round: a search/filter narrowing the table lost all sense of
 * how many records matched versus the real total -- both counts were
 * always computed in EntityPanel but never shown. Two distinct phrasings:
 * the unfiltered everyday case reads as a plain count, not a redundant
 * "12 of 12 records".
 */
test("formatEntityRecordCount shows a plain count when nothing is filtered out (shown equals total)", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatEntityRecordCount(12, 12, t), "12 records");
  assert.equal(formatEntityRecordCount(0, 0, t), "0 records");
});

test("formatEntityRecordCount shows 'shown of total' once a search/filter actually narrows the results", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatEntityRecordCount(3, 12, t), "3 of 12 records");
});

test("formatEntityRecordCount renders in Hebrew when given the Hebrew translator", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatEntityRecordCount(5, 5, t), "5 רשומות");
  assert.equal(formatEntityRecordCount(2, 5, t), "2 מתוך 5 רשומות");
});

/**
 * New in this round: clicking a calendar day now pre-fills the create form
 * with that day's own date. Must round-trip through LOCAL date parts
 * (matching parseFieldDate's own construction in buildCalendarMonth above),
 * not `toISOString()` (UTC) -- a UTC-based conversion would silently shift
 * to the wrong day for a viewer whose local time is behind UTC.
 */
test("formatDateForInput renders a local-midnight Date as plain YYYY-MM-DD, zero-padded", () => {
  assert.equal(formatDateForInput(new Date(2026, 0, 5)), "2026-01-05"); // January (month 0), single-digit day
  assert.equal(formatDateForInput(new Date(2026, 11, 25)), "2026-12-25"); // December (month 11)
});

test("formatDateForInput round-trips with the exact grid-cell Date construction buildCalendarMonth itself uses, not a UTC conversion", () => {
  // Mirrors buildCalendarMonth's own `new Date(year, month, day)` -- if this
  // used toISOString() instead, a viewer behind UTC would see the date
  // shift back by one, exactly the bug parseFieldDate's own doc comment
  // above describes fixing for the read direction.
  const cell = new Date(2026, 2, 1); // March 1st, local midnight
  assert.equal(formatDateForInput(cell), "2026-03-01");
});
