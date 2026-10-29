import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, EntityRecord, Field } from "@forge/shared";
import { translate } from "./i18n/language.js";
import {
  badgeTone,
  buildCalendarMonth,
  buildImportRecords,
  buildImportRecordsFromJson,
  calendarChipLabelField,
  calendarChipLabelValue,
  computeNextFocusedRowId,
  enterTargetsInteractiveElement,
  findBoardField,
  findDateField,
  findEndDateField,
  findFilterableFields,
  findPhoneField,
  findRecordPhoneNumber,
  findSinglePhoneFieldTarget,
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
  recordsToJson,
  relationDisplayLabel,
  restoreRecordAt,
  scrollIntoViewRespectingMotion,
  searchEntityRecords,
  selectedOrAllRecords,
  sortRecords,
  sortRecordsMulti,
  splitHighlightSegments,
  splitLinkSegments,
  sumNumericFields,
  uniqueEnumValues,
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

/**
 * Regression test for a real bug found by a round 458 Explore survey
 * targeting the same bug class this file's "Inactive" test above already
 * covers, but outside domainEntities.ts: every POSITIVE_WORDS entry has a
 * common real-world negated counterpart ("paid" -> "unpaid", "approved"
 * -> "unapproved"/"disapproved", etc.) that contains the positive word as
 * a literal substring, so without being listed in NEGATIVE_WORDS too,
 * each was misread as a positive (green) badge -- the exact opposite of
 * its meaning. This function's own doc comment says it exists specifically
 * to classify freeform AI-generated enum values, where these are ordinary,
 * expected status terms.
 */
test("badgeTone recognizes common 'un-'/'dis-' negated status words as negative, not positive from matching their root word as a substring", () => {
  assert.equal(badgeTone("Unpaid"), "negative");
  assert.equal(badgeTone("Paid"), "positive");
  assert.equal(badgeTone("Undelivered"), "negative");
  assert.equal(badgeTone("Delivered"), "positive");
  assert.equal(badgeTone("Unconfirmed"), "negative");
  assert.equal(badgeTone("Confirmed"), "positive");
  assert.equal(badgeTone("Unapproved"), "negative");
  assert.equal(badgeTone("Disapproved"), "negative");
  assert.equal(badgeTone("Approved"), "positive");
  assert.equal(badgeTone("Unqualified"), "negative");
  assert.equal(badgeTone("Disqualified"), "negative");
  assert.equal(badgeTone("Qualified"), "positive");
  assert.equal(badgeTone("Unshipped"), "negative");
  assert.equal(badgeTone("Shipped"), "positive");
});

/**
 * Round 872's finding: the same negated-positive-word collision round 458
 * fixed for "unpaid"/"undelivered"/etc. also applied to "success"/
 * "completed" -- two more POSITIVE_WORDS entries -- just never checked.
 * "Unsuccessful" and "NotCompleted" (the raw, no-space shape a PascalCase
 * enum value like that lowercases to) each contain their positive
 * counterpart as a literal substring, so they were misread as a positive
 * (green) badge, the exact opposite of their meaning -- confirmed with a
 * real repro against this exact exported function before fixing. A
 * freeform AI-generated enum value also isn't guaranteed to collapse the
 * space the way a PascalCase name would, so "Not Completed" (with a
 * space) is covered too.
 */
test("badgeTone recognizes 'Unsuccessful' and 'NotCompleted'/'Not Completed' as negative, not positive from matching 'success'/'completed' as a substring", () => {
  assert.equal(badgeTone("Unsuccessful"), "negative");
  assert.equal(badgeTone("Successful"), "positive");
  assert.equal(badgeTone("NotCompleted"), "negative");
  assert.equal(badgeTone("Not Completed"), "negative");
  assert.equal(badgeTone("Completed"), "positive");
});

/**
 * Round 873's finding: the same negated-positive-word collision rounds 458
 * and 872 fixed also applied to "won"/"active" -- two more POSITIVE_WORDS
 * entries -- just never checked. "NotWon"/"Not Won" and "NotActive"/"Not
 * Active" each contain their positive counterpart as a literal substring,
 * so they were misread as a positive (green) badge, the exact opposite of
 * their meaning -- confirmed with a real repro against this exact exported
 * function before fixing. "NotActive" is a genuinely different spelling
 * from "Inactive" (already in NEGATIVE_WORDS), not merely its no-space/
 * space variant, so it needed its own entry. Deal/Opportunity's own
 * built-in "Won"/"Lost" status pair (see spec-engine/domainEntities.ts)
 * makes "Not Won" an obvious variant a user or AI-generated spec would
 * reach for.
 */
test("badgeTone recognizes 'NotWon'/'Not Won' and 'NotActive'/'Not Active' as negative, not positive from matching 'won'/'active' as a substring", () => {
  assert.equal(badgeTone("NotWon"), "negative");
  assert.equal(badgeTone("Not Won"), "negative");
  assert.equal(badgeTone("Won"), "positive");
  assert.equal(badgeTone("NotActive"), "negative");
  assert.equal(badgeTone("Not Active"), "negative");
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

/**
 * Round 703: formatNumberValue gained an optional third `options` parameter
 * so BusinessTwinPanel.tsx's stat tiles (which need Intl.NumberFormat's
 * maximumFractionDigits to show an average like "41.7" rather than a long
 * float) could reuse this same locale-aware helper instead of calling
 * toLocaleString() directly with no locale argument at all -- the exact
 * cross-feature convention this function already exists to provide.
 */
test("formatNumberValue forwards Intl.NumberFormatOptions through to toLocaleString, e.g. to round a float for display", () => {
  assert.equal(formatNumberValue(1234.567, "en", { maximumFractionDigits: 1 }), "1,234.6");
  assert.equal(formatNumberValue(1234567, "en"), "1,234,567", "omitting options must still work exactly as before");
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
 * Regression test: a number field's table cell actually shown on screen
 * (EntityPanel.tsx) renders through formatNumberValue, which adds locale
 * thousands separators (1500 -> "1,500") -- but matchesSearch fell through
 * to the field's own plain String(value) ("1500"), so a user typing back
 * the exact digits they can see on screen, comma included, got zero
 * matches for a record they're looking right at. Both the plain and the
 * formatted representation must still match, so neither a pre-existing
 * habit of typing bare digits nor the new comma-formatted search breaks.
 */
test("matchesSearch matches a number field's locale-formatted display (with thousands separators), not just its raw digits", () => {
  const fields: Field[] = [{ name: "total", type: "number", required: true }];
  const record = { total: 1500 };
  assert.ok(matchesSearch(record, fields, "1500", undefined, undefined, "en"));
  assert.ok(matchesSearch(record, fields, "1,500", undefined, undefined, "en"));
  assert.ok(!matchesSearch(record, fields, "9999", undefined, undefined, "en"));
});

test("matchesSearch's number-field comma-matching defaults to \"en\" when no lang is given, instead of throwing", () => {
  const fields: Field[] = [{ name: "total", type: "number", required: true }];
  const record = { total: 1500 };
  assert.ok(matchesSearch(record, fields, "1,500"));
});

/**
 * Round 475: a date field had the identical gap to the relation/number
 * fields fixed above (round 271/415), for the identical reason, and was
 * simply missed when those fixes were made -- round 195 originally named
 * date alongside number/relation/enum as a display/match mismatch, but
 * only number/relation/enum were ever actually fixed in matchesSearch
 * itself. The table cell actually shown on screen (EntityPanel.tsx) renders
 * a date field through formatDateValue ("2026-03-15" -> "3/15/2026" in en),
 * but this matched against the raw stored "YYYY-MM-DD" string, so a user
 * typing back the exact date they can see on screen found nothing.
 */
test("matchesSearch matches a date field's locale-formatted display, not just its raw YYYY-MM-DD value", () => {
  const fields: Field[] = [{ name: "dueDate", type: "date", required: true }];
  const record = { dueDate: "2026-03-15" };
  assert.ok(matchesSearch(record, fields, "2026-03-15", undefined, undefined, "en"));
  assert.ok(matchesSearch(record, fields, "3/15/2026", undefined, undefined, "en"));
  assert.ok(!matchesSearch(record, fields, "4/15/2026", undefined, undefined, "en"));
});

test("matchesSearch's date-field display-matching defaults to \"en\" when no lang is given, instead of throwing", () => {
  const fields: Field[] = [{ name: "dueDate", type: "date", required: true }];
  const record = { dueDate: "2026-03-15" };
  assert.ok(matchesSearch(record, fields, "3/15/2026"));
});

test("matchesSearch's date-field matching falls back to the raw stored value for an unparseable date, instead of throwing", () => {
  const fields: Field[] = [{ name: "dueDate", type: "date", required: true }];
  const record = { dueDate: "not-a-real-date" };
  assert.ok(matchesSearch(record, fields, "not-a-real-date", undefined, undefined, "en"));
});

/**
 * Round 671: a boolean field had a related but distinct gap to the number/
 * date fields fixed above (round 271/475) -- isGroupableField/
 * findFilterableFields already treat boolean the same as enum for every
 * other "small, fixed value space" UI (the group-by header and per-field
 * filter dropdown both show the real localized "Yes"/"No"), but this
 * matched the raw stored JS boolean's String(value) form ("true"/"false"),
 * text that appears nowhere in the actual UI -- the table cell itself
 * renders a checkmark/dash, not even that. Typing "Yes"/"No" (or "כן"/"לא"
 * in Hebrew) -- the exact words shown in the adjacent filter dropdown for
 * the same field -- found nothing.
 */
test("matchesSearch matches a boolean field's localized \"Yes\"/\"No\" display, not its raw \"true\"/\"false\" stored value", () => {
  const fields: Field[] = [{ name: "paid", type: "boolean", required: false }];
  assert.ok(matchesSearch({ paid: true }, fields, "Yes", undefined, undefined, "en"));
  assert.ok(matchesSearch({ paid: false }, fields, "No", undefined, undefined, "en"));
  assert.ok(!matchesSearch({ paid: true }, fields, "No", undefined, undefined, "en"));
  assert.ok(!matchesSearch({ paid: true }, fields, "true", undefined, undefined, "en"), "the raw stored value must not match -- it's never shown anywhere in the UI");
});

test("matchesSearch matches a boolean field's Hebrew \"כן\"/\"לא\" display when lang is \"he\"", () => {
  const fields: Field[] = [{ name: "paid", type: "boolean", required: false }];
  assert.ok(matchesSearch({ paid: true }, fields, "כן", undefined, undefined, "he"));
  assert.ok(matchesSearch({ paid: false }, fields, "לא", undefined, undefined, "he"));
  assert.ok(!matchesSearch({ paid: true }, fields, "לא", undefined, undefined, "he"));
});

test("matchesSearch's boolean-field matching defaults to \"en\" (\"Yes\"/\"No\") when no lang is given, instead of throwing", () => {
  const fields: Field[] = [{ name: "paid", type: "boolean", required: false }];
  assert.ok(matchesSearch({ paid: true }, fields, "Yes"));
});

/**
 * Round 673: matchesSearch had a branch for every field type except
 * "file", added in a later round than the enum/relation/number/date/
 * boolean fixes above and simply never ported to this one -- it fell
 * through to the generic String(value) fallback, matching against the
 * raw JSON upload descriptor (url/size/mimeType) instead of the filename
 * the table cell actually shows (via parseFileFieldValue, the exact
 * display fieldDisplayValue already uses for this same field type).
 */
test("matchesSearch matches a file field's displayed filename, not the raw JSON descriptor's url/size/mimeType", () => {
  const fields: Field[] = [{ name: "resume", type: "file", required: false }];
  const stored = JSON.stringify({ url: "/api/uploads/proj1/Applicant/abc123.pdf", name: "resume.pdf", size: 48213, mimeType: "application/pdf" });
  assert.ok(matchesSearch({ resume: stored }, fields, "resume.pdf"), "the exact filename shown in the table cell must match");
  assert.ok(!matchesSearch({ resume: stored }, fields, "uploads"), "the raw stored URL must not match -- it's never shown on screen");
  assert.ok(!matchesSearch({ resume: stored }, fields, "application"), "the raw stored mimeType must not match");
  assert.ok(!matchesSearch({ resume: stored }, fields, "48213"), "the raw stored byte size must not match");
});

test("matchesSearch never matches anything for a file field with no file chosen (empty string)", () => {
  const fields: Field[] = [{ name: "resume", type: "file", required: false }];
  assert.ok(!matchesSearch({ resume: "" }, fields, "resume"));
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

/**
 * Round 878: EntitySchema/ProductSpecSchema only enforce uniqueness on an
 * entity's `name` (findCaseInsensitiveDuplicateEntityNames/
 * findSanitizedIdentifierCollisions), never its display `label` -- so two
 * different entities (e.g. an active-customers table and an
 * archived-customers one) can legally share the identical label via the
 * already-shipped Entity Label editor. Without disambiguation, Global
 * Search's own per-entity result-group header would render two completely
 * indistinguishable headers for "Customers", each with its own "Go to tab"
 * button, with no way to tell which group (or which jump target) is which.
 */
test("searchEntityRecords disambiguates two entities that share the same label, the same way a field's own duplicate label is disambiguated", () => {
  const activeCustomer: Entity = {
    name: "ActiveCustomer",
    label: "Customers",
    fields: [{ name: "name", type: "text", required: true }],
  };
  const archivedCustomer: Entity = {
    name: "ArchivedCustomer",
    label: "Customers",
    fields: [{ name: "name", type: "text", required: true }],
  };
  const allEntities = [activeCustomer, archivedCustomer];
  const activeRecords = [{ id: 1, name: "Dana Levi" }];
  const archivedRecords = [{ id: 2, name: "Dana Cohen" }];

  const activeResult = searchEntityRecords(activeCustomer, activeRecords, "dana", 5, allEntities);
  const archivedResult = searchEntityRecords(archivedCustomer, archivedRecords, "dana", 5, allEntities);
  assert.ok(activeResult);
  assert.ok(archivedResult);
  assert.equal(activeResult!.entityLabel, "Customers (ActiveCustomer)", "a shared label must gain its own entity's unique name as a suffix");
  assert.equal(archivedResult!.entityLabel, "Customers (ArchivedCustomer)", "the sibling entity's own suffix must name itself, not the other entity");
  assert.notEqual(activeResult!.entityLabel, archivedResult!.entityLabel, "two entities sharing a label must never produce the identical displayed entityLabel");
});

test("searchEntityRecords leaves entityLabel bare when no other entity in allEntities shares its label", () => {
  const customer: Entity = { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] };
  const order: Entity = { name: "Order", label: "Orders", fields: [{ name: "total", type: "number", required: true }] };
  const records = [{ id: 1, name: "Dana Levi" }];
  const result = searchEntityRecords(customer, records, "dana", 5, [customer, order]);
  assert.ok(result);
  assert.equal(result!.entityLabel, "Customers", "a unique label must never gain a suffix");
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
 * Round 603's finding: sortRecords sorted ascending then called
 * .reverse() on the whole array for "desc" -- correct for the unique
 * values above, but tied records (same sort value) had their original
 * relative order flipped too, unlike a real stable "desc" sort (and
 * unlike sortRecordsMulti, its own sibling, which negates the comparator
 * per-key instead of reversing the whole result).
 */
test("sortRecords keeps tied records in their original relative order when sorting desc, not reversed", () => {
  const records = [{ id: 1, v: 5 }, { id: 2, v: 5 }, { id: 3, v: 2 }];
  const desc = sortRecords(records, "v", "desc");
  assert.deepEqual(
    desc.map((r) => r.id),
    [1, 2, 3],
    "the two tied v:5 records (id 1 then id 2) must keep that same relative order, not be reversed to id 2 then id 1",
  );
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

/**
 * Regression test: an enum field's table cell (EntityPanel.tsx) renders
 * `field.enumLabels?.[value] ?? value` -- the translated label, not the
 * raw stored enum value -- and matchesSearch already resolves it the same
 * way, but sortRecords never did. The fixture deliberately uses raw enum
 * values whose alphabetical order is the OPPOSITE of their labels'
 * alphabetical order (raw "P1" < "P3" ascending, but label "High" > "Low"
 * ascending), so a version that still sorts by the raw value would produce
 * a different, detectably wrong order instead of accidentally passing.
 */
test("sortRecords sorts an enum field by its translated label, not the raw stored enum value", () => {
  const fields: Field[] = [
    { name: "priority", type: "enum", required: true, enumValues: ["P1", "P3"], enumLabels: { P1: "Low", P3: "High" } },
  ];
  const records = [
    { id: 1, priority: "P1" }, // "Low"
    { id: 2, priority: "P3" }, // "High"
  ];
  const sorted = sortRecords(records, "priority", "asc", fields);
  assert.deepEqual(
    sorted.map((r) => r.id),
    [2, 1],
    "ascending by label puts \"High\" before \"Low\", the opposite of ascending by the raw \"P1\"/\"P3\" codes",
  );
});

test("sortRecords falls back to the raw enum value when a value has no enumLabels entry, instead of sorting by undefined", () => {
  const fields: Field[] = [{ name: "priority", type: "enum", required: true, enumValues: ["low", "high"] }];
  const records = [
    { id: 1, priority: "high" },
    { id: 2, priority: "low" },
  ];
  const sorted = sortRecords(records, "priority", "asc", fields);
  assert.deepEqual(sorted.map((r) => r.priority), ["high", "low"]);
});

test("sortRecords sorts a file field by its own filename, not the raw JSON upload descriptor", () => {
  const fields: Field[] = [{ name: "resume", type: "file", required: false }];
  const records = [
    { id: 1, resume: JSON.stringify({ url: "/api/uploads/p1/Applicant/zzz-random-id.pdf", name: "a-report.pdf", size: 1, mimeType: "application/pdf" }) },
    { id: 2, resume: JSON.stringify({ url: "/api/uploads/p1/Applicant/aaa-random-id.pdf", name: "z-report.pdf", size: 1, mimeType: "application/pdf" }) },
  ];
  const sorted = sortRecords(records, "resume", "asc", fields);
  assert.deepEqual(
    sorted.map((r) => r.id),
    [1, 2],
    "ascending by filename puts \"a-report.pdf\" (record 1) before \"z-report.pdf\" (record 2), the opposite of sorting by each record's raw JSON descriptor (whose url field, \"aaa...\" < \"zzz...\", would put record 2 first)",
  );
});

test("sortRecords treats a file field with no real upload (empty/invalid value) as sorting before one with a real filename", () => {
  const fields: Field[] = [{ name: "resume", type: "file", required: false }];
  const records = [
    { id: 1, resume: JSON.stringify({ url: "/api/uploads/p1/Applicant/x.pdf", name: "resume.pdf", size: 1, mimeType: "application/pdf" }) },
    { id: 2, resume: "" },
  ];
  const sorted = sortRecords(records, "resume", "asc", fields);
  assert.deepEqual(sorted.map((r) => r.id), [2, 1]);
});

test("sortRecordsMulti resolves an enum key to its translated label too, composing correctly with a non-enum tiebreaker key", () => {
  const fields: Field[] = [
    { name: "priority", type: "enum", required: true, enumValues: ["P1", "P3"], enumLabels: { P1: "Low", P3: "High" } },
    { name: "total", type: "number", required: true },
  ];
  const records = [
    { id: 1, priority: "P1", total: 50 }, // "Low"
    { id: 2, priority: "P3", total: 10 }, // "High"
    { id: 3, priority: "P3", total: 20 }, // "High"
  ];
  const sorted = sortRecordsMulti(
    records,
    [
      { field: "priority", direction: "asc" },
      { field: "total", direction: "asc" },
    ],
    fields,
  );
  assert.deepEqual(
    sorted.map((r) => r.id),
    [2, 3, 1],
    "\"High\" (resolved label) sorts first, tie-broken by total ascending, then \"Low\"",
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
 * Round 777: findRecordPhoneNumber is the per-RECORD counterpart to
 * findPhoneField above -- an entity with two phone-like fields (e.g.
 * "phone", an office line, declared before "mobile", the number that
 * actually receives WhatsApp messages) can have a record whose "phone" is
 * blank while its "mobile" holds a real number. Before this, the "Send
 * WhatsApp" row action read only the single field findPhoneField picked
 * for the whole entity, so that record's button never showed at all, even
 * though a real number was right there on a sibling field.
 */
test("findRecordPhoneNumber falls through to a sibling phone-like field when the first one is blank on this particular record", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "phone", type: "text", required: false },
    { name: "mobile", type: "text", required: false },
  ];
  const recordWithBlankOfficeLine = { id: 1, name: "Dana Levi", phone: "", mobile: "050-999-8888" };
  assert.equal(findRecordPhoneNumber(fields, recordWithBlankOfficeLine), "050-999-8888");
});

test("findRecordPhoneNumber prefers the first phone-like field's own value when it's actually set on this record", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "phone", type: "text", required: false },
    { name: "mobile", type: "text", required: false },
  ];
  const recordWithBothSet = { id: 1, name: "Dana Levi", phone: "03-555-1234", mobile: "050-999-8888" };
  assert.equal(findRecordPhoneNumber(fields, recordWithBothSet), "03-555-1234");
});

test("findRecordPhoneNumber returns null when every phone-like field is blank or missing on this record", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "phone", type: "text", required: false },
    { name: "mobile", type: "text", required: false },
  ];
  const recordWithNeitherSet = { id: 1, name: "Dana Levi", phone: "", mobile: null };
  assert.equal(findRecordPhoneNumber(fields, recordWithNeitherSet), null);
});

/**
 * Round 921: findSinglePhoneFieldTarget is WhatsAppPanel's own "which
 * entity+field does an unmatched message's phone number belong in" lookup --
 * the client-side counterpart to findPhoneField above, but across the whole
 * spec rather than one entity, since an unmatched message has no entity
 * context to begin with.
 */
test("findSinglePhoneFieldTarget picks the one entity+field when exactly one entity has a phone-like field", () => {
  const entities: Entity[] = [
    {
      name: "Lead",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "phone", type: "text", required: false },
      ],
    },
    {
      name: "Property",
      fields: [{ name: "address", type: "text", required: true }],
    },
  ];
  assert.deepEqual(findSinglePhoneFieldTarget(entities), { entityName: "Lead", fieldName: "phone" });
});

test("findSinglePhoneFieldTarget returns null when no entity has a phone-like field", () => {
  const entities: Entity[] = [
    {
      name: "Property",
      fields: [{ name: "address", type: "text", required: true }],
    },
  ];
  assert.equal(findSinglePhoneFieldTarget(entities), null);
});

test("findSinglePhoneFieldTarget returns null when more than one entity has a phone-like field -- no reliable way to pick one from a bare number alone", () => {
  const entities: Entity[] = [
    {
      name: "Lead",
      fields: [{ name: "phone", type: "text", required: false }],
    },
    {
      name: "Agent",
      fields: [{ name: "mobile", type: "text", required: false }],
    },
  ];
  assert.equal(findSinglePhoneFieldTarget(entities), null);
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

/**
 * Regression test for round 573's finding: DATE_FIELD_NAME_HINTS had no
 * "startdate" entry (unlike END_DATE_FIELD_NAME_HINTS, which does have
 * "enddate"), so a startDate/endDate pair only picked startDate as the
 * start field by luck of field-declaration order -- the built-in Rental
 * entity happens to declare startDate first, but an entity declaring
 * endDate first (equally valid JSON) silently picked endDate as the
 * "start" and lost the whole date range, since findEndDateField then had
 * nothing left to pair it with.
 */
test("findDateField picks startDate over endDate regardless of field-declaration order", () => {
  const fieldsEndFirst: Field[] = [
    { name: "guestName", type: "text", required: true },
    { name: "endDate", type: "date", required: false },
    { name: "startDate", type: "date", required: false },
  ];
  const start = findDateField(fieldsEndFirst)!;
  assert.equal(start.name, "startDate", "startDate must win even when endDate is declared first in the fields array");
  assert.equal(findEndDateField(fieldsEndFirst, start)?.name, "endDate", "endDate must still pair correctly as the range's end");
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

/**
 * Regression test for a real bug found by round 637's Explore survey: the
 * same label-collision gap round 635/636 already fixed in twin.ts and
 * calendarIcs.ts. A field's label is never enforced unique (only its name
 * is), so two fields on the same entity can legally share a label via the
 * Field Label editor -- here, two number fields both renamed to "Amount".
 * Before this fix, the CSV header row read "Amount,Amount" with no way to
 * tell which column held which value.
 */
test("recordsToCsv disambiguates two columns that share a label", () => {
  const fields: Field[] = [
    { name: "subtotal", label: "Amount", type: "number", required: true },
    { name: "shipping", label: "Amount", type: "number", required: true },
  ];
  const csv = recordsToCsv(fields, [{ subtotal: 800, shipping: 30 }], "en");
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Amount (subtotal),Amount (shipping)");
  assert.equal(lines[1], "800,30");
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

/**
 * Round 762 regression test: mirrors apps/api/src/displayField.ts's own
 * identical fix -- a plain "text" field and a "longtext" field are the
 * same free-text kind everywhere else in this codebase (AutomationsPanel.
 * tsx's phoneFields, pipeline.ts's seed-value check, migrate.ts's
 * type_changed branch), but pickDisplayField's "first text field" step
 * only ever checked "text", never "longtext". An entity like a feedback
 * form with no name/title/text field, only a longtext "message" and a
 * number "rating", would otherwise skip past "message" and land on
 * "rating" as the display field.
 */
test("pickDisplayField falls back to the first longtext field when there's no name/title/text field, but still prefers a real text field over it", () => {
  const feedback: Field[] = [
    { name: "rating", type: "number", required: true },
    { name: "message", type: "longtext", required: false },
  ];
  assert.equal(pickDisplayField({ name: "Feedback", fields: feedback })?.name, "message");

  const bothTextKinds: Field[] = [
    { name: "message", type: "longtext", required: false },
    { name: "summary", type: "text", required: false },
  ];
  assert.equal(
    pickDisplayField({ name: "Feedback", fields: bothTextKinds })?.name,
    "summary",
    "a real text field must still win over a longtext field, even when the longtext field is declared first",
  );
});

/**
 * A join/line-item entity (e.g. an Enrollment linking a Student to a
 * Course) can legitimately have no name/title/text field at all --
 * EntitySchema only requires at least one field, nothing requires a text
 * one. Without skipping relation fields in the last-resort fallback,
 * pickDisplayField would pick the first relation field, and
 * recordDisplayLabel/relationDisplayLabel would then render that field's
 * raw stored value -- the *related* record's own internal id, e.g. "4" --
 * as if it were this record's own human label, everywhere a record is
 * shown by name (a relation field's own picker options, CSV export/
 * import's relation-cell matching, the "Group by"/filter dropdowns).
 */
test("pickDisplayField skips a relation field in its last-resort fallback, preferring any other non-relation field instead", () => {
  const enrollmentFields: Field[] = [
    { name: "studentId", type: "relation", relationTo: "Student", required: true },
    { name: "grade", type: "enum", required: false, enumValues: ["A", "B", "C"] },
    { name: "courseId", type: "relation", relationTo: "Course", required: true },
  ];
  assert.equal(
    pickDisplayField({ name: "Enrollment", fields: enrollmentFields })?.name,
    "grade",
    "with no name/title/text field, the first non-relation field (grade) must win over the first-declared relation field (studentId)",
  );

  const allRelations: Field[] = [
    { name: "userId", type: "relation", relationTo: "User", required: true },
    { name: "groupId", type: "relation", relationTo: "Group", required: true },
  ];
  assert.equal(
    pickDisplayField({ name: "Membership", fields: allRelations })?.name,
    "userId",
    "there's nothing else to fall back to when literally every field is a relation, so the first field regardless is the only option left",
  );
});

/**
 * Round 749: the same gap round 741's own test above covers for a
 * relation field, but for "file" -- a document-centric join entity (e.g.
 * an Enrollment linking a Student to a Course, with the signed
 * certificate attached) can just as legitimately have no name/title/text
 * field, with a file field in the mix instead of/alongside relations.
 * Without skipping "file" too in the last-resort fallback,
 * recordDisplayLabel would String() the file's raw JSON upload descriptor
 * ({url,name,size,mimeType}) as this record's own human label.
 */
test("pickDisplayField skips a file field in its last-resort fallback, preferring any other displayable field instead", () => {
  const enrollmentFields: Field[] = [
    { name: "studentId", type: "relation", relationTo: "Student", required: true },
    { name: "certificate", type: "file", required: false },
    { name: "grade", type: "enum", required: false, enumValues: ["A", "B", "C"] },
  ];
  assert.equal(
    pickDisplayField({ name: "Enrollment", fields: enrollmentFields })?.name,
    "grade",
    "with no name/title/text field, the enum field (grade) must win over both the relation (studentId) and the file field (certificate)",
  );

  const relationsAndFileOnly: Field[] = [
    { name: "studentId", type: "relation", relationTo: "Student", required: true },
    { name: "certificate", type: "file", required: false },
  ];
  assert.equal(
    pickDisplayField({ name: "Enrollment", fields: relationsAndFileOnly })?.name,
    "studentId",
    "when every remaining field is either a relation or a file, there's nothing else to fall back to but the first field regardless",
  );
});

/**
 * Round 793: the name-hint step itself never checked field type, unlike
 * the last-resort step just above (which explicitly skips relation/file).
 * An Employee entity whose "title" field is a relation to a normalized
 * JobTitle lookup entity (a perfectly reasonable real-world schema) would
 * have pickDisplayField return that relation field purely because it's
 * named "title" -- before the later, type-aware steps ever got a chance
 * to prefer the plain "department" text field instead. recordDisplayLabel
 * would then String() the raw foreign-key id as the employee's own label,
 * everywhere one is shown by name (a relation picker's own cells, CSV
 * import's relation-cell matching, Business Twin's narrative sentences).
 */
test("pickDisplayField skips a relation field even when it's literally named 'title', preferring a later text field instead", () => {
  const employeeFields: Field[] = [
    { name: "title", type: "relation", relationTo: "JobTitle", required: true },
    { name: "department", type: "text", required: false },
  ];
  assert.equal(
    pickDisplayField({ name: "Employee", fields: employeeFields })?.name,
    "department",
    "a relation field named 'title' must not win just by name -- the plain text field (department) should win instead",
  );
});

/**
 * Same gap, for "file" -- a Document entity whose uploaded-file field
 * happens to be named "name" would otherwise win by name alone, and
 * recordDisplayLabel would String() the file's raw JSON upload descriptor
 * ({url,name,size,mimeType}) as the record's own label.
 */
test("pickDisplayField skips a file field even when it's literally named 'name', preferring a later text field instead", () => {
  const documentFields: Field[] = [
    { name: "name", type: "file", required: true },
    { name: "category", type: "text", required: false },
  ];
  assert.equal(
    pickDisplayField({ name: "Document", fields: documentFields })?.name,
    "category",
    "a file field named 'name' must not win just by name -- the plain text field (category) should win instead",
  );
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

/**
 * Round 778: this fallback used to grab the first OTHER field with no
 * type filtering at all, reachable when pickDisplayField itself returns
 * dateField (no name/title/text/longtext field, and the date field
 * happens to be the first field that isn't relation/file). CheckIn here
 * has no name/title/text field, so pickDisplayField lands on `date`
 * itself -- the unfiltered fallback would then pick `location`, a
 * relation field, showing a raw related-record id (or a blank chip when
 * null) instead of skipping it the same way pickDisplayField's own
 * fallback already does.
 */
test("calendarChipLabelField's last-resort fallback skips a relation field, the same way pickDisplayField already does, landing on a sibling field instead", () => {
  const dateField: Field = { name: "date", type: "date", required: true };
  const fields: Field[] = [
    dateField,
    { name: "location", type: "relation", relationTo: "Location", required: false },
    { name: "confirmed", type: "boolean", required: false },
  ];
  const entity: Entity = { name: "CheckIn", fields };
  assert.equal(calendarChipLabelField(entity, dateField).name, "confirmed");
});

test("calendarChipLabelField's last-resort fallback skips a file field too, falling back to dateField itself when nothing else qualifies", () => {
  const dateField: Field = { name: "date", type: "date", required: true };
  const fields: Field[] = [
    dateField,
    { name: "attachment", type: "file", required: false },
  ];
  const entity: Entity = { name: "Upload", fields };
  assert.equal(calendarChipLabelField(entity, dateField).name, "date", "with no other usable field, must fall back to dateField itself rather than the file field");
});

test("calendarChipLabelValue resolves a boolean display field to uppercase TRUE/FALSE, matching this codebase's own uniform convention", () => {
  const field: Field = { name: "confirmed", type: "boolean", required: false };
  assert.equal(calendarChipLabelValue(field, { id: 1, confirmed: true }, "en"), "TRUE");
  assert.equal(calendarChipLabelValue(field, { id: 1, confirmed: false }, "en"), "FALSE");
});

test("calendarChipLabelValue resolves an enum display field through its own enumLabels, not the raw stored key", () => {
  const field: Field = {
    name: "stage",
    type: "enum",
    required: false,
    enumValues: ["in", "out"],
    enumLabels: { in: "כניסה", out: "יציאה" },
  };
  assert.equal(calendarChipLabelValue(field, { id: 1, stage: "in" }, "en"), "כניסה");
});

test("calendarChipLabelValue returns a blank string for a null/undefined/missing value, instead of the literal word 'null'", () => {
  const field: Field = { name: "notes", type: "text", required: false };
  assert.equal(calendarChipLabelValue(field, { id: 1, notes: null }, "en"), "");
  assert.equal(calendarChipLabelValue(field, { id: 1 }, "en"), "");
});

/**
 * Round 1048: calendarChipLabelField's own last-resort fallback lands on a
 * `date` label field exactly as readily as it does on a boolean/enum one
 * (an entity with two+ date fields and no name/title/text/longtext field,
 * e.g. Flight{ departureDate, returnDate, confirmed: boolean }) -- before
 * this round, calendarChipLabelValue had no `date` branch at all, so it
 * fell through to the raw unformatted "YYYY-MM-DD" string instead of a
 * real formatted date, the same gap the boolean/enum branches above this
 * one already closed. Reuses formatDateValue, this file's own established
 * date-display convention for showing a date field to a person.
 */
test("calendarChipLabelValue resolves a date display field to a formatted date, not the raw 'YYYY-MM-DD' string", () => {
  const field: Field = { name: "returnDate", type: "date", required: false };
  assert.equal(calendarChipLabelValue(field, { id: 1, returnDate: "2026-04-02" }, "en"), "4/2/2026");
  assert.equal(calendarChipLabelValue(field, { id: 1, returnDate: "2026-04-02" }, "he"), "2.4.2026");
});

/**
 * Round 1229: mirrors recordDisplayLabel's own round-1227 number-branch
 * fix -- the SAME last-resort fallback reasoning applies here (an entity
 * with no name/title/text/longtext/enum/boolean/date field, e.g.
 * DailyLog { loggedAt: date, temperature: number }, lands on the number
 * field as its own calendar day-chip's label), and calendarChipLabelValue
 * used to String() the raw un-grouped digits instead of a real locale-
 * formatted number.
 */
test("calendarChipLabelValue resolves a number display field to a locale-formatted number, not the raw ungrouped digits", () => {
  const field: Field = { name: "temperature", type: "number", required: false };
  assert.equal(calendarChipLabelValue(field, { id: 1, temperature: 1500 }, "en"), "1,500");
  const he = calendarChipLabelValue(field, { id: 1, temperature: -150 }, "he");
  assert.equal(he, "-150", "must honor the given lang and strip the invisible bidi mark before a negative number's minus sign");
  assert.ok(!he.includes("‎") && !he.includes("‏"), "must contain no invisible bidi mark at all");
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

/**
 * Round 761 regression test: mirrors apps/api/src/displayField.ts's own
 * identical fix -- when pickDisplayField's last-resort fallback lands on
 * an enum field (no name/title/text field on the entity), recordDisplayLabel
 * used to String() its raw stored value instead of resolving it through
 * the field's own enumLabels, the uniform convention every other enum
 * render path in this file already follows (fieldDisplayValue,
 * matchesSearch, etc.).
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
    recordDisplayLabel(entity, { id: 3, studentId: 1, certificate: "", grade: "A" }),
    "מצטיין",
    "the enum field's own translated label must be shown, not the raw stored value \"A\"",
  );
});

/**
 * Round 771 regression test: the exact same bug class as round 761's enum
 * fix just above, never done for "boolean" -- when pickDisplayField's
 * last-resort fallback lands on a boolean field (e.g. a join/line-item
 * entity like Consent { studentId: relation, courseId: relation, signed:
 * boolean }, with no name/title/text field), recordDisplayLabel used to
 * String() the raw value ("true"/"false") instead of this app's own
 * uniform "TRUE"/"FALSE" convention (fieldDisplayValue, the automation-rule
 * display, the .ics export all already follow it).
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
    recordDisplayLabel(entity, { id: 5, studentId: 1, courseId: 1, signed: true }),
    "TRUE",
    "the boolean field's own uniform TRUE/FALSE convention must be shown, not the raw stored value \"true\"",
  );
  assert.equal(
    recordDisplayLabel(entity, { id: 6, studentId: 1, courseId: 2, signed: false }),
    "FALSE",
    "a false boolean display field must render FALSE, not fall through the empty-value check and then String() to \"false\"",
  );
});

/**
 * Round 968 regression test: the exact same bug class as the enum (761)
 * and boolean (771) fixes above, never done for "relation" -- when
 * pickDisplayField's own last-resort step lands on a relation field (a
 * pure join entity with no name/title/text/enum/boolean field at all,
 * only relations), recordDisplayLabel used to String() the raw *target*
 * foreign-key id as this record's own label. That's the related PARENT's
 * id, not this record's own -- two different Membership rows for the
 * same user (different groups) share the exact same userId, so both
 * rendered the identical, genuinely ambiguous label "4" with no way to
 * tell them apart in a relation picker, CSV export, or WhatsApp template.
 */
test("recordDisplayLabel falls back to this record's own #<id>, not the relation field's raw target id, when the display field is itself a relation", () => {
  const entity: Entity = {
    name: "Membership",
    fields: [
      { name: "userId", type: "relation", relationTo: "User", required: true },
      { name: "groupId", type: "relation", relationTo: "Group", required: true },
    ],
  };
  const membership1 = { id: 1, userId: 4, groupId: 10 };
  const membership2 = { id: 2, userId: 4, groupId: 20 };
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

/**
 * Round 982 regression test: the exact same bug class as the enum (761),
 * boolean (771), and relation (968) fixes above, never done for "file" --
 * pickDisplayField's own doc comment already calls out this exact hazard
 * (round 749), but that round only ever fixed the EXCLUSION inside
 * pickDisplayField (skip file when something better exists), never this
 * safety net. An attachment/join entity like Enrollment { certificate:
 * file, studentId: relation->Student } has no name/title/text/enum/
 * boolean field at all, only a file and a relation -- when the file
 * field is declared FIRST, pickDisplayField's purely positional
 * last-resort step lands on it, and recordDisplayLabel used to String()
 * the file's raw JSON upload descriptor (including the server's internal
 * upload URL path) as the record's own label, everywhere one is shown by
 * name (Global Search, a relation picker, CSV export/import's relation-
 * cell matching, an Automation Rule's condition display).
 */
test("recordDisplayLabel falls back to this record's own #<id>, not the file field's raw JSON upload descriptor, when the display field is itself a file", () => {
  const entity: Entity = {
    name: "Enrollment",
    fields: [
      { name: "certificate", type: "file", required: false },
      { name: "studentId", type: "relation", relationTo: "Student", required: true },
    ],
  };
  const fileDescriptor = JSON.stringify({ url: "/api/uploads/proj1/Enrollment/1/certificate/abc.pdf", name: "cert.pdf", size: 123, mimeType: "application/pdf" });
  assert.equal(
    recordDisplayLabel(entity, { id: 5, certificate: fileDescriptor, studentId: 2 }),
    "#5",
    "must fall back to this record's own id, not String() the file's raw JSON upload descriptor as the label",
  );
});

/**
 * Round 1072 regression test: the exact same bug class as the enum (761),
 * boolean (771), relation (968), and file (982) fixes above, never done
 * for "date" -- an entity with no name/title/text/longtext field but a
 * genuine date field (e.g. DailyLog { loggedAt: date, temperature: number }),
 * has pickDisplayField's own last-resort step land on the date field
 * regardless, and recordDisplayLabel used to String() the raw unformatted
 * "YYYY-MM-DD" string as the record's own label -- everywhere one is
 * shown by name (a relation picker/cell, Global Search, Business Twin's
 * narrative sentences, a WhatsApp/email/webhook automation's own message
 * interpolation).
 */
test("recordDisplayLabel renders a date display field as a real formatted date, not the raw 'YYYY-MM-DD' string, honoring the given lang", () => {
  const entity: Entity = {
    name: "DailyLog",
    fields: [
      { name: "loggedAt", type: "date", required: true },
      { name: "temperature", type: "number", required: true },
    ],
  };
  assert.equal(
    recordDisplayLabel(entity, { id: 5, loggedAt: "2026-04-02", temperature: 21 }),
    "4/2/2026",
    "must render the date field as a real formatted date (default lang \"en\"), not the raw ISO string",
  );
  assert.equal(
    recordDisplayLabel(entity, { id: 5, loggedAt: "2026-04-02", temperature: 21 }, "he"),
    "2.4.2026",
    "must honor the given lang, matching formatDateValue's own he-IL formatting",
  );
});

/**
 * Round 1227: the exact same bug class as the enum (761), boolean (771),
 * relation (968), file (982), and date (1072) fixes above, never done for
 * "number" -- a measurement-only entity like `StockLevel { quantity:
 * number, warehouseId: relation->Warehouse }` has no name/title/text/
 * longtext/enum/boolean/date field at all, so pickDisplayField's own
 * last-resort step lands on the number field regardless, and
 * recordDisplayLabel used to String() the raw un-grouped digits as the
 * record's own label. Also confirms the invisible bidi mark toLocaleString
 * adds before a negative number's minus sign under "he" (round 1089's
 * finding) is stripped here too, matching automationsReport.ts's own
 * established convention.
 */
test("recordDisplayLabel renders a number display field with locale thousands separators, not the raw ungrouped digits, and strips the invisible bidi mark under 'he'", () => {
  const entity: Entity = {
    name: "StockLevel",
    fields: [
      { name: "quantity", type: "number", required: true },
      { name: "warehouseId", type: "relation", relationTo: "Warehouse", required: true },
    ],
  };
  assert.equal(
    recordDisplayLabel(entity, { id: 7, quantity: 1500, warehouseId: 2 }),
    "1,500",
    "must render the number field with real locale thousands separators (default lang \"en\"), not the raw \"1500\"",
  );
  const he = recordDisplayLabel(entity, { id: 7, quantity: -150, warehouseId: 2 }, "he");
  assert.equal(he, "-150", "must honor the given lang and strip the invisible bidi mark before a negative number's minus sign");
  assert.ok(!he.includes("‎") && !he.includes("‏"), "must contain no invisible bidi mark at all");
});

const courierEntity: Entity = {
  name: "Courier",
  fields: [{ name: "name", type: "text", required: true }],
};
const orderCourierField: Field = { name: "courierId", type: "relation", required: false, relationTo: "Courier" };

test("relationDisplayLabel resolves a relation field to the related record's display label, and falls back to #id when there's no match or no related entity/records at all", () => {
  const couriers = [{ id: 42, name: "Avi Mizrahi" }];
  assert.equal(relationDisplayLabel(orderCourierField, 42, [courierEntity], { Courier: couriers }), "Avi Mizrahi");
  assert.equal(relationDisplayLabel(orderCourierField, 999, [courierEntity], { Courier: couriers }), "#999", "no matching record");
  assert.equal(relationDisplayLabel(orderCourierField, 42, [], { Courier: couriers }), "#42", "target entity missing from allEntities");
  assert.equal(relationDisplayLabel(orderCourierField, 42, [courierEntity], {}), "#42", "no records at all for the related entity");
  assert.equal(relationDisplayLabel(orderCourierField, null, [courierEntity], { Courier: couriers }), "", "a null value is blank, not '#null'");
});

/**
 * Round 1162: mirrors the test above exactly, except the relation field's
 * own relationTo ("courier") differs from its real target entity's name
 * ("Courier") only by letter case -- the same genuinely plausible
 * AI-generated-spec scenario migrate.ts's own round-1159 fix addresses for
 * FK generation. Before this round, relationDisplayLabel's own exact-case
 * `allEntities.find((e) => e.name === field.relationTo)` would have
 * fallen back to "#<id>" here even with the related record already
 * present in relatedRecords (keyed by the SAME raw relationTo string a
 * real caller -- EntityPanel.tsx's own round-1162 fix -- fetches under).
 */
test("relationDisplayLabel still resolves a relation field when relationTo differs from its target entity's name only by letter case", () => {
  const caseMismatchedField: Field = { name: "courierId", type: "relation", required: false, relationTo: "courier" };
  const couriers = [{ id: 42, name: "Avi Mizrahi" }];
  assert.equal(relationDisplayLabel(caseMismatchedField, 42, [courierEntity], { courier: couriers }), "Avi Mizrahi");
});

/**
 * Regression test for round 386: relationDisplayLabel is called once per
 * relation field per row (table/board/calendar cells, CSV export, sorting,
 * global search) -- a table of N records with a relation field pointing at
 * an entity with M records used to call `records.find(...)` a full linear
 * scan of that entire M-length array, N separate times, O(N*M) total (the
 * exact same pattern round 385 fixed in backup.ts's own copy, just with
 * many more call sites here). Fixed with a WeakMap cache keyed on the
 * `records` array's own identity, built the first time a given array is
 * seen and reused for every subsequent lookup against that same array --
 * no call site changed, no signature changed. This proves the cache keys
 * correctly on array *identity*, not on relationTo's entity name or any
 * other derived key: two different array instances (simulating two
 * different data refreshes, or two different relation fields that happen
 * to point at entities sharing an id) must never cross-contaminate, and a
 * large dataset (2000 couriers) must still resolve correctly at both
 * extremes -- the first id inserted and the last, the position a
 * corrupted or short-circuited cache would most likely get wrong.
 */
test("relationDisplayLabel's internal cache never cross-contaminates between two different record arrays, even when they share the same stored ids", () => {
  const arrayA = [{ id: 1, name: "Avi from A" }];
  const arrayB = [{ id: 1, name: "Bar from B" }];
  assert.equal(relationDisplayLabel(orderCourierField, 1, [courierEntity], { Courier: arrayA }), "Avi from A");
  assert.equal(relationDisplayLabel(orderCourierField, 1, [courierEntity], { Courier: arrayB }), "Bar from B");
  // Re-querying the first array again afterward must still resolve to its own record, not the second array's.
  assert.equal(relationDisplayLabel(orderCourierField, 1, [courierEntity], { Courier: arrayA }), "Avi from A");
});

test("relationDisplayLabel resolves correctly across a large dataset (thousands of records), not just a tiny fixture", () => {
  const courierCount = 2000;
  const couriers = Array.from({ length: courierCount }, (_, i) => ({ id: i + 1, name: `Courier ${i}` }));
  assert.equal(relationDisplayLabel(orderCourierField, 1, [courierEntity], { Courier: couriers }), "Courier 0", "the first id inserted");
  assert.equal(
    relationDisplayLabel(orderCourierField, courierCount, [courierEntity], { Courier: couriers }),
    `Courier ${courierCount - 1}`,
    "the last id inserted",
  );
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

test("a value that genuinely starts with a literal apostrophe immediately followed by a guarded character round-trips exactly (a real bug: csvEscape and unescapeCsvGuard agreed only on content, so this collided byte-for-byte with csvEscape's own guard and lost the real apostrophe on import)", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "notes", label: "Notes", type: "text", required: false },
    { name: "handle", label: "Handle", type: "text", required: false },
    { name: "total", label: "Total", type: "text", required: false },
  ];
  const original = {
    name: "Dana",
    notes: "'-interesting",
    handle: "'@dana",
    total: "'=totals pending",
  };
  const csv = recordsToCsv(fields, [original], "en");
  const rows = parseCsv(csv);
  const { records, errors } = buildImportRecords(fields, rows);
  assert.deepEqual(errors, []);
  assert.deepEqual(records, [original]);
});

test("a value with multiple literal leading apostrophes round-trips exactly regardless of what follows them", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const original = { name: "''-double apostrophe" };
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
    ["Noa", "", "New"], // Round 1151: empty optional boolean stays null (never answered), not coerced to false
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [
    { name: "Dana", active: true, status: "New" },
    { name: "Yossi", active: true, status: "Won" },
    { name: "Noa", active: null, status: "New" },
  ]);
});

/**
 * Round 1151: buildImportRecords is this function's own designed inverse
 * of fieldDisplayValue (see buildImportRecords's own doc comment), so a
 * file this app exported should round-trip back in unchanged. Round 1134
 * made fieldDisplayValue export a never-answered (`null`) boolean as a
 * genuine blank cell, distinguishable from an explicit "FALSE" -- but
 * buildImportRecords still special-cased boolean alone to coerce that
 * exact blank cell back into an explicit `false`, unlike every other
 * optional field type on the same line (which correctly stays `null`).
 * Re-importing an unmodified export of a never-answered boolean silently
 * turned it into an explicit "No" -- a real round-trip data corruption,
 * not an honest no-op.
 */
test("a never-answered boolean's genuinely blank CSV cell round-trips through recordsToCsv + parseCsv + buildImportRecords back to null, not an explicit false", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "subscribed", type: "boolean", required: false },
  ];
  const record: EntityRecord = { id: 1, name: "Dana", subscribed: null, createdAt: "" };

  const csv = recordsToCsv(fields, [record], "en");
  const rows = parseCsv(csv);
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.records,
    [{ name: "Dana", subscribed: null }],
    "re-importing this app's own unmodified export must restore the field's own never-answered state, not an explicit false",
  );
});

/**
 * Regression test for a real bug found by round 1084's Explore survey:
 * FieldSchema.enumLabels (packages/shared) has no uniqueness constraint,
 * so two different declared enumValues can legitimately share the
 * identical display label -- the realistic way this happens is the same
 * "AI-generated spec" precondition uniqueEnumValues' own doc comment
 * already names for the sibling duplicate-raw-value gap, just for labels
 * instead (e.g. a Hebrew refine translating both "new" and "open" statuses
 * to the identical word). Before this round, the label-matching branch
 * called .find(), silently resolving to whichever value happened to come
 * first in enumValues -- a user exporting, editing, and re-importing a row
 * meant to be "open" would have it silently written back as "new" instead,
 * with zero error or warning. Mirrors the relation branch's own existing
 * ambiguity handling (count matches, reject when more than one) right
 * above it in the same function.
 */
test("buildImportRecords rejects an ambiguous enum label that matches more than one declared value, instead of silently resolving to whichever comes first", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "status", label: "Status", type: "enum", required: true, enumValues: ["new", "open"], enumLabels: { new: "פתוח", open: "פתוח" } },
  ];
  const rows = [
    ["name", "status"],
    ["Dana", "פתוח"], // ambiguous: both "new" and "open" share this exact label
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /matches more than one option for field "Status"/);
});

/**
 * The raw-value match must still win unambiguously even when a label
 * collision exists elsewhere on the same field -- an exported CSV cell
 * could hold either the display label or the field's own raw value (e.g.
 * a user typing the stored value directly instead of its ambiguous label),
 * and the raw-value branch is checked first precisely because it can never
 * itself be ambiguous.
 */
test("buildImportRecords still resolves an enum cell matched by its own raw value unambiguously, even when a DIFFERENT value's label collides with another", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "status", label: "Status", type: "enum", required: true, enumValues: ["new", "open"], enumLabels: { new: "פתוח", open: "פתוח" } },
  ];
  const rows = [
    ["name", "status"],
    ["Dana", "open"], // the raw value itself -- never ambiguous, even though its label is shared with "new"
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana", status: "open" }]);
});

/**
 * Round 514's finding: unlike number/enum/date (each of which rejects an
 * unparseable cell with a row-numbered error), a boolean cell had no
 * rejection path at all -- any value outside the exact true-list silently
 * became `false`, with zero entry in result.errors. For a Hebrew-first app,
 * a shop owner re-importing a spreadsheet with "כן"/"לא" (the natural way
 * to write yes/no by hand) got every true-valued row silently flipped to
 * false, reported as a clean, error-free import -- the single most
 * dangerous failure mode (quietly wrong data reported as success) in an
 * otherwise consistently-validated import path.
 */
test("buildImportRecords rejects an unrecognized boolean value instead of silently defaulting it to false", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "active", label: "Active", type: "boolean", required: false },
  ];
  const rows = [
    ["name", "Active"],
    ["Dana", "כן"], // Hebrew "yes" -- must resolve to true, not silently false
    ["Yossi", "לא"], // Hebrew "no" -- must resolve to false explicitly
    ["Noa", "maybe"], // unrecognized -- must be a row error, not a silent false
    ["Tal", "false"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, [
    { name: "Dana", active: true },
    { name: "Yossi", active: false },
    { name: "Tal", active: false },
  ]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Row 3.*"maybe".*Active/);
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

/**
 * Regression test (round 523): Number("Infinity")/Number("-Infinity") is
 * Infinity, not NaN, so a NaN-only check let it through as a "valid"
 * number -- but JSON.stringify silently turns Infinity/-Infinity into
 * null before the record ever reaches the server, so an unguarded
 * "Infinity" cell in a CSV import was reported as a successful,
 * error-free import while the value was actually discarded.
 */
test("buildImportRecords rejects \"Infinity\"/\"-Infinity\" as a number, instead of silently importing it as a value JSON.stringify will turn into null", () => {
  const fields: Field[] = [
    { name: "client", type: "text", required: true },
    { name: "amount", label: "Amount", type: "number", required: false },
  ];
  const rows = [
    ["client", "amount"],
    ["Acme Corp", "Infinity"],
    ["Beta LLC", "-Infinity"],
    ["Gamma Inc", "500"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, [{ client: "Gamma Inc", amount: 500 }]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /Row 1.*Amount/);
  assert.match(result.errors[1], /Row 2.*Amount/);
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

test("buildImportRecords accepts a date column value in the year 0-99 range, instead of wrongly rejecting it as invalid", () => {
  // new Date(Date.UTC(year, ...)) silently adds 1900 to a year 0-99 (legacy
  // ECMA-262 behavior), so isValidDateString's own round-trip check used to
  // fail a syntactically valid "0099-01-01" -- a real, well-formed date.
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "dueDate", label: "Due Date", type: "date", required: true },
  ];
  const rows = [
    ["name", "Due Date"],
    ["Tal", "0099-01-01"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.records, [{ name: "Tal", dueDate: "0099-01-01" }]);
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

test("buildImportRecords refuses the whole import for an entity with a required file field, since no CSV cell can ever supply one", () => {
  const fields: Field[] = [
    { name: "title", type: "text", required: true },
    { name: "attachment", label: "Attachment", type: "file", required: true },
  ];
  const rows = [["title", "Attachment"], ["Invoice", "not-real-json-garbage"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /required file field/);
  assert.match(result.errors[0], /Attachment/);
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

/**
 * Round 712: before this round, a relation field's CSV cell was always
 * ignored (see the two tests just above) -- even though recordsToCsv's own
 * export renders the exact same cell as a real, resolvable display label
 * (relationDisplayLabel), making a round-trip of your own export silently
 * drop every relation column's data. When the caller passes allEntities/
 * relatedRecords with the target entity's records already loaded (the real
 * production case -- EntityPanel.tsx already has both in scope), the cell
 * is now resolved back to the matching record's id the same way
 * relationDisplayLabel resolves it forward, including a *required*
 * relation field, which used to refuse the whole import outright.
 */
test("buildImportRecords resolves a relation cell to the matching related record's id when allEntities/relatedRecords are provided, including a required relation field", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: true, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [
    { id: 42, name: "Yossi Cohen" },
    { id: 7, name: "Dana Levi" },
  ];
  const rows = [["name", "Courier"], ["Order A", "Yossi Cohen"], ["Order B", "Dana Levi"]];
  const result = buildImportRecords(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [
    { name: "Order A", courierId: 42 },
    { name: "Order B", courierId: 7 },
  ]);
});

/**
 * Round 1177: mirrors the test above exactly, except the relation field's
 * own relationTo ("courier") differs from its real target entity's name
 * ("Courier") only by letter case -- the same genuinely plausible
 * AI-generated-spec scenario relationDisplayLabel's own round-1162 fix
 * already covers for display. Before this round, relationResolvable's
 * exact-case `allEntities.some((e) => e.name === f.relationTo)` treated
 * this REQUIRED relation field as entirely unresolvable, refusing the
 * whole import outright -- even though relatedRecords already held the
 * courier records, keyed by the SAME raw relationTo string ("courier")
 * EntityPanel.tsx's own fetch effect (round 1162) populates it under.
 */
test("buildImportRecords still resolves a required relation cell when relationTo differs from its target entity's name only by letter case", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: true, relationTo: "courier" },
  ];
  const couriers: EntityRecord[] = [{ id: 42, name: "Yossi Cohen" }];
  const rows = [["name", "Courier"], ["Order A", "Yossi Cohen"]];
  const result = buildImportRecords(fields, rows, [courierEntity], { courier: couriers });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Order A", courierId: 42 }]);
});

test("buildImportRecords accepts a relation cell's literal \"#<id>\" form, falling back to it only once no related record's own resolved display label matches the cell", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [{ id: 999, name: "Dana Levi" }];
  const rows = [["name", "Courier"], ["Order A", "#999"]];
  const result = buildImportRecords(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Order A", courierId: 999 }]);
});

test("buildImportRecords resolves a relation cell to the record whose own display label literally reads \"#<digits>\", instead of misreading it as that digit's raw id (a real bug: a record's display field can legitimately hold a SKU/ticket-style value like \"#5\", and exporting it renders that genuine, resolved label -- not the \"no label\" fallback -- so re-importing it must not be mistaken for an id reference)", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [
    { id: 5, name: "Yossi Cohen" },
    { id: 42, name: "#5" },
  ];
  const rows = [["name", "Courier"], ["Order A", "#5"]];
  const result = buildImportRecords(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Order A", courierId: 42 }]);
});

test("buildImportRecords rejects a \"#<id>\" relation cell whose id doesn't match any related record, instead of silently importing a dangling reference", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [{ id: 42, name: "Yossi Cohen" }];
  const rows = [["name", "Courier"], ["Order A", "#999"]];
  const result = buildImportRecords(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /doesn't match any Courier record/);
});

test("buildImportRecords reports a row error for a relation cell that matches no related record, instead of silently dropping it", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [{ id: 42, name: "Yossi Cohen" }];
  const rows = [["name", "Courier"], ["Order A", "Someone Else"]];
  const result = buildImportRecords(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /doesn't match any Courier record/);
});

test("buildImportRecords reports a row error asking for the \"#<id>\" form when a relation cell's label matches more than one related record, instead of silently guessing wrong", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [
    { id: 1, name: "Yossi Cohen" },
    { id: 2, name: "Yossi Cohen" },
  ];
  const rows = [["name", "Courier"], ["Order A", "Yossi Cohen"]];
  const result = buildImportRecords(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /matches more than one Courier record/);
  assert.match(result.errors[0], /#<id>/);
});

test("buildImportRecords still reports a missing-required-field error for a blank relation cell even when relatedRecords are provided", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: true, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [{ id: 42, name: "Yossi Cohen" }];
  const rows = [["name", "Courier"], ["Order A", ""]];
  const result = buildImportRecords(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /missing required field "Courier"/);
});

test("buildImportRecords ignores an unmatched CSV column instead of erroring on it", () => {
  const fields: Field[] = [{ name: "name", type: "text", required: true }];
  const rows = [["name", "internal notes"], ["Dana", "vip, handle with care"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana" }]);
});

/**
 * Real bug found by round 481's Explore survey: matchesHeader compared a
 * blank header against `(field.label ?? "").toLowerCase()`, which is
 * itself "" for any field with no label set -- so a genuinely blank/
 * unnamed CSV column (a stray trailing comma, an unlabeled spreadsheet
 * column) matched the FIRST unlabeled field instead of being ignored the
 * way a column with real, unmatched text already is (see the test right
 * above). Most entities have no field labels at all in English-mode specs
 * (domainEntities.ts only sets .label under the Hebrew path), so this was
 * genuinely reachable, not theoretical. Confirms a blank header column's
 * data is now dropped instead of silently landing in `notes`.
 */
test("buildImportRecords ignores a blank/unnamed CSV column instead of binding it to the first unlabeled field", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "notes", type: "text", required: false },
  ];
  const rows = [["name", ""], ["Dana", "this is garbage from an unrelated blank column"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.records,
    [{ name: "Dana", notes: null }],
    "the blank-header column's garbage text must not land in notes (or any other field) -- notes must stay null, same as any other unmatched optional field",
  );
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

/**
 * Regression test for a real bug found by round 657's Explore survey: the
 * test right above predates round 637's recordsToCsv disambiguation fix and
 * only ever used literal identical headers ("Status","Status"), so it never
 * actually exercised the header format recordsToCsv has emitted for
 * same-labeled fields since round 637 -- "Amount (subtotal)", not "Amount".
 * matchesHeader only ever compared a header against a field's bare name or
 * bare label, never against that disambiguated fieldDisplayLabel form, so
 * re-importing a CSV this app itself had just exported for an entity with
 * any same-labeled fields matched neither column to either field: both
 * came back null with zero errors reported, silently destroying the data
 * the round-637 fix was meant to protect in the first place. Runs the real
 * round-trip end to end (recordsToCsv -> parseCsv -> buildImportRecords) to
 * confirm the fields actually survive it now.
 */
test("two same-labeled fields' CSV export round-trips back through buildImportRecords without losing either column's data", () => {
  const fields: Field[] = [
    { name: "subtotal", label: "Amount", type: "number", required: true },
    { name: "shipping", label: "Amount", type: "number", required: true },
  ];
  const csv = recordsToCsv(fields, [{ subtotal: 800, shipping: 30 }], "en");
  const rows = parseCsv(csv);
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.records,
    [{ subtotal: 800, shipping: 30 }],
    "both same-labeled columns must round-trip back to their own field's real value, not null",
  );
});

/**
 * Round 683: a real bug found by the survey -- CSV import always created a
 * new record, even when re-importing a file the app itself had just
 * exported, because nothing in the export/import round trip carried a
 * record's own id. recordsToCsv's default (no 6th argument) must still
 * produce exactly the id-free CSV every existing caller/test above
 * depends on -- this is the "opt-in, not a behavior change" half of the fix.
 */
test("recordsToCsv omits the id column by default, unchanged from before round 683", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const csv = recordsToCsv(fields, [{ id: 7, name: "Dana" }], "en");
  assert.equal(csv, "Name\r\nDana", "with no 6th argument, the id must never appear in the header or the row");
});

test("recordsToCsv prepends a leading \"id\" column when includeId is true", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const csv = recordsToCsv(fields, [{ id: 7, name: "Dana" }], "en", [], {}, true);
  assert.equal(csv, "id,Name\r\n7,Dana", "includeId must put the record's real id first, ahead of every real field column");
});

/**
 * Round 1217: unlike recordsToCsv (deliberately lossy -- display text a
 * human reading a spreadsheet wants), recordsToJson must round-trip the
 * REAL stored value for every type: a real number (not a numeric
 * string), a real boolean (not "TRUE"/0/1), and the raw enum value/
 * relation id (not its resolved display label) -- with no allEntities/
 * relatedRecords/lang parameters at all, since there's no display
 * resolution to do.
 */
test("recordsToJson preserves each field's real stored value -- a real number, a real boolean, and the raw enum value/relation id, not a display label", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Won"], enumLabels: { New: "New lead" } },
    { name: "active", label: "Active", type: "boolean", required: false },
    { name: "amount", label: "Amount", type: "number", required: false },
    { name: "customerId", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
  ];
  const records = [{ id: 7, name: "Dana", status: "New", active: true, amount: 1234, customerId: 42 }];
  const parsed = JSON.parse(recordsToJson(fields, records)) as Array<Record<string, unknown>>;
  assert.deepEqual(parsed, [{ id: 7, name: "Dana", status: "New", active: true, amount: 1234, customerId: 42 }]);
});

test("recordsToJson always includes the record's own id, with no includeId flag needed (unlike recordsToCsv)", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const parsed = JSON.parse(recordsToJson(fields, [{ id: 3, name: "Dana" }])) as Array<Record<string, unknown>>;
  assert.deepEqual(parsed, [{ id: 3, name: "Dana" }]);
});

test("recordsToJson parses a file field's stored JSON-descriptor string into a real object, reusing parseFileFieldValue's own validation", () => {
  const fields: Field[] = [{ name: "attachment", label: "Attachment", type: "file", required: false }];
  const descriptor = JSON.stringify({ url: "/api/uploads/proj1/Customer/11111111-1111-1111-1111-111111111111.pdf", name: "contract.pdf", size: 500, mimeType: "application/pdf" });
  const parsed = JSON.parse(recordsToJson(fields, [{ id: 1, attachment: descriptor }])) as Array<Record<string, unknown>>;
  assert.deepEqual(parsed[0].attachment, {
    url: "/api/uploads/proj1/Customer/11111111-1111-1111-1111-111111111111.pdf",
    name: "contract.pdf",
    size: 500,
    mimeType: "application/pdf",
  });
});

test("recordsToJson emits null for an empty/missing file field, not an empty string or the string \"null\"", () => {
  const fields: Field[] = [{ name: "attachment", label: "Attachment", type: "file", required: false }];
  const parsed = JSON.parse(recordsToJson(fields, [{ id: 1, attachment: null }, { id: 2, attachment: "" }])) as Array<Record<string, unknown>>;
  assert.equal(parsed[0].attachment, null);
  assert.equal(parsed[1].attachment, null);
});

test("buildImportRecords resolves a valid \"id\" column into each record's own `id` key, leaving the field data unchanged", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [
    ["id", "Name"],
    ["7", "Dana"],
    ["12", "Noa"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [
    { id: 7, name: "Dana" },
    { id: 12, name: "Noa" },
  ]);
});

test("buildImportRecords treats a blank \"id\" cell as a brand-new record (no `id` key at all), not an error", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [
    ["id", "Name"],
    ["7", "Dana"],
    ["", "Amit"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ id: 7, name: "Dana" }, { name: "Amit" }]);
});

