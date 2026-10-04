import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeIdentifier, quoteIdentifier, tableNameFor } from "./identifiers.js";

/**
 * assertSafeIdentifier is this codebase's documented SQL-injection
 * defense: "Every identifier that ends up in a raw SQL string must pass
 * through this allowlist first." Every other test in this package that
 * touches it only ever passes it well-formed identifiers (customer,
 * status, order, ...), so the allowlist's actual job -- rejecting a
 * malicious or malformed one -- had no direct test proving it works.
 * These exercise the real function, not a reimplementation of the regex.
 */
test("assertSafeIdentifier accepts ordinary alphanumeric/underscore identifiers", () => {
  assert.equal(assertSafeIdentifier("name", "column"), "name");
  assert.equal(assertSafeIdentifier("order", "column"), "order");
  assert.equal(assertSafeIdentifier("field_1", "column"), "field_1");
  assert.equal(assertSafeIdentifier("CustomerName", "column"), "CustomerName");
});

test("assertSafeIdentifier rejects a SQL-injection payload disguised as a field name", () => {
  assert.throws(
    () => assertSafeIdentifier('name"; DROP TABLE users; --', "column"),
    /Unsafe column identifier/,
  );
});

test("assertSafeIdentifier rejects an identifier starting with a digit", () => {
  // SQLite (and every SQL dialect) requires an identifier to start with a
  // letter; a field name starting with a digit is invalid regardless of
  // injection risk, and this must be caught before it ever reaches a raw
  // SQL string.
  assert.throws(() => assertSafeIdentifier("1name", "column"), /Unsafe column identifier/);
});

test("assertSafeIdentifier rejects whitespace, dots, and quote characters", () => {
  assert.throws(() => assertSafeIdentifier("field name", "column"), /Unsafe column identifier/);
  assert.throws(() => assertSafeIdentifier("field.name", "column"), /Unsafe column identifier/);
  assert.throws(() => assertSafeIdentifier('field"name', "column"), /Unsafe column identifier/);
  assert.throws(() => assertSafeIdentifier("field'name", "column"), /Unsafe column identifier/);
});

test("assertSafeIdentifier rejects an empty identifier", () => {
  assert.throws(() => assertSafeIdentifier("", "column"), /Unsafe column identifier/);
});

test("assertSafeIdentifier's error message names which kind of identifier and its actual value", () => {
  assert.throws(() => assertSafeIdentifier("bad name", "table"), /Unsafe table identifier.*"bad name"/);
});

/**
 * tableNameFor takes a projectId, which (unlike a field name) is never
 * validated against the domain library or an LLM-checked spec -- it's
 * whatever the caller passes, so this is the one place a malicious value
 * could plausibly reach a raw SQL string un-vetted. It defends by
 * replacing every non-alphanumeric character rather than rejecting, so
 * this proves that replacement actually neutralizes SQL metacharacters
 * instead of merely hoping they don't show up.
 */
test("tableNameFor neutralizes SQL metacharacters in a malicious projectId instead of embedding them raw", () => {
  const maliciousProjectId = 'proj1"; DROP TABLE users; --';
  const table = tableNameFor(maliciousProjectId, "Customer");
  assert.doesNotMatch(table, /[";]/, "the returned table name must contain no quote or semicolon characters");
  assert.doesNotThrow(() => assertSafeIdentifier(table, "table"));
});

test("tableNameFor's own prefix guarantees a valid table name even when projectId/entityName start with a digit", () => {
  // A raw projectId or entityName starting with a digit would fail
  // assertSafeIdentifier on its own (SQL identifiers must start with a
  // letter), but tableNameFor always prefixes with "entity_", so the
  // final identifier's first character is never in question.
  const table = tableNameFor("123", "9Lives");
  assert.match(table, /^entity_123_9Lives$/);
});

test("quoteIdentifier wraps a value in double quotes without altering an already-safe identifier's characters", () => {
  assert.equal(quoteIdentifier("status"), '"status"');
  assert.equal(quoteIdentifier("order"), '"order"');
});
