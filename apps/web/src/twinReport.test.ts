import assert from "node:assert/strict";
import { test } from "node:test";
import type { BusinessTwin } from "./api.js";
import { translate } from "./i18n/language.js";
import { formatTwinReport } from "./twinReport.js";

function makeTwin(overrides: Partial<BusinessTwin> = {}): BusinessTwin {
  return {
    summary: "עסק עם 2 סוגי נתונים ו-5 רשומות.",
    roles: ["Admin", "Sales"],
    entities: [
      { name: "Customer", label: "לקוחות", count: 3 },
      { name: "Order", label: "הזמנות", count: 2 },
    ],
    totalRecords: 5,
    mostActive: { name: "Customer", label: "לקוחות", count: 3 },
    unused: [],
    observations: ['ב"לקוחות", 2 רשומות חולקות את השם "דנה" — יתכן כפילות.'],
    mostLinkedRecord: null,
    mostActiveObservation: null,
    jumpableObservations: [],
    distributions: [],
    numericStats: [],
    ...overrides,
  };
}

test("formatTwinReport includes the project name, summary, roles, per-entity counts, total, and observations (Hebrew)", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const report = formatTwinReport(makeTwin(), "חנות הפרחים", "he", t);

  assert.match(report, /חנות הפרחים/);
  assert.match(report, /עסק עם 2 סוגי נתונים/);
  assert.match(report, /Admin, Sales/);
  assert.match(report, /לקוחות: 3/);
  assert.match(report, /הזמנות: 2/);
  assert.match(report, /5/); // total records
  assert.match(report, /דנה/); // observation text survives intact (Hebrew round-trips through plain UTF-8 text)
});

test("formatTwinReport renders in English when given the English translator", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const report = formatTwinReport(makeTwin({ summary: "A business with 2 data types and 5 records." }), "Flower Shop", "en", t);

  assert.match(report, /Business Twin/);
  assert.match(report, /Flower Shop/);
  assert.match(report, /Roles: Admin, Sales/);
  assert.match(report, /Records:/);
  assert.match(report, /Total records: 5/);
});

test("formatTwinReport omits the roles line and the observations section when there are none, instead of printing an empty heading", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const report = formatTwinReport(makeTwin({ roles: [], observations: [] }), "Flower Shop", "en", t);

  assert.doesNotMatch(report, /Roles:/);
  assert.doesNotMatch(report, /What we noticed/);
});

/**
 * New in this round: mostLinkedRecord was split out of the plain
 * `observations` array (so the live panel can make it a real clickable
 * jump -- see BusinessTwinPanel.test.ts) into its own structured field.
 * Confirms the downloadable report doesn't silently drop that fact just
 * because it no longer lives in `observations` -- it must still show up
 * as a real bullet in the report, even when `observations` itself is
 * completely empty.
 */
test("formatTwinReport folds the structured mostLinkedRecord insight back into the observations section", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const twin = makeTwin({
    observations: [],
    mostLinkedRecord: { text: '"Dana Levi" (Customers) is the most-linked record: 3 links total.', entityName: "Customer", recordId: 7 },
  });
  const report = formatTwinReport(twin, "Flower Shop", "en", t);

  assert.match(report, /Dana Levi/);
  assert.match(report, /most-linked record/);
});

/**
 * New in this round: mostActiveObservation was split out of the plain
 * `observations` array too (the direct sibling of mostLinkedRecord's own
 * split above -- see BusinessTwinPanel.test.ts) into its own structured
 * field, so the live panel can make it a real clickable jump. Confirms the
 * downloadable report doesn't silently drop that fact either.
 */
test("formatTwinReport folds the structured mostActiveObservation insight back into the observations section", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const twin = makeTwin({
    observations: [],
    mostActiveObservation: { text: 'Most activity is in "Customers" — 3 records.', entityName: "Customer" },
  });
  const report = formatTwinReport(twin, "Flower Shop", "en", t);

  assert.match(report, /Most activity is in "Customers"/);
});

/**
 * New in this round: relation-coverage and duplicate-detection facts
 * (jumpableObservations) were split out of the plain `observations` array
 * too, the same split mostLinkedRecord/mostActiveObservation already went
 * through above, so the live panel can make each a real clickable jump.
 * Confirms the downloadable report doesn't silently drop these facts either.
 */