test("buildImportRecords rejects a non-numeric \"id\" cell with a clear row-numbered error, instead of silently importing it as a new record", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [
    ["id", "Name"],
    ["not-a-number", "Dana"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Row 1/);
  assert.match(result.errors[0], /not-a-number/);
});

/**
 * Round 1042: a duplicated row (copy/pasted as a template for a new one,
 * its id cell never blanked out) used to parse into two separate records
 * carrying the exact same id -- EntityPanel.tsx's handleImportFile fires
 * one independent updateRecord() per parsed record, concurrently via
 * Promise.allSettled, with no optimistic-locking/version check on the
 * server's plain last-write-wins PATCH route, so whichever request landed
 * last silently won and the other row's own distinct edit vanished with
 * zero error -- while both still counted as successful "updated" rows.
 */
test("buildImportRecords rejects every row after the first that reuses an already-seen id, instead of letting two rows silently race the same record", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [
    ["id", "Name"],
    ["7", "Dana"],
    ["7", "Noa"],
    ["12", "Amit"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.records, [{ id: 7, name: "Dana" }, { id: 12, name: "Amit" }], "only the first row for id 7 must be imported -- the second must be rejected, not silently raced against it");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Row 2/);
  assert.match(result.errors[0], /7/);
});

test("a real record's own CSV export round-trips through parseCsv -> buildImportRecords back to its own id, exercising the exact export/import pair handleExportCsv and handleImportFile actually use", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const csv = recordsToCsv(fields, [{ id: 42, name: "Globex" }], "en", [], {}, true);
  const rows = parseCsv(csv);
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ id: 42, name: "Globex" }], "re-parsing the app's own id-including export must resolve back to the same id");
});

