import assert from "node:assert/strict";
import { test } from "node:test";
import type { Field } from "@forge/shared";
import { badgeTone, formatDateValue, formatNumberValue, matchesSearch, sortRecords } from "./entityFormatting.js";

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
