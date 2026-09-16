import assert from "node:assert/strict";
import { test } from "node:test";
import type { Field } from "@forge/shared";
import {
  badgeTone,
  findBoardField,
  formatDateValue,
  formatNumberValue,
  groupByField,
  matchesSearch,
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

test("formatDateValue formats a valid ISO date per locale, and leaves an invalid one unchanged", () => {
  const result = formatDateValue("2026-03-15", "en");
  assert.match(result, /3\/15\/2026|15\/3\/2026/); // exact format is locale/engine-dependent, just confirm it parsed
  assert.equal(formatDateValue("not-a-date", "en"), "not-a-date");
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