test("buildImportRecords never confuses a field whose own label happens to be \"id\" with the reserved id column, since field names (unlike labels) can't be \"id\" at all", () => {
  // "id" is a reserved FIELD NAME (packages/shared's RESERVED_FIELD_NAMES),
  // not a reserved LABEL -- a user could still rename a field's display
  // label to "Id" via the Field Label editor. The reserved-name column is
  // matched by raw header text alone (not through matchesHeader), and a
  // real field can never be named "id", so there is no field for the
  // user-renamed label to collide with here; this just pins that a
  // same-named header still can't accidentally feed a real field's data.
  const fields: Field[] = [{ name: "customerId", label: "Id", type: "text", required: false }];
  const rows = [
    ["id", "Id"],
    ["5", "CUST-5"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ id: 5, customerId: "CUST-5" }]);
});

/**
 * Round 942: a header cell literally "id" alone was, before this round,
 * enough to trust a column as this app's own round-trip primary key --
 * but CSV import is equally meant for migrating in a genuinely external
 * spreadsheet (this function's own doc comment: "a spreadsheet often
 * carries extra notes columns"), and an ordinary external file can just
 * as plausibly have its own unrelated column literally named "ID" (a
 * membership number, an external reference) that has nothing to do with
 * this app's row ids. If that column's numeric values happened to
 * collide with existing records' real ids, the old behavior would
 * silently PATCH (overwrite) those unrelated records instead of
 * creating new ones. Confirms the id column is now only trusted once
 * EVERY one of the entity's own real fields is also present in the
 * header -- exactly what a genuine re-export always has (recordsToCsv
 * emits every field, every time) -- and ignored (new record, not an
 * update) the moment even one field is missing from the header,
 * regardless of how plausible the id column itself looks.
 */
