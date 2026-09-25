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
