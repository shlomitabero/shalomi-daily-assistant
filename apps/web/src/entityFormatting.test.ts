import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, EntityRecord, Field } from "@forge/shared";
import { translate } from "./i18n/language.js";
import {
  badgeTone,
  buildCalendarMonth,
  buildImportRecords,
  calendarChipLabelField,
  computeNextFocusedRowId,
  findBoardField,
  findDateField,
  findEndDateField,
  findPhoneField,
  formatDateForInput,
  formatDateValue,
  formatEntityRecordCount,
  formatNumberValue,
  formatRecordCreatedAt,
  getDateUrgency,
  groupByField,
  groupRecordsByField,
  isDeadlineFieldName,
  isGroupableField,
  isInlineEditableField,
  isSameDay,
  isSameMonth,
  isTypingTarget,
  matchesSearch,
  parseCsv,
  pickDisplayField,
  recordDisplayLabel,
  recordsToCsv,
  restoreRecordAt,
  searchEntityRecords,
  selectedOrAllRecords,
  sortRecords,
  sortRecordsMulti,
  splitHighlightSegments,
  splitLinkSegments,
  sumNumericFields,
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

/**
 * Regression test for a real bug found by this round's Explore survey:
 * "Inactive" contains "active" as a substring, so checking POSITIVE_WORDS
 * before NEGATIVE_WORDS classified it as "positive" (a green badge) --
 * the exact opposite of what it means, and directly visible wherever
 * badgeTone renders a status badge (EntityPanel's table cells and Kanban
 * column headers). This is a real, built-in status pair (Volunteer's own
 * status enum, and the generic DEFAULT_ENTITY fallback -- see
 * spec-engine/domainEntities.ts), not a contrived edge case.
 */
test("badgeTone recognizes 'Inactive' as negative, not positive from matching 'active' as a substring", () => {
  assert.equal(badgeTone("Inactive"), "negative");
  assert.equal(badgeTone("Active"), "positive");
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

test("formatRecordCreatedAt formats a real ISO timestamp per locale, including the time of day (unlike formatDateValue's date-only formatting)", () => {
  const result = formatRecordCreatedAt("2026-03-15T14:30:00.000Z", "en");
  assert.notEqual(result, "", "a real timestamp must never format to an empty string");
  // Exact hour is locale/timezone-dependent, but a genuine time-of-day
  // component distinguishes this from formatDateValue's calendar-day-only
  // output -- confirm it isn't JUST a date.
  assert.notEqual(result, formatDateValue("2026-03-15", "en"));
});

test("formatRecordCreatedAt returns an empty string for a missing or unparseable value, instead of 'Invalid Date' or throwing", () => {
  assert.equal(formatRecordCreatedAt(undefined, "en"), "");
  assert.equal(formatRecordCreatedAt("not-a-timestamp", "en"), "");
  assert.equal(formatRecordCreatedAt("", "en"), "");
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

/**
 * New in this round: a relation field's own table cell visibly shows the
 * related record's display label (e.g. "Dana Levi"), resolved via
 * relationDisplayLabel -- but matchesSearch fell through to String(value)
 * for a relation field, i.e. the raw stored foreign-key id, so typing the
 * exact name shown right there on screen found nothing. allEntities/
 * relatedRecords are optional so a caller with no relation data on hand
 * (or this same test's own no-args cases below) still gets the previous,
 * id-only behavior instead of a crash.
 */
test("matchesSearch resolves a relation field to its related record's display label, not the raw foreign-key id", () => {
  const customer: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const orderFields: Field[] = [
    { name: "total", type: "number", required: true },
    { name: "customerId", type: "relation", required: true, relationTo: "Customer" },
  ];
  const order = { total: 150, customerId: 1 };
  const allEntities = [customer];
  const relatedRecords = { Customer: [{ id: 1, name: "Dana Levi" }] };

  assert.ok(matchesSearch(order, orderFields, "dana levi", allEntities, relatedRecords));
  assert.ok(!matchesSearch(order, orderFields, "yossi", allEntities, relatedRecords));
});

test("matchesSearch falls back to matching the raw relation id when no allEntities/relatedRecords are given", () => {
  const orderFields: Field[] = [{ name: "customerId", type: "relation", required: true, relationTo: "Customer" }];
  const order = { customerId: 1 };
  assert.ok(matchesSearch(order, orderFields, "1"));
  assert.ok(!matchesSearch(order, orderFields, "dana levi"));
});

test("matchesSearch degrades gracefully to the raw id for a relation whose target entity/records aren't available, instead of throwing", () => {
  const orderFields: Field[] = [{ name: "customerId", type: "relation", required: true, relationTo: "Customer" }];
  const order = { customerId: 1 };
  assert.ok(matchesSearch(order, orderFields, "1", [], {}));
  assert.ok(!matchesSearch(order, orderFields, "dana levi", [], {}));
});

/**
 * New in this round: matchesSearch already tells the table a record
 * matched, but nothing showed *where* within a cell's own text -- a real
 * everyday annoyance the moment a search term is short/common and you
 * have to squint at every visible field to find the actual hit.
 * splitHighlightSegments is the pure logic Cell's own Highlighted wrapper
 * uses to mark the matched part(s).
 */
test("splitHighlightSegments splits matched and unmatched runs, case-insensitively, and preserves the original casing of the matched text", () => {
  assert.deepEqual(splitHighlightSegments("Dana Levi", "dana"), [
    { text: "Dana", matched: true },
    { text: " Levi", matched: false },
  ]);
  // Matches are non-overlapping: after matching "aa" at the start, only a
  // single leftover "a" remains -- not a second, overlapping "aa".
  assert.deepEqual(splitHighlightSegments("aaa", "aa"), [
    { text: "aa", matched: true },
    { text: "a", matched: false },
  ]);
});

test("splitHighlightSegments returns the whole text as a single unmatched segment for a blank query or no match", () => {
  assert.deepEqual(splitHighlightSegments("Dana Levi", ""), [{ text: "Dana Levi", matched: false }]);
  assert.deepEqual(splitHighlightSegments("Dana Levi", "   "), [{ text: "Dana Levi", matched: false }]);
  assert.deepEqual(splitHighlightSegments("Dana Levi", "yossi"), [{ text: "Dana Levi", matched: false }]);
});

test("splitHighlightSegments escapes regex-special characters in the query instead of treating them as a pattern", () => {
  assert.deepEqual(splitHighlightSegments("3.5 (kg)", "3.5"), [
    { text: "3.5", matched: true },
    { text: " (kg)", matched: false },
  ]);
  // Without escaping, "." would match any character (e.g. "3X5"), not just a literal dot.
  assert.deepEqual(splitHighlightSegments("3X5 (kg)", "3.5"), [{ text: "3X5 (kg)", matched: false }]);
});

/**
 * New in this round: a plain text/longtext field's value (e.g. a
 * "Website" or "Email" field on a Customer/Vendor/Lead-shaped entity) used
 * to render as completely inert text everywhere -- table, board card,
 * print sheet -- with no way to click through. splitLinkSegments is the
 * pure logic behind the new clickable rendering: a URL or email address
 * embedded in the text becomes its own segment with a real href, the rest
 * stays plain.
 */
test("splitLinkSegments finds a URL and gives it its own href, leaving the surrounding text plain", () => {
  assert.deepEqual(splitLinkSegments("Visit https://example.com for details"), [
    { text: "Visit ", href: null },
    { text: "https://example.com", href: "https://example.com" },
    { text: " for details", href: null },
  ]);
});

test("splitLinkSegments finds an email address and gives it a mailto: href", () => {
  assert.deepEqual(splitLinkSegments("Contact dana@example.com anytime"), [
    { text: "Contact ", href: null },
    { text: "dana@example.com", href: "mailto:dana@example.com" },
    { text: " anytime", href: null },
  ]);
});

test("splitLinkSegments returns the whole text as a single plain segment when nothing matches", () => {
  assert.deepEqual(splitLinkSegments("Just a plain note, nothing to link."), [
    { text: "Just a plain note, nothing to link.", href: null },
  ]);
  assert.deepEqual(splitLinkSegments(""), [{ text: "", href: null }]);
});

test("splitLinkSegments trims trailing sentence punctuation off a matched URL/email into its own plain segment", () => {
  assert.deepEqual(splitLinkSegments("See https://example.com/path."), [
    { text: "See ", href: null },
    { text: "https://example.com/path", href: "https://example.com/path" },
    { text: ".", href: null },
  ]);
  assert.deepEqual(splitLinkSegments("Email dana@example.com, thanks!"), [
    { text: "Email ", href: null },
    { text: "dana@example.com", href: "mailto:dana@example.com" },
    { text: ", thanks!", href: null },
  ]);
});

test("splitLinkSegments handles multiple links in one text, and a bare URL/email with nothing around it", () => {
  assert.deepEqual(splitLinkSegments("https://a.com and dana@b.com"), [
    { text: "https://a.com", href: "https://a.com" },
    { text: " and ", href: null },
    { text: "dana@b.com", href: "mailto:dana@b.com" },
  ]);
  assert.deepEqual(splitLinkSegments("https://example.com"), [{ text: "https://example.com", href: "https://example.com" }]);
});

test("splitLinkSegments doesn't double-match an email-like address inside a URL's own path/query as a second, overlapping link", () => {
  // A URL with an "@" in it (e.g. a mailto-style share link) must not also
  // spuriously match as a second, nested email segment starting mid-URL.
  const segments = splitLinkSegments("https://example.com/share?to=dana@example.com");
  assert.equal(segments.length, 1, "the whole URL must be claimed by a single segment, not split around the embedded @");
  assert.equal(segments[0].href, "https://example.com/share?to=dana@example.com");
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

test("searchEntityRecords resolves relation fields to their display label when allEntities/relatedRecords are given", () => {
  const customer: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const order: Entity = {
    name: "Order",
    label: "Orders",
    fields: [
      { name: "total", type: "number", required: true },
      { name: "customerId", type: "relation", required: true, relationTo: "Customer" },
    ],
  };
  const records = [
    { id: 1, total: 100, customerId: 1 },
    { id: 2, total: 200, customerId: 2 },
  ];
  const allEntities = [customer];
  const relatedRecords = {
    Customer: [
      { id: 1, name: "Dana Levi" },
      { id: 2, name: "Yossi Cohen" },
    ],
  };
  const result = searchEntityRecords(order, records, "dana levi", 5, allEntities, relatedRecords);
  assert.ok(result);
  assert.deepEqual(result!.sample.map((r) => r.id), [1]);
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

/**
 * New in this round: the table's own sort was always single-column --
 * clicking a second header threw away whatever the first one had already
 * sorted by. sortRecordsMulti is the pure function behind a real
 * secondary sort (shift+click a second header adds it as a tiebreaker,
 * see EntityPanel.tsx's own toggleSort). Uses a fixture with real,
 * genuine ties on the primary key (two "won" deals, two "lost" deals) so
 * the secondary key's own effect is unambiguous -- a fixture where every
 * primary value happened to be unique would prove nothing about the
 * secondary key at all.
 */
test("sortRecordsMulti breaks ties on the primary key using the secondary key, in the secondary key's own direction", () => {
  const records = [
    { id: 1, status: "won", amount: 30 },
    { id: 2, status: "lost", amount: 10 },
    { id: 3, status: "won", amount: 10 },
    { id: 4, status: "lost", amount: 20 },
  ];
  const sorted = sortRecordsMulti(records, [
    { field: "status", direction: "asc" },
    { field: "amount", direction: "desc" },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.id),
    [4, 2, 1, 3],
    "primary asc groups lost(10,20) before won(30,10); secondary desc orders each group's own amounts high-to-low",
  );
});

test("sortRecordsMulti applies each key's own direction independently -- reversing the whole result would also wrongly flip the tie-break order", () => {
  const records = [
    { id: 1, status: "won", amount: 30 },
    { id: 2, status: "lost", amount: 10 },
    { id: 3, status: "won", amount: 10 },
    { id: 4, status: "lost", amount: 20 },
  ];
  const sorted = sortRecordsMulti(records, [
    { field: "status", direction: "desc" },
    { field: "amount", direction: "asc" },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.id),
    [3, 1, 2, 4],
    "primary desc groups won(10,30) before lost(10,20); secondary asc (independent of the primary's own direction) still orders each group low-to-high",
  );
});

test("sortRecordsMulti returns records unchanged (same reference) when given no sort keys", () => {
  const records = [{ id: 1 }, { id: 2 }];
  assert.equal(sortRecordsMulti(records, []), records);
});

/**
 * New in this round: a relation column's own table cell visibly shows the
 * related record's resolved display label (e.g. "Dana Levi"), not the raw
 * stored foreign-key id -- but compareValues sorted on the raw id, so
 * clicking that header shuffled rows by an internal number no one could
 * see, looking broken/random. Same root cause and fix shape as round 271's
 * matchesSearch relation fix. fields/allEntities/relatedRecords are
 * optional so a caller with no relation data on hand (or the plain
 * numbers/strings/booleans tests above) still gets the previous,
 * raw-value sort instead of a required-but-unavailable argument.
 */
test("sortRecords sorts a relation field by its related record's display label, not the raw foreign-key id", () => {
  const customer: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const orderFields: Field[] = [{ name: "customerId", type: "relation", required: true, relationTo: "Customer" }];
  // Customer ids are deliberately assigned in REVERSE alphabetical order of
  // their names (id 1 = "Zed", the alphabetically-last name; id 3 = "Abe",
  // the alphabetically-first) -- if this test's fixture instead happened to
  // let ascending id order coincide with ascending name order, a version of
  // sortRecords that never resolved relations at all (still sorting by the
  // raw id) would pass it too, silently proving nothing. Sorting ascending
  // by raw id here gives exactly the opposite order of sorting ascending by
  // resolved name, so only a real fix can produce the expected result.
  const records = [
    { id: 1, customerId: 1 }, // Zed
    { id: 2, customerId: 2 }, // Mona
    { id: 3, customerId: 3 }, // Abe
  ];
  const allEntities = [customer];
  const relatedRecords = {
    Customer: [
      { id: 1, name: "Zed" },
      { id: 2, name: "Mona" },
      { id: 3, name: "Abe" },
    ],
  };
  const sorted = sortRecords(records, "customerId", "asc", orderFields, allEntities, relatedRecords);
  assert.deepEqual(
    sorted.map((r) => r.id),
    [3, 2, 1],
    "alphabetical by resolved name (Abe, Mona, Zed), not numeric by the raw stored id (1, 2, 3)",
  );
});

test("sortRecords falls back to sorting a relation field by its raw id when no allEntities/relatedRecords are given", () => {
  const orderFields: Field[] = [{ name: "customerId", type: "relation", required: true, relationTo: "Customer" }];
  const records = [
    { id: 1, customerId: 3 },
    { id: 2, customerId: 1 },
  ];
  const sorted = sortRecords(records, "customerId", "asc", orderFields);
  assert.deepEqual(sorted.map((r) => r.customerId), [1, 3]);
});

test("sortRecordsMulti resolves a relation key to its display label too, composing correctly with a non-relation tiebreaker key", () => {
  const courier: Entity = { name: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const orderFields: Field[] = [
    { name: "courierId", type: "relation", required: true, relationTo: "Courier" },
    { name: "total", type: "number", required: true },
  ];
  // Courier id 1 is named "Zed" (alphabetically last) and id 2 is "Abe"
  // (alphabetically first) -- reversed from raw-id order, same reasoning as
  // the sortRecords test above: this way a version that never resolved the
  // relation (sorting by raw id 1 before 2) would order the records
  // differently from a version that correctly sorts by name (Abe before
  // Zed), so this fixture can actually tell the two apart.
  const records = [
    { id: 1, courierId: 1, total: 50 }, // Zed
    { id: 2, courierId: 2, total: 10 }, // Abe
    { id: 3, courierId: 2, total: 20 }, // Abe
  ];
  const allEntities = [courier];
  const relatedRecords = {
    Courier: [
      { id: 1, name: "Zed" },
      { id: 2, name: "Abe" },
    ],
  };
  const sorted = sortRecordsMulti(
    records,
    [
      { field: "courierId", direction: "asc" },
      { field: "total", direction: "asc" },
    ],
    orderFields,
    allEntities,
    relatedRecords,
  );
  assert.deepEqual(
    sorted.map((r) => r.id),
    [2, 3, 1],
    "Abe's two orders first (resolved name), tie-broken by total ascending, then Zed's order",
  );
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

test("findPhoneField recognizes the domain library's own 'phone' convention", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "phone", type: "text", required: false },
  ];
  assert.equal(findPhoneField(fields)?.name, "phone");
});

test("findPhoneField recognizes common phone-field name variants, case-insensitively, matching whatsapp.ts's own server-side hint list", () => {
  for (const name of ["Mobile", "phoneNumber", "MobileNumber", "cellPhone", "cell", "Telephone", "tel"]) {
    const fields: Field[] = [{ name, type: "text", required: false }];
    assert.equal(findPhoneField(fields)?.name, name, `expected "${name}" to be recognized as a phone field`);
  }
});

test("findPhoneField returns null when the entity has no phone-like field", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "email", type: "text", required: false },
  ];
  assert.equal(findPhoneField(fields), null);
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

test("findEndDateField finds the matching end-of-range field, matching the domain library's own Rental entity (startDate/endDate)", () => {
  const fields: Field[] = [
    { name: "itemName", type: "text", required: true },
    { name: "startDate", type: "date", required: true },
    { name: "endDate", type: "date", required: true },
  ];
  const start = findDateField(fields)!;
  assert.equal(start.name, "startDate");
  assert.equal(findEndDateField(fields, start)?.name, "endDate");
});

test("findEndDateField returns null for an entity with only one date field", () => {
  const fields: Field[] = [{ name: "scheduledDate", type: "date", required: true }];
  const start = findDateField(fields)!;
  assert.equal(findEndDateField(fields, start), null);
});

test("findEndDateField never matches the start field back to itself", () => {
  const fields: Field[] = [{ name: "endDate", type: "date", required: true }];
  // endDate is the only date field, so findDateField picks it as the start.
  const start = findDateField(fields)!;
  assert.equal(start.name, "endDate");
  assert.equal(findEndDateField(fields, start), null);
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

test("buildCalendarMonth matches a record to every day in its [start, end] range when an endField is given", () => {
  const start: Field = { name: "startDate", type: "date", required: true };
  const end: Field = { name: "endDate", type: "date", required: true };
  const records = [{ id: 1, startDate: "2026-09-10", endDate: "2026-09-12" }];
  const days = buildCalendarMonth(records, start, 2026, 8, end);
  for (const day of [9, 10, 11, 12, 13]) {
    const cell = days.find((d) => d.inCurrentMonth && d.date.getDate() === day)!;
    const expected = day >= 10 && day <= 12;
    assert.equal(cell.records.length, expected ? 1 : 0, `day ${day}`);
  }
});

test("buildCalendarMonth falls back to a single-day match when the endField value is missing", () => {
  const start: Field = { name: "startDate", type: "date", required: true };
  const end: Field = { name: "endDate", type: "date", required: true };
  const records = [{ id: 1, startDate: "2026-09-10", endDate: null }];
  const days = buildCalendarMonth(records, start, 2026, 8, end);
  const day10 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 10)!;
  const day11 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 11)!;
  assert.equal(day10.records.length, 1);
  assert.equal(day11.records.length, 0);
});

test("buildCalendarMonth falls back to a single-day match when endField is before startField (an invalid range)", () => {
  const start: Field = { name: "startDate", type: "date", required: true };
  const end: Field = { name: "endDate", type: "date", required: true };
  const records = [{ id: 1, startDate: "2026-09-10", endDate: "2026-09-05" }];
  const days = buildCalendarMonth(records, start, 2026, 8, end);
  const day10 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 10)!;
  const day5 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 5)!;
  assert.equal(day10.records.length, 1);
  assert.equal(day5.records.length, 0);
});

test("buildCalendarMonth without an endField argument still behaves exactly as before (single-day match only)", () => {
  const start: Field = { name: "startDate", type: "date", required: true };
  const records = [{ id: 1, startDate: "2026-09-10", endDate: "2026-09-12" }];
  const days = buildCalendarMonth(records, start, 2026, 8);
  const day10 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 10)!;
  const day11 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 11)!;
  assert.equal(day10.records.length, 1);
  assert.equal(day11.records.length, 0);
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

/**
 * New in this round: exporting isSameDay (previously a private helper used
 * only inside buildCalendarMonth's own record-matching) so CalendarView can
 * reuse the exact same comparison to mark today's cell in the grid, instead
 * of duplicating a second date-equality check that could quietly drift out
 * of sync with the one buildCalendarMonth already uses.
 */
test("isSameDay is true only for two dates sharing the same year, month, and day, regardless of time-of-day", () => {
  assert.equal(isSameDay(new Date(2026, 8, 15, 0, 0), new Date(2026, 8, 15, 23, 59)), true);
  assert.equal(isSameDay(new Date(2026, 8, 15), new Date(2026, 8, 16)), false, "different day, same month");
  assert.equal(isSameDay(new Date(2026, 8, 15), new Date(2026, 9, 15)), false, "different month, same day");
  assert.equal(isSameDay(new Date(2025, 8, 15), new Date(2026, 8, 15)), false, "same month/day but a different year");
});

/**
 * New in this round: "Export CSV"/"Print List" used to always operate on
 * `visibleRecords` (the current filtered/sorted table), silently discarding
 * whatever the user had already checked via the table's own bulk-select
 * checkboxes. selectedOrAllRecords is the pure decision behind the fix --
 * when nothing is selected it must behave exactly as before (whatever the
 * current view is showing); when something is selected it must return
 * EXACTLY those records pulled from the full, unfiltered entity, matching
 * handleBulkDelete/handleBulkDuplicate's own existing "selection survives a
 * changed search box" behavior, not a narrower intersection with whatever
 * happens to be visible right now.
 */
test("selectedOrAllRecords returns visibleRecords unchanged when nothing is selected", () => {
  const all = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const visible = [{ id: 2 }];
  const result = selectedOrAllRecords(all, visible, new Set());
  assert.equal(result, visible, "must be the exact same array reference when there is no selection");
});

test("selectedOrAllRecords returns exactly the selected records pulled from the FULL entity, not the currently-visible subset", () => {
  const all = [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }];
  // A record (id 3) is selected but no longer visible (e.g. the search box
  // was changed after selecting it) -- it must still be included, matching
  // how handleBulkDelete/handleBulkDuplicate already read the full `records`
  // array by id rather than being constrained by the current visible view.
  const visible = [{ id: 1, name: "A" }];
  const result = selectedOrAllRecords(all, visible, new Set([1, 3]));
  assert.deepEqual(result, [{ id: 1, name: "A" }, { id: 3, name: "C" }]);
});

test("selectedOrAllRecords preserves the full entity's own order, not the selection Set's insertion order", () => {
  const all = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const result = selectedOrAllRecords(all, [], new Set([3, 1]));
  assert.deepEqual(result, [{ id: 1 }, { id: 3 }]);
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

test("a text value and a negative number that csvEscape guards against formula injection round-trip exactly through recordsToCsv -> parseCsv -> buildImportRecords (a real bug: the guard's leading \"'\" used to come back baked into the re-imported data, and a negative number used to fail to parse at all)", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "notes", label: "Notes", type: "text", required: false },
    { name: "balance", label: "Balance", type: "number", required: false },
  ];
  const original = { name: "Dana", notes: "-1 day late, call @dana", balance: -120.5 };
  const csv = recordsToCsv(fields, [original], "en");
  const rows = parseCsv(csv);
  const { records, errors } = buildImportRecords(fields, rows);
  assert.deepEqual(errors, []);
  assert.deepEqual(records, [original]);
});

test("unescapeCsvGuard leaves a value that genuinely starts with a literal apostrophe alone, rather than mistaking it for csvEscape's own guard", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const original = { name: "'Ohana" };
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

/**
 * Regression test for a real bug found by round 287's Explore survey:
 * FieldLabelEditor enforces no uniqueness on a field's label (confirmed by
 * reading both it and its server route, RenameFieldLabelSchema in
 * projects.ts -- no collision check anywhere), so two fields on the same
 * entity can genuinely end up sharing a label (e.g. both renamed to
 * "Status"). Before this fix, `columnFields` matched every header cell
 * independently against the full field list, so both CSV columns named
 * "Status" resolved to whichever field `fields.find` hit first -- the
 * second field's real column was silently ignored, and the loop that
 * later reads each field's value from `columnFields.findIndex` would
 * find that same first column for both fields, duplicating one field's
 * data into the other. Confirms each header column now claims a distinct
 * field, so two same-labeled columns correctly map to two different
 * fields instead of collapsing onto one.
 */
test("buildImportRecords maps each column to a distinct field even when two fields share the same label, instead of collapsing both onto the first match", () => {
  const fields: Field[] = [
    { name: "stage", label: "Status", type: "text", required: false },
    { name: "shippingStatus", label: "Status", type: "text", required: false },
  ];
  const rows = [
    ["Status", "Status"],
    ["In Progress", "Shipped"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ stage: "In Progress", shippingStatus: "Shipped" }]);
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

test("groupByField collects a record whose stored value isn't a declared enum value into a trailing '(other)' column instead of dropping it", () => {
  const t = (key: string) => translate("en", key);
  const field: Field = {
    name: "stage",
    type: "enum",
    required: true,
    enumValues: ["Lead", "Won", "Lost"],
  };
  const records = [
    { id: 1, stage: "Won" },
    { id: 2, stage: "Archived" }, // a legacy value left behind after a refine renamed the options
    { id: 3, stage: "Lead" },
  ];
  const columns = groupByField(records, field, t);
  assert.deepEqual(
    columns.map((c) => c.value),
    ["Lead", "Won", "Lost", "__other__"],
  );
  const other = columns.find((c) => c.value === "__other__")!;
  assert.equal(other.label, "Other");
  assert.equal(other.isOther, true);
  assert.deepEqual(other.records.map((r) => r.id), [2]);
  // real enum columns are unaffected and never marked isOther
  assert.equal(columns.find((c) => c.value === "Won")!.isOther, undefined);
});

test("groupByField omits the '(other)' column entirely when every record's value is a declared enum value", () => {
  const field: Field = { name: "stage", type: "enum", required: true, enumValues: ["Lead", "Won"] };
  const columns = groupByField([{ id: 1, stage: "Won" }], field);
  assert.equal(columns.find((c) => c.value === "__other__"), undefined);
});

test("groupByField falls back to the raw 'Other' label when called without a translator", () => {
  const field: Field = { name: "stage", type: "enum", required: true, enumValues: ["Lead"] };
  const columns = groupByField([{ id: 1, stage: "Archived" }], field);
  assert.equal(columns.find((c) => c.value === "__other__")!.label, "Other");
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

/**
 * New in this round: deleting a record now removes it from view
 * optimistically and delays the real API call behind a short undo window
 * (see EntityPanel.tsx's handleDelete) -- clicking Undo needs to put the
 * record back exactly where it was, not appended at the end.
 */
test("restoreRecordAt reinserts a record at its original index, not at the end", () => {
  const records = [{ id: 1 }, { id: 2 }, { id: 4 }];
  const restored = restoreRecordAt(records, { id: 3 }, 2);
  assert.deepEqual(
    restored.map((r) => r.id),
    [1, 2, 3, 4],
  );
});

test("restoreRecordAt clamps an out-of-range index to the end of the array, instead of throwing or losing the record", () => {
  const records = [{ id: 1 }, { id: 2 }];
  const restored = restoreRecordAt(records, { id: 99 }, 50);
  assert.deepEqual(
    restored.map((r) => r.id),
    [1, 2, 99],
  );
});

test("restoreRecordAt reinserts at the front when index is 0", () => {
  const records = [{ id: 2 }, { id: 3 }];
  const restored = restoreRecordAt(records, { id: 1 }, 0);
  assert.deepEqual(
    restored.map((r) => r.id),
    [1, 2, 3],
  );
});

test("restoreRecordAt does not mutate the original records array", () => {
  const records = [{ id: 1 }, { id: 2 }];
  const original = [...records];
  restoreRecordAt(records, { id: 3 }, 1);
  assert.deepEqual(records, original);
});

test("computeNextFocusedRowId focuses the first row when nothing is focused yet, regardless of direction", () => {
  assert.equal(computeNextFocusedRowId([10, 20, 30], null, "next"), 10);
  assert.equal(computeNextFocusedRowId([10, 20, 30], null, "prev"), 10);
});

test("computeNextFocusedRowId moves to the next/previous row while one is already focused", () => {
  assert.equal(computeNextFocusedRowId([10, 20, 30], 10, "next"), 20);
  assert.equal(computeNextFocusedRowId([10, 20, 30], 20, "next"), 30);
  assert.equal(computeNextFocusedRowId([10, 20, 30], 30, "prev"), 20);
  assert.equal(computeNextFocusedRowId([10, 20, 30], 20, "prev"), 10);
});

test("computeNextFocusedRowId clamps at both ends instead of wrapping around", () => {
  assert.equal(computeNextFocusedRowId([10, 20, 30], 30, "next"), 30, "must stay on the last row, not wrap to the first");
  assert.equal(computeNextFocusedRowId([10, 20, 30], 10, "prev"), 10, "must stay on the first row, not wrap to the last");
});

test("computeNextFocusedRowId restarts from the first row when the focused id is no longer in the visible set", () => {
  assert.equal(
    computeNextFocusedRowId([10, 20, 30], 999, "next"),
    10,
    "a focused id filtered out by a new search/filter must not silently keep tracking it",
  );
});

test("computeNextFocusedRowId returns null when there are no visible rows at all", () => {
  assert.equal(computeNextFocusedRowId([], 10, "next"), null);
});

test("isTypingTarget recognizes text inputs, textareas, selects, and contenteditable regions", () => {
  assert.equal(isTypingTarget({ tagName: "input" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "select" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
});

test("isTypingTarget returns false for ordinary elements and no target at all", () => {
  assert.equal(isTypingTarget({ tagName: "DIV" }), false);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
});

test("isInlineEditableField allows every field type except relation", () => {
  const types: Field["type"][] = ["text", "longtext", "number", "boolean", "enum", "date"];
  for (const type of types) {
    assert.equal(isInlineEditableField({ name: "f", type } as Field), true, `expected ${type} to be inline-editable`);
  }
  assert.equal(
    isInlineEditableField({ name: "courierId", type: "relation", relationTo: "Courier" } as Field),
    false,
    "a relation field's cell shows a label resolved from a different record, so it must stay excluded from inline editing",
  );
});

/**
 * New in this round: the ordinary table gets its own grouping (distinct
 * from the Kanban board's own single auto-picked field, see groupByField
 * above) -- isGroupableField restricts it to enum/boolean fields, the same
 * finite-value-space fields findBoardField already only ever considers for
 * the board view, since an unbounded field would produce one group per
 * distinct value.
 */
test("isGroupableField allows only enum and boolean fields", () => {
  assert.equal(isGroupableField({ name: "status", type: "enum" } as Field), true);
  assert.equal(isGroupableField({ name: "isBillable", type: "boolean" } as Field), true);
  for (const type of ["text", "longtext", "number", "date", "relation"] as Field["type"][]) {
    assert.equal(isGroupableField({ name: "f", type } as Field), false, `expected ${type} to NOT be groupable`);
  }
});

test("groupRecordsByField groups by an enum field in the field's own declared order, with an 'other' bucket for a stale value no longer in enumValues", () => {
  const t = (key: string) => translate("en", key);
  const field: Field = {
    name: "status",
    type: "enum",
    required: true,
    enumValues: ["New", "Won", "Lost"],
    enumLabels: { New: "New", Won: "Won ✅", Lost: "Lost ❌" },
  };
  const records = [
    { id: 1, status: "Won" },
    { id: 2, status: "New" },
    { id: 3, status: "Archived" }, // a legacy value no longer declared
    { id: 4, status: "Won" },
  ];
  const groups = groupRecordsByField(records, field, t);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["New", "Won", "__other__"],
    "must follow the enum's own declared order (New, Won, Lost), skip the empty Lost group entirely, and append one 'other' bucket at the end",
  );
  assert.equal(groups[1].label, "Won ✅");
  assert.deepEqual(
    groups.find((g) => g.key === "Won")!.records.map((r) => r.id),
    [1, 4],
  );
  assert.deepEqual(groups.find((g) => g.key === "__other__")!.records.map((r) => r.id), [3]);
});

test("groupRecordsByField groups by a boolean field into exactly true then false, omitting an empty side entirely", () => {
  const t = (key: string) => translate("en", key);
  const field: Field = { name: "isBillable", type: "boolean", required: false };
  const records = [
    { id: 1, isBillable: true },
    { id: 2, isBillable: false },
    { id: 3, isBillable: true },
  ];
  const groups = groupRecordsByField(records, field, t);
  assert.deepEqual(groups.map((g) => g.key), ["true", "false"]);
  assert.deepEqual(groups[0].records.map((r) => r.id), [1, 3]);
  assert.deepEqual(groups[1].records.map((r) => r.id), [2]);

  const allTrue = [{ id: 1, isBillable: true }];
  assert.deepEqual(
    groupRecordsByField(allTrue, field, t).map((g) => g.key),
    ["true"],
    "an empty side (no false records at all) must be omitted, not rendered as an empty group",
  );
});

test("sumNumericFields sums each number-type field across the given records, ignoring non-number fields entirely", () => {
  const fields: Field[] = [
    { name: "amount", type: "number", required: true },
    { name: "quantity", type: "number", required: false },
    { name: "name", type: "text", required: true },
  ];
  const records = [
    { id: 1, amount: 100, quantity: 2, name: "a" },
    { id: 2, amount: 250, quantity: 3, name: "b" },
    { id: 3, amount: 50, quantity: 1, name: "c" },
  ];
  assert.deepEqual(sumNumericFields(records, fields), { amount: 400, quantity: 6 });
});

test("sumNumericFields treats a missing or non-numeric value on a number field as 0 rather than producing NaN", () => {
  const fields: Field[] = [{ name: "amount", type: "number", required: false }];
  const records: EntityRecord[] = [{ id: 1, amount: 100 }, { id: 2 }, { id: 3, amount: "not a number" as unknown as number }];
  assert.deepEqual(sumNumericFields(records, fields), { amount: 100 });
});

test("sumNumericFields returns an empty object when there are no number fields", () => {
  const fields: Field[] = [{ name: "name", type: "text", required: true }];
  assert.deepEqual(sumNumericFields([{ id: 1, name: "a" }], fields), {});
});

test("sumNumericFields returns 0 totals for number fields when there are no records at all", () => {
  const fields: Field[] = [{ name: "amount", type: "number", required: false }];
  assert.deepEqual(sumNumericFields([], fields), { amount: 0 });
});

test("isDeadlineFieldName matches field names that actually mean a deadline, and rejects ordinary date fields", () => {
  assert.equal(isDeadlineFieldName("dueDate"), true, "the built-in Invoice/Task entities' own field name");
  assert.equal(isDeadlineFieldName("deadline"), true, "the built-in Task entity's own field name");
  assert.equal(isDeadlineFieldName("DueDate"), true, "case-insensitive");
  assert.equal(isDeadlineFieldName("dateOfBirth"), false, "a past date is normal, not overdue");
  assert.equal(isDeadlineFieldName("startDate"), false);
  assert.equal(isDeadlineFieldName("shipDate"), false);
  assert.equal(isDeadlineFieldName("joinedDate"), false);
});

test("getDateUrgency classifies a date relative to a fixed reference day, not real wall-clock time", () => {
  const today = new Date(2026, 5, 15); // June 15, 2026 -- a Monday, chosen arbitrarily
  assert.equal(getDateUrgency("2026-06-10", today), "overdue", "a date before today is overdue");
  assert.equal(getDateUrgency("2026-06-14", today), "overdue", "yesterday is overdue");
  assert.equal(getDateUrgency("2026-06-15", today), "dueSoon", "today itself reads as due-soon for its whole day, not yet overdue");
  assert.equal(getDateUrgency("2026-06-16", today), "dueSoon", "tomorrow is within the due-soon window");
  assert.equal(getDateUrgency("2026-06-17", today), "dueSoon", "the day after tomorrow is still within the 3-day window");
  assert.equal(getDateUrgency("2026-06-18", today), null, "4 days out is far enough away to need no styling at all");
  assert.equal(getDateUrgency("not-a-date", today), null, "an unparseable value must never be flagged");
});