test("buildImportRecords ignores an \"id\" column (treats every row as a brand-new record) when the header doesn't also cover every one of the entity's own real fields -- an external spreadsheet's own unrelated ID column must never be mistaken for this app's own round-trip key", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "text", required: false },
  ];
  // A plausible external customer list: its own "ID" column (e.g. a
  // membership number) plus a Name column -- but no Email column at
  // all, so this header can never be this entity's own genuine
  // re-export (which would always include Email too).
  const rows = [
    ["ID", "Name"],
    ["7", "Dana"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.records,
    [{ name: "Dana", email: null }],
    "the external ID value must never be mistaken for this app's own record id -- this row must create a new record (no `id` key at all), not attempt to update record #7",
  );
});

/** Sibling of the test above: the id column IS trusted once the header covers every real field, confirming the fix doesn't regress the legitimate re-export case for a multi-field entity (round 683's own existing tests only ever used a single-field entity). */
test("buildImportRecords still trusts the \"id\" column once the header covers every one of the entity's own real fields", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "text", required: false },
  ];
  const rows = [
    ["id", "Name", "Email"],
    ["7", "Dana", "dana@example.com"],
  ];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ id: 7, name: "Dana", email: "dana@example.com" }]);
});

/**
 * Round 1241: a new feature -- a found-by-survey gap where buildImportRecords
 * had no signal at all for a new row (no trusted id) whose display-field
 * value coincides with a record already in this entity's table, even
 * though twin.ts's computeDuplicateObservations already flags the exact
 * same thing for the Business Twin, just after the fact. `entity` and
 * `existingRecords` are both new optional trailing parameters -- every
 * pre-1241 call site above this comment (bare `fields, rows`) keeps
 * returning `warnings: []`, confirming the feature is additive, not a
 * silent behavior change for an existing caller.
 */