test("formatTwinReport folds jumpableObservations back into the observations section", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const twin = makeTwin({
    observations: [],
    jumpableObservations: [
      { text: 'In "Tickets", 2 of 3 records have no "Customer" set.', entityName: "Ticket" },
      { text: 'In "Customers", 2 records share the name "Dana Levi" — possibly a duplicate.', entityName: "Customer" },
    ],
  });
  const report = formatTwinReport(twin, "Flower Shop", "en", t);

  assert.match(report, /2 of 3 records have no "Customer" set/);
  assert.match(report, /possibly a duplicate/);
});

/**
 * Round 437: BusinessTwinPanel.tsx renders mostActiveObservation's bullet
 * before mostLinkedRecord's bullet on screen (see its <ul>, which lists the
 * mostActiveObservation <li> first). The report must match that same order
 * when both are present at once, instead of silently reversing it.
 */
test("formatTwinReport orders mostActiveObservation before mostLinkedRecord, matching BusinessTwinPanel's on-screen order", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const twin = makeTwin({
    observations: [],
    mostActiveObservation: { text: 'Most activity is in "Customers" — 3 records.', entityName: "Customer" },
    mostLinkedRecord: { text: '"Dana Levi" (Customers) is the most-linked record: 3 links total.', entityName: "Customer", recordId: 7 },
  });
  const report = formatTwinReport(twin, "Flower Shop", "en", t);

  const activeIndex = report.indexOf("Most activity is in");
  const linkedIndex = report.indexOf("most-linked record");
  assert.notEqual(activeIndex, -1);
  assert.notEqual(linkedIndex, -1);
  assert.ok(activeIndex < linkedIndex, "mostActiveObservation must appear before mostLinkedRecord, matching the panel's order");
});

/**
 * Round 701 folded distributions/numericStats' own `.text` into the report
 * directly, via a SEPARATE append -- but computeBusinessTwin
 * (apps/api/src/twin.ts) already spreads both into jumpableObservations
 * itself ("jumpableObservations.push(...numericStats, ...distributions)"),
 * a real invariant confirmed by twin.test.ts's own tests. Round 701's own
 * test fixture never caught this because it set jumpableObservations to []
 * while separately populating distributions/numericStats -- a combination
 * that can never actually happen in production, where jumpableObservations
 * is always the superset. The real bug this masked: every distribution and
 * numeric-aggregate sentence was printed TWICE in the one artifact a user
 * actually shares (WhatsApp/email). Round 735 removed the now-redundant
 * separate append; this test's fixture now mirrors the real (overlapping)
 * shape, confirming each sentence survives into the report exactly once.
 */
test("formatTwinReport folds distributions and numericStats into the observations section exactly once, not twice, matching how computeBusinessTwin already folds them into jumpableObservations", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const distributionText = 'In "Orders", status breaks down as: Open (3), Closed (2).';
  const numericStatText = 'Total revenue across "Orders": 1,250 (average 250).';
  const twin = makeTwin({
    observations: [],
    // Mirrors computeBusinessTwin's own real push order (numericStats
    // first, then distributions) -- jumpableObservations is the superset
    // every real BusinessTwin response actually has.
    jumpableObservations: [
      { text: numericStatText, entityName: "Order" },
      { text: distributionText, entityName: "Order" },
    ],
    distributions: [
      {
        text: distributionText,
        entityName: "Order",
        entityLabel: "Orders",
        fieldName: "status",
        fieldLabel: "Status",
        breakdown: [
          { value: "open", label: "Open", count: 3 },
          { value: "closed", label: "Closed", count: 2 },
        ],
      },
    ],
    numericStats: [
      {
        text: numericStatText,
        entityName: "Order",
        entityLabel: "Orders",
        fieldName: "revenue",
        fieldLabel: "Revenue",
        sum: 1250,
        average: 250,
        recordCount: 5,
      },
    ],
  });
  const report = formatTwinReport(twin, "Flower Shop", "en", t);

  assert.match(report, /status breaks down as: Open \(3\), Closed \(2\)/);
  assert.match(report, /Total revenue across "Orders": 1,250/);

  const distributionOccurrences = report.split("status breaks down as").length - 1;
  const numericOccurrences = report.split("Total revenue across").length - 1;
  assert.equal(distributionOccurrences, 1, "the distribution's own sentence must appear exactly once, not duplicated");
  assert.equal(numericOccurrences, 1, "the numeric-aggregate sentence must appear exactly once, not duplicated");
});

test("formatTwinReport still lists every entity's count even when there are zero total records", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const twin = makeTwin({
    entities: [{ name: "Customer", label: "Customers", count: 0 }],
    totalRecords: 0,
    observations: [],
  });
  const report = formatTwinReport(twin, "Empty Shop", "en", t);
  assert.match(report, /Customers: 0/);
  assert.match(report, /Total records: 0/);
});
