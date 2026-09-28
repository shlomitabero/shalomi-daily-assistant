import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, EntityRecord } from "@forge/shared";
import type { EntitySearchResult } from "./entityFormatting.js";
import { translate } from "./i18n/language.js";
import { formatSearchResults } from "./searchReport.js";

const CUSTOMER_ENTITY: Entity = {
  name: "Customer",
  label: "לקוחות",
  fields: [{ name: "name", type: "text", required: true }],
};

const ORDER_ENTITY: Entity = {
  name: "Order",
  label: "הזמנות",
  fields: [{ name: "amount", type: "number", required: true }],
};

function customerRecord(id: number, name: string): EntityRecord {
  return { id, name };
}

test("formatSearchResults includes the project name, the query, and each entity's own matched records (Hebrew)", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const results: EntitySearchResult[] = [
    { entityName: "Customer", entityLabel: "לקוחות", totalMatches: 2, sample: [customerRecord(1, "דנה"), customerRecord(2, "דניאל")] },
  ];

  const report = formatSearchResults(results, [CUSTOMER_ENTITY], {}, "דנ", "חנות הפרחים", "he", t);

  assert.match(report, /חנות הפרחים/);
  assert.match(report, /"דנ"/);
  assert.match(report, /לקוחות/);
  assert.match(report, /דנה/);
  assert.match(report, /דניאל/);
});

test("formatSearchResults renders in English when given the English translator", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const results: EntitySearchResult[] = [
    { entityName: "Customer", entityLabel: "Customers", totalMatches: 1, sample: [customerRecord(1, "Amy")] },
  ];

  const report = formatSearchResults(results, [CUSTOMER_ENTITY], {}, "amy", "Flower Shop", "en", t);

  assert.match(report, /Search everything/);
  assert.match(report, /Flower Shop/);
  assert.match(report, /Search: "amy"/);
  assert.match(report, /Customers/);
  assert.match(report, /Amy/);
});

test("formatSearchResults shows a real no-results message instead of an empty report when nothing matched", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const report = formatSearchResults([], [CUSTOMER_ENTITY], {}, "nonexistent", "Flower Shop", "en", t);

  assert.match(report, /No matching results in any entity/);
});

/**
 * New in this round: a result group can be narrower than its own
 * totalMatches (the panel's own "sample" cap before "Show all" is
 * clicked) -- the report must say so explicitly ("and N more…") rather
 * than silently listing fewer records than the group's own header count
 * claims, which would read as a bug in the export, not the real live
 * preview's own display cap.
 */
test("formatSearchResults notes how many more matches exist beyond what's shown, when the sample is narrower than the total", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const results: EntitySearchResult[] = [
    { entityName: "Customer", entityLabel: "Customers", totalMatches: 5, sample: [customerRecord(1, "Amy"), customerRecord(2, "Ben")] },
  ];

  const report = formatSearchResults(results, [CUSTOMER_ENTITY], {}, "a", "Flower Shop", "en", t);

  assert.match(report, /and 3 more/);
});

/**
 * The report must reflect exactly what the panel is currently showing,
 * including a "Show all" expansion -- `expandedSamples` overrides a
 * group's default `sample` the same way the live render does, so a
 * report taken after expanding a group lists every real match, not just
 * the original capped sample.
 */
test("formatSearchResults uses an expanded sample (from a real 'Show all' click) instead of the original capped sample", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const results: EntitySearchResult[] = [
    { entityName: "Customer", entityLabel: "Customers", totalMatches: 3, sample: [customerRecord(1, "Amy")] },
  ];
  const expandedSamples: Record<string, EntityRecord[]> = {
    Customer: [customerRecord(1, "Amy"), customerRecord(2, "Ben"), customerRecord(3, "Cara")],
  };

  const report = formatSearchResults(results, [CUSTOMER_ENTITY], expandedSamples, "a", "Flower Shop", "en", t);

  assert.match(report, /Amy/);
  assert.match(report, /Ben/);
  assert.match(report, /Cara/);
  assert.doesNotMatch(report, /and \d+ more/, "once fully expanded, there must be no remaining-count line");
});

test("formatSearchResults lists results from more than one entity, each under its own label", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const results: EntitySearchResult[] = [
    { entityName: "Customer", entityLabel: "Customers", totalMatches: 1, sample: [customerRecord(1, "Amy")] },
    { entityName: "Order", entityLabel: "Orders", totalMatches: 1, sample: [{ id: 10, amount: 42 }] },
  ];

  const report = formatSearchResults(results, [CUSTOMER_ENTITY, ORDER_ENTITY], {}, "a", "Flower Shop", "en", t);

  assert.match(report, /Customers/);
  assert.match(report, /Amy/);
  assert.match(report, /Orders/);
});