const DUPLICATE_CHECK_ENTITY: Entity = {
  name: "Customer",
  label: "Customer",
  fields: [{ name: "name", label: "Name", type: "text", required: true }],
};

test("buildImportRecords warns (but still imports) a new row whose name matches an existing record, when entity+existingRecords are passed", () => {
  const fields = DUPLICATE_CHECK_ENTITY.fields;
  const rows = [["Name"], ["Dana"]];
  const existing: EntityRecord[] = [{ id: 1, name: "Dana" }];
  const result = buildImportRecords(fields, rows, [], {}, "en", DUPLICATE_CHECK_ENTITY, existing);
  assert.deepEqual(result.errors, [], "a possible duplicate must never be treated as a row error");
  assert.deepEqual(result.records, [{ name: "Dana" }], "the row must still be imported despite the warning");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Dana/);
});

test("buildImportRecords warns on two new rows in the same file that share a name, even with no existing records at all", () => {
  const fields = DUPLICATE_CHECK_ENTITY.fields;
  const rows = [["Name"], ["Dana"], ["Dana"]];
  const result = buildImportRecords(fields, rows, [], {}, "en", DUPLICATE_CHECK_ENTITY, []);
  assert.equal(result.records.length, 2, "both rows must still be imported -- within-batch duplicates are advisory too");
  assert.equal(result.warnings.length, 1, "only the SECOND occurrence warns -- the first instance of a name is never a duplicate of itself");
});

test("buildImportRecords never warns about a row whose id column resolves it to an update of that exact existing record", () => {
  const fields = DUPLICATE_CHECK_ENTITY.fields;
  const rows = [
    ["id", "Name"],
    ["1", "Dana"],
  ];
  const existing: EntityRecord[] = [{ id: 1, name: "Dana" }];
  const result = buildImportRecords(fields, rows, [], {}, "en", DUPLICATE_CHECK_ENTITY, existing);
  assert.deepEqual(result.warnings, [], "updating a record by its own id is never a duplicate of itself");
});

test("buildImportRecords never warns when the entity's display field isn't text/longtext, mirroring twin.ts's own computeDuplicateObservations restriction", () => {
  const enumEntity: Entity = {
    name: "Order",
    label: "Order",
    fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Done"] }],
  };
  const rows = [["Status"], ["New"], ["New"]];
  const existing: EntityRecord[] = [{ id: 1, status: "New" }];
  const result = buildImportRecords(enumEntity.fields, rows, [], {}, "en", enumEntity, existing);
  assert.deepEqual(result.warnings, [], "an enum display field's shared value is never evidence of a duplicate record");
});

test("buildImportRecords never warns when the caller doesn't pass entity/existingRecords at all (every pre-1241 call site)", () => {
  const fields = DUPLICATE_CHECK_ENTITY.fields;
  const rows = [["Name"], ["Dana"], ["Dana"]];
  const result = buildImportRecords(fields, rows);
  assert.deepEqual(result.warnings, [], "the feature must be fully opt-in -- an old call site with no entity/existingRecords must behave exactly as before");
});

/**
 * Round 1221: the JSON counterpart to round 1217's Export JSON -- a user
 * who clicked "Export JSON" had no way back in, unlike CSV's full export/
 * import round-trip. buildImportRecordsFromJson is dramatically simpler
 * than buildImportRecords: recordsToJson's own output already carries
 * every field's REAL typed value, so there's no display-text coercion to
 * reverse, just validation. Runs the real round-trip end to end
 * (recordsToJson -> JSON.parse -> buildImportRecordsFromJson) to confirm
 * every field type's real stored value survives unchanged, including the
 * raw enum VALUE (not its enumLabels display text) and a real boolean
 * (not CSV's "TRUE"/"FALSE" string).
 */
test("a real record's own JSON export round-trips through recordsToJson -> buildImportRecordsFromJson back to the exact same typed values, including id", () => {
  const fields: Field[] = [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "amount", label: "Amount", type: "number", required: true },
    { name: "done", label: "Done", type: "boolean", required: false },
    { name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Won"], enumLabels: { New: "New", Won: "Won!" } },
    { name: "courierId", label: "Courier", type: "relation", required: true, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [{ id: 42, name: "Yossi Cohen" }];
  const record: EntityRecord = { id: 7, title: "Order A", amount: 120.5, done: true, status: "Won", courierId: 42 };
  const json = recordsToJson(fields, [record]);
  const parsed = JSON.parse(json);
  const result = buildImportRecordsFromJson(fields, parsed, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ id: 7, title: "Order A", amount: 120.5, done: true, status: "Won", courierId: 42 }]);
  assert.strictEqual(result.records[0].done, true, "a boolean must round-trip as a real JS boolean, not a string");
});

test("buildImportRecordsFromJson skips a row missing a required field and reports which row and field", () => {
  const fields: Field[] = [{ name: "title", label: "Title", type: "text", required: true }];
  const rows = [{ title: "Order A" }, { title: null }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.records, [{ title: "Order A" }]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Row 2/);
  assert.match(result.errors[0], /Title/);
});

test("buildImportRecordsFromJson rejects a relation id that doesn't match any related record, instead of silently importing a dangling reference", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const couriers: EntityRecord[] = [{ id: 42, name: "Yossi Cohen" }];
  const rows = [{ name: "Order A", courierId: 999 }];
  const result = buildImportRecordsFromJson(fields, rows, [courierEntity], { Courier: couriers });
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /doesn't match any Courier record/);
});

test("buildImportRecordsFromJson ignores an optional relation field when its target entity's records weren't loaded, instead of failing on it", () => {
  const fields: Field[] = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];
  const rows = [{ name: "Order A", courierId: 42 }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Order A" }]);
});

test("buildImportRecordsFromJson rejects an enum value not among the field's own declared enumValues, instead of silently storing a stray string", () => {
  const fields: Field[] = [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Won"] }];
  const rows = [{ status: "Lost" }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /isn't a valid option/);
});

test("buildImportRecordsFromJson refuses the whole import for an entity with a required file field, since no JSON descriptor can supply a real uploaded file", () => {
  const fields: Field[] = [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "attachment", label: "Attachment", type: "file", required: true },
  ];
  const rows = [{ title: "Invoice", attachment: { url: "/api/uploads/proj1/Task/report.pdf", name: "report.pdf", size: 1, mimeType: "application/pdf" } }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /required file field/);
  assert.match(result.errors[0], /Attachment/);
});

test("buildImportRecordsFromJson ignores an optional file field's descriptor instead of attempting to attach it", () => {
  const fields: Field[] = [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "attachment", label: "Attachment", type: "file", required: false },
  ];
  const rows = [{ title: "Invoice", attachment: { url: "/api/uploads/proj1/Task/report.pdf", name: "report.pdf", size: 1, mimeType: "application/pdf" } }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ title: "Invoice" }]);
});

test("buildImportRecordsFromJson resolves a valid \"id\" key into each record's own `id`, leaving the field data unchanged", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [{ id: 7, name: "Dana" }, { id: 12, name: "Noa" }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ id: 7, name: "Dana" }, { id: 12, name: "Noa" }]);
});

test("buildImportRecordsFromJson treats a missing/null \"id\" as a brand-new record (no `id` key at all), not an error", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [{ id: 7, name: "Dana" }, { name: "Amit" }, { id: null, name: "Noa" }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ id: 7, name: "Dana" }, { name: "Amit" }, { name: "Noa" }]);
});

test("buildImportRecordsFromJson rejects every row after the first that reuses an already-seen id, the same CSV-import protection round 1042 added", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [{ id: 7, name: "Dana" }, { id: 7, name: "Noa" }, { id: 12, name: "Amit" }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.records, [{ id: 7, name: "Dana" }, { id: 12, name: "Amit" }]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Row 2/);
  assert.match(result.errors[0], /7/);
});

test("buildImportRecordsFromJson ignores an extra JSON key with no matching field, instead of erroring on it", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = [{ name: "Dana", internalNotes: "vip, handle with care" }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana" }]);
});

test("buildImportRecordsFromJson reports a row error when a row isn't a JSON object at all, instead of crashing", () => {
  const fields: Field[] = [{ name: "name", label: "Name", type: "text", required: true }];
  const rows = ["not-an-object", 42, ["also-not-an-object"]];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /Row 1/);
});

test("buildImportRecordsFromJson rejects a number field's value when it isn't actually a JSON number, instead of silently coercing it", () => {
  const fields: Field[] = [{ name: "amount", label: "Amount", type: "number", required: true }];
  const rows = [{ amount: "120" }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /isn't a number/);
});

/**
 * Round 1241: the JSON counterpart to buildImportRecords' own new
 * possible-duplicate warnings above -- same makeDuplicateWarningChecker
 * helper, same entity+existingRecords trailing parameters, same
 * never-blocks guarantee. A JSON re-import of a hand-edited export is
 * exactly the shape most likely to introduce a NEW id-less row (someone
 * copy-pasted a record's own JSON and forgot to remove its id before
 * adding a new entry) that coincides with an existing one.
 */
test("buildImportRecordsFromJson warns (but still imports) a new row whose name matches an existing record, when entity+existingRecords are passed", () => {
  const fields = DUPLICATE_CHECK_ENTITY.fields;
  const rows = [{ name: "Dana" }];
  const existing: EntityRecord[] = [{ id: 1, name: "Dana" }];
  const result = buildImportRecordsFromJson(fields, rows, [], {}, DUPLICATE_CHECK_ENTITY, existing);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [{ name: "Dana" }]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Dana/);
});

test("buildImportRecordsFromJson never warns about a row whose own id resolves it to an update of that exact existing record", () => {
  const fields = DUPLICATE_CHECK_ENTITY.fields;
  const rows = [{ id: 1, name: "Dana" }];
  const existing: EntityRecord[] = [{ id: 1, name: "Dana" }];
  const result = buildImportRecordsFromJson(fields, rows, [], {}, DUPLICATE_CHECK_ENTITY, existing);
  assert.deepEqual(result.warnings, [], "updating a record by its own id is never a duplicate of itself");
});

test("buildImportRecordsFromJson never warns when the caller doesn't pass entity/existingRecords at all (every pre-1241 call site)", () => {
  const fields = DUPLICATE_CHECK_ENTITY.fields;
  const rows = [{ name: "Dana" }, { name: "Dana" }];
  const result = buildImportRecordsFromJson(fields, rows);
  assert.deepEqual(result.warnings, [], "the feature must be fully opt-in -- an old call site with no entity/existingRecords must behave exactly as before");
});

test("uniqueEnumValues de-dupes while preserving first-occurrence order, and tolerates a missing array", () => {
  assert.deepEqual(uniqueEnumValues(["New", "New", "Won", "Lost", "Won"]), ["New", "Won", "Lost"]);
  assert.deepEqual(uniqueEnumValues([]), []);
  assert.deepEqual(uniqueEnumValues(undefined), []);
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
 * Round 608: field.enumValues has no restriction on its contents (see the
 * duplicate-values regression test above), so a spec can legitimately
 * declare "__other__" itself as a real enum value -- colliding with the
 * synthetic overflow column's own hardcoded "__other__" value. EntityPanel.tsx
 * keys its collapsedBoardColumns Set and React list by column.value, so
 * collapsing the real declared column used to silently collapse the
 * unrelated overflow column too (and vice versa). Fixed by deriving the
 * overflow column's key so it can never match anything in enumValues.
 */
test("groupByField gives the '(other)' column a key distinct from a real declared enum value literally named \"__other__\"", () => {
  const field: Field = {
    name: "status",
    type: "enum",
    required: true,
    enumValues: ["New", "__other__"],
  };
  const records = [
    { id: 1, status: "New" },
    { id: 2, status: "__other__" }, // matches the real declared value
    { id: 3, status: "Legacy-Removed-Value" }, // a genuinely unrecognized value
  ];
  const columns = groupByField(records, field);
  const values = columns.map((c) => c.value);
  assert.equal(new Set(values).size, values.length, "no two columns may share the same value/key");
  const realOtherColumn = columns.find((c) => c.value === "__other__")!;
  assert.equal(realOtherColumn.isOther, undefined, "the real declared enum column must never be marked isOther");
  assert.deepEqual(realOtherColumn.records.map((r) => r.id), [2]);
  const overflowColumn = columns.find((c) => c.isOther)!;
  assert.notEqual(overflowColumn.value, "__other__");
  assert.deepEqual(overflowColumn.records.map((r) => r.id), [3]);
});

/**
 * Round 443: field.enumValues has no uniqueness constraint (the one
 * realistic way a real project ends up with a duplicate is an
 * AI-generated spec -- see uniqueEnumValues' own doc comment above).
 * Before this fix, groupByField mapped field.enumValues directly to
 * columns with no dedup, so a duplicate value produced two identical
 * columns that both filtered the SAME records -- every matching record's
 * card rendered on the board twice, once in each duplicate column.
 */
test("groupByField never produces two columns for the same enum value, even when the field's own enumValues contains a duplicate", () => {
  const field: Field = { name: "stage", type: "enum", required: true, enumValues: ["Lead", "Lead", "Won"] };
  const records = [{ id: 1, stage: "Lead" }];
  const columns = groupByField(records, field);
  assert.deepEqual(
    columns.map((c) => c.value),
    ["Lead", "Won"],
    "a duplicate declared value must collapse to one column, not one column per occurrence",
  );
  assert.equal(columns[0].records.length, 1, "the single matching record must not be duplicated across two identical columns");
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

/**
 * New in this round: a target whose own (or an ancestor's) closest() match
 * for 'button, a[href], [role="button"], summary' succeeds must report
 * true -- isTypingTarget deliberately returns false for a bare BUTTON
 * (round 350's own test above), since j/k/x/Delete/d have no native
 * action there, but Enter does, and this helper exists specifically to
 * catch that case for the table view's own Enter shortcut.
 */
test("enterTargetsInteractiveElement is true for a target whose closest() finds a button/link/role=button/summary ancestor", () => {
  const interactive = { closest: (selector: string) => (selector.includes("button") ? {} : null) };
  assert.equal(enterTargetsInteractiveElement(interactive as unknown as EventTarget), true);
});

test("enterTargetsInteractiveElement is false for an ordinary element, no target, or a target with no closest() at all", () => {
  const ordinary = { closest: () => null };
  assert.equal(enterTargetsInteractiveElement(ordinary as unknown as EventTarget), false);
  assert.equal(enterTargetsInteractiveElement(null), false);
  assert.equal(enterTargetsInteractiveElement({} as unknown as EventTarget), false);
});

/**
 * Regression test: every scrollIntoView call site in this app passed
 * behavior: "smooth" unconditionally, firing a real scroll animation on
 * every keypress and click regardless of whether the person has their OS/
 * browser set to "prefers-reduced-motion: reduce" -- the exact WCAG 2.3.3
 * case this app already treats as real for its one CSS keyframe animation
 * (styles.css's .hero3d-cube). This file runs in plain Node (no jsdom), so
 * `window` is stubbed directly for the duration of each test rather than
 * swapping in a full JSDOM instance -- scrollIntoViewRespectingMotion only
 * ever reads window.matchMedia once per call, with no listener to set up.
 */
test("scrollIntoViewRespectingMotion calls scrollIntoView with behavior: \"auto\" instead of \"smooth\" when prefers-reduced-motion is set", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: true }) };
  try {
    const calls: unknown[] = [];
    const el = { scrollIntoView: (options: unknown) => calls.push(options) };
    scrollIntoViewRespectingMotion(el as unknown as Element, { behavior: "smooth", block: "center" });
    assert.deepEqual(calls, [{ behavior: "auto", block: "center" }]);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test("scrollIntoViewRespectingMotion passes the original options unchanged when prefers-reduced-motion is not set", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };
  try {
    const calls: unknown[] = [];
    const el = { scrollIntoView: (options: unknown) => calls.push(options) };
    scrollIntoViewRespectingMotion(el as unknown as Element, { behavior: "smooth", block: "center" });
    assert.deepEqual(calls, [{ behavior: "smooth", block: "center" }]);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test("scrollIntoViewRespectingMotion does nothing for a null/undefined element, or one with no scrollIntoView at all", () => {
  assert.doesNotThrow(() => scrollIntoViewRespectingMotion(null, { behavior: "smooth" }));
  assert.doesNotThrow(() => scrollIntoViewRespectingMotion(undefined, { behavior: "smooth" }));
  assert.doesNotThrow(() => scrollIntoViewRespectingMotion({} as unknown as Element, { behavior: "smooth" }));
});

test("isInlineEditableField allows every field type except relation and file", () => {
  const types: Field["type"][] = ["text", "longtext", "number", "boolean", "enum", "date"];
  for (const type of types) {
    assert.equal(isInlineEditableField({ name: "f", type } as Field), true, `expected ${type} to be inline-editable`);
  }
  assert.equal(
    isInlineEditableField({ name: "courierId", type: "relation", relationTo: "Courier" } as Field),
    false,
    "a relation field's cell shows a label resolved from a different record, so it must stay excluded from inline editing",
  );
  assert.equal(
    isInlineEditableField({ name: "resume", type: "file" } as Field),
    false,
    "a file field's real editing UI (choosing and uploading a file) needs more than a single inline cell, so it must stay excluded too",
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

/**
 * Regression test for a real bug found by a round-400 Explore survey:
 * isGroupableField above already treats enum and boolean as the same
 * "small fixed value space" category for table grouping, but
 * findFilterableEnumFields (used by EntityPanel's per-field filter
 * dropdown) only ever returned enum fields -- a boolean field like
 * "isBillable" could be grouped by but never filtered on. Confirms
 * findFilterableFields returns a boolean field alongside a qualifying
 * enum field, in enum-then-boolean order, while still excluding a
 * too-large enum (same >8-value exclusion findFilterableEnumFields
 * itself already enforces) and a plain text/number/date field.
 */
test("findFilterableFields returns every qualifying enum field plus every boolean field, unlike enum-only findFilterableEnumFields", () => {
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "status", type: "enum", required: true, enumValues: ["todo", "done"] },
    { name: "isUrgent", type: "boolean", required: false },
    { name: "tooManyValues", type: "enum", required: false, enumValues: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
    { name: "dueDate", type: "date", required: false },
  ];
  assert.deepEqual(
    findFilterableFields(fields).map((f) => f.name),
    ["status", "isUrgent"],
    "must include the qualifying enum field and the boolean field, in that order, excluding text/date/too-large-enum",
  );
});

/**
 * New in this round: a relation field is just as fixed-value-space as an
 * enum -- its options are exactly the related entity's current records --
 * but findFilterableFields never included it at all, so a person could
 * group a table by a relation's resolved label but never filter down to
 * one specific related record. Only offered once allEntities/
 * relatedRecords confirm the relation actually resolves to a loaded set
 * of records -- the same "resolvable" guard buildImportRecords/FieldInput
 * already use -- so a stale relationTo pointing at a deleted entity, or
 * data that hasn't finished loading yet, is correctly excluded.
 */
test("findFilterableFields includes a relation field only once allEntities/relatedRecords confirm it actually resolves to a loaded set of records", () => {
  const courier: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
  ];

  assert.deepEqual(
    findFilterableFields(fields).map((f) => f.name),
    [],
    "with no allEntities/relatedRecords at all, a relation field must not be offered -- there's nothing to resolve it against",
  );
  assert.deepEqual(
    findFilterableFields(fields, [courier], {}).map((f) => f.name),
    [],
    "with the target entity known but its records not yet loaded, the relation still can't be resolved",
  );
  assert.deepEqual(
    findFilterableFields(fields, [courier], { Courier: [{ id: 1, name: "Dana" }] }).map((f) => f.name),
    ["courierId"],
    "once the related entity exists and its records are loaded, the relation field must be included",
  );
  assert.deepEqual(
    findFilterableFields(fields, [], { Courier: [{ id: 1, name: "Dana" }] }).map((f) => f.name),
    [],
    "a relationTo pointing at an entity that no longer exists must stay excluded even if stale relatedRecords for it happen to be present",
  );
});

/**
 * Round 1178: mirrors the test above exactly, except the relation field's
 * own relationTo ("courier") differs from its real target entity's name
 * ("Courier") only by letter case -- the same case-mismatch scenario
 * relationDisplayLabel (round 1162) and buildImportRecords (round 1177)
 * were already fixed for in this same file.
 */
test("findFilterableFields still includes a relation field when relationTo differs from its target entity's name only by letter case", () => {
  const courier: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const fields: Field[] = [
    { name: "name", type: "text", required: true },
    { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "courier" },
  ];
  assert.deepEqual(
    findFilterableFields(fields, [courier], { courier: [{ id: 1, name: "Dana" }] }).map((f) => f.name),
    ["courierId"],
    "a case-mismatched relationTo must not exclude an otherwise fully resolvable relation field",
  );
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

/**
 * Round 443: same root cause as groupByField's identical regression test
 * above -- groupRecordsByField's own loop iterated field.enumValues
 * directly with no dedup, so a duplicate value produced two identical
 * groups that both filtered the SAME records, duplicating every matching
 * row across two groups in the table's "group by" view.
 */
test("groupRecordsByField never produces two groups for the same enum value, even when the field's own enumValues contains a duplicate", () => {
  const t = (key: string) => translate("en", key);
  const field: Field = { name: "status", type: "enum", required: true, enumValues: ["New", "New", "Won"] };
  const records = [{ id: 1, status: "New" }];
  const groups = groupRecordsByField(records, field, t);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["New"],
    "a duplicate declared value must collapse to one group, not one group per occurrence (the empty 'Won' group is correctly omitted)",
  );
  assert.deepEqual(groups[0].records.map((r) => r.id), [1], "the single matching record must not be duplicated across two identical groups");
});

/**
 * Round 608: same fix as groupByField's identical regression test above --
 * a declared enum value literally named "__other__" used to collide with
 * the overflow bucket's own hardcoded key.
 */
test("groupRecordsByField gives the '(other)' bucket a key distinct from a real declared enum value literally named \"__other__\"", () => {
  const t = (key: string) => translate("en", key);
  const field: Field = { name: "status", type: "enum", required: true, enumValues: ["New", "__other__"] };
  const records = [
    { id: 1, status: "New" },
    { id: 2, status: "__other__" },
    { id: 3, status: "Legacy-Removed-Value" },
  ];
  const groups = groupRecordsByField(records, field, t);
  const keys = groups.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, "no two groups may share the same key");
  assert.deepEqual(groups.find((g) => g.key === "__other__")!.records.map((r) => r.id), [2]);
  const overflowGroup = groups.find((g) => g.key !== "New" && g.key !== "__other__")!;
  assert.deepEqual(overflowGroup.records.map((r) => r.id), [3]);
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

/**
 * Round 738: a relation field is just as fixed-value-space as an enum --
 * the sibling toolbar filter dropdown (findFilterableFields, round 721)
 * already treats it that way -- but isGroupableField never included it,
 * even though its own doc comment only argues for excluding genuinely
 * unbounded free-text/number/date fields and never mentions relation as a
 * deliberate exclusion. Mirrors findFilterableFields' own "resolvable"
 * guard test above: only offered once allEntities/relatedRecords confirm
 * the relation actually resolves to a loaded set of records.
 */
test("isGroupableField includes a relation field only once allEntities/relatedRecords confirm it actually resolves to a loaded set of records", () => {
  const courier: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const field: Field = { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" };

  assert.equal(isGroupableField(field), false, "with no allEntities/relatedRecords at all, a relation field must not be groupable");
  assert.equal(
    isGroupableField(field, [courier], {}),
    false,
    "with the target entity known but its records not yet loaded, the relation still can't be resolved",
  );
  assert.equal(
    isGroupableField(field, [courier], { Courier: [{ id: 1, name: "Dana" }] }),
    true,
    "once the related entity exists and its records are loaded, the relation field must be groupable",
  );
  assert.equal(
    isGroupableField(field, [], { Courier: [{ id: 1, name: "Dana" }] }),
    false,
    "a relationTo pointing at an entity that no longer exists must stay excluded even if stale relatedRecords for it happen to be present",
  );
});

/**
 * Round 1178: mirrors the test above exactly, except the relation field's
 * own relationTo differs from its real target entity's name only by
 * letter case -- same scenario as findFilterableFields's own round-1178
 * test just above.
 */
test("isGroupableField still includes a relation field when relationTo differs from its target entity's name only by letter case", () => {
  const courier: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const field: Field = { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "courier" };
  assert.equal(
    isGroupableField(field, [courier], { courier: [{ id: 1, name: "Dana" }] }),
    true,
    "a case-mismatched relationTo must not exclude an otherwise fully resolvable relation field",
  );
});

/**
 * Round 738: groupRecordsByField's new relation branch -- groups follow the
 * related entity's own current record order (not first-seen order among
 * the grouped records), labeled via recordDisplayLabel the same way
 * relationDisplayLabel already resolves a relation cell's own text. A
 * record whose stored id is null, or a dangling reference to a related
 * record that no longer exists, is collected into the same "(other)"
 * bucket the enum branch already uses, rather than silently dropped.
 */
test("groupRecordsByField groups by a relation field in the related entity's own record order, with an 'other' bucket for a null/dangling reference", () => {
  const t = (key: string) => translate("en", key);
  const courier: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const field: Field = { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" };
  const relatedRecords = { Courier: [{ id: 2, name: "Bar" }, { id: 1, name: "Dana" }] };
  const records = [
    { id: 10, courierId: 1 }, // Dana
    { id: 11, courierId: 2 }, // Bar
    { id: 12, courierId: null }, // no courier assigned
    { id: 13, courierId: 999 }, // dangling -- no such Courier record
    { id: 14, courierId: 1 }, // Dana again
  ];

  const groups = groupRecordsByField(records, field, t, [courier], relatedRecords);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["2", "1", "__other__"],
    "must follow Courier's own record order (Bar then Dana, not first-seen order 1 then 2), with one trailing 'other' bucket",
  );
  assert.equal(groups[0].label, "Bar");
  assert.equal(groups[1].label, "Dana");
  assert.deepEqual(groups.find((g) => g.key === "1")!.records.map((r) => r.id), [10, 14]);
  assert.deepEqual(
    groups.find((g) => g.key === "__other__")!.records.map((r) => r.id),
    [12, 13],
    "both the null-courier record and the dangling-reference record must land in 'other', not be silently dropped",
  );

  assert.deepEqual(
    groupRecordsByField(records, field, t).map((g) => g.key),
    [],
    "with no allEntities/relatedRecords passed at all, grouping by a relation field must produce no groups rather than throw",
  );
});

/**
 * Round 1178: mirrors the test above's happy path, except the relation
 * field's own relationTo differs from its real target entity's name only
 * by letter case -- same scenario as findFilterableFields/isGroupableField's
 * own round-1178 tests above. Before this round, the exact-case
 * `targetEntity` lookup's own `!targetEntity` early return produced zero
 * groups for every record, even though every record's courierId was
 * perfectly resolvable.
 */
test("groupRecordsByField still groups by a relation field when relationTo differs from its target entity's name only by letter case", () => {
  const t = (key: string) => translate("en", key);
  const courier: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  const field: Field = { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "courier" };
  const relatedRecords = { courier: [{ id: 1, name: "Dana" }] };
  const records = [{ id: 10, courierId: 1 }];

  const groups = groupRecordsByField(records, field, t, [courier], relatedRecords);
  assert.deepEqual(groups.map((g) => g.key), ["1"], "a case-mismatched relationTo must not prevent real grouping");
  assert.equal(groups[0].label, "Dana");
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
