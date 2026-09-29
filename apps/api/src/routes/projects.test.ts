import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveEntityName, deriveFieldName, deriveName } from "./projects.js";

/**
 * deriveName picks a project's display name from its free-text description
 * whenever the client doesn't supply an explicit `name` (see the `name ??
 * deriveName(description)` call in the POST /projects handler). Every
 * existing test that creates a project either passes an explicit name or a
 * normal multi-word description and never reads back `project.name` at all
 * -- so neither the 6-word truncation nor the empty-input fallback has ever
 * actually been exercised.
 */
test("deriveName joins a short description's words unchanged", () => {
  assert.equal(deriveName("A simple todo app"), "A simple todo app");
});

test("deriveName truncates a description to its first 6 words", () => {
  const description =
    "Build an appointment-management application for a beauty clinic with reminders";
  assert.equal(deriveName(description), "Build an appointment-management application for a");
});

test("deriveName collapses internal newlines/multiple spaces like a single space when counting words", () => {
  assert.equal(deriveName("Build   an\napp  for   dog   walkers  please"), "Build an app for dog walkers");
});

/**
 * A description that is technically non-empty (so it passes the API's own
 * z.string().min(1) validation, which counts raw length before any
 * trimming) but contains no actual words -- e.g. a client that sent pure
 * whitespace -- must not produce an empty or whitespace-only project name.
 */
test("deriveName falls back to 'Untitled Project' for a whitespace-only description", () => {
  assert.equal(deriveName("   "), "Untitled Project");
  assert.equal(deriveName("\n\t "), "Untitled Project");
});

test("deriveName falls back to 'Untitled Project' for a genuinely empty description", () => {
  assert.equal(deriveName(""), "Untitled Project");
});

/**
 * deriveEntityName turns a free-text label typed into AddEntityForm into a
 * valid ASCII entity `name` -- the value both packages/db/src/migrate.ts and
 * apps/api/src/codegen.ts use directly as a SQL table name, so it can't be
 * empty, can't contain spaces/punctuation, and can't collide (even
 * case-insensitively) with an existing entity in the same spec.
 */
test("deriveEntityName title-cases and joins multi-word labels with no separator", () => {
  assert.equal(deriveEntityName("Loyalty Program", []), "LoyaltyProgram");
  assert.equal(deriveEntityName("loyalty-program", []), "LoyaltyProgram");
  assert.equal(deriveEntityName("payment", []), "Payment");
});

test("deriveEntityName falls back to 'Entity' when the label has no ASCII letters/digits at all", () => {
  assert.equal(deriveEntityName("תוכנית נאמנות", []), "Entity");
});

test("deriveEntityName appends the first free numeric suffix on a case-insensitive collision", () => {
  assert.equal(deriveEntityName("Payment", ["Customer"]), "Payment");
  assert.equal(deriveEntityName("Payment", ["Customer", "Payment"]), "Payment2");
  assert.equal(deriveEntityName("payment", ["Customer", "Payment"]), "Payment2");
  assert.equal(deriveEntityName("Payment", ["Payment", "Payment2"]), "Payment3");
});

/**
 * deriveFieldName is deriveEntityName's own counterpart for AddFieldForm --
 * same ASCII-identifier, no-collision requirements (it becomes a real SQL
 * column name in both packages/db/src/migrate.ts and apps/api/src/codegen.ts),
 * just camelCase instead of PascalCase, matching every existing domain-
 * library field's own convention (domainEntities.ts's "customerName",
 * "courierId", etc).
 */
test("deriveFieldName camelCases multi-word labels with no separator", () => {
  assert.equal(deriveFieldName("Phone Number", []), "phoneNumber");
  assert.equal(deriveFieldName("phone-number", []), "phoneNumber");
  assert.equal(deriveFieldName("Email", []), "email");
});

test("deriveFieldName falls back to 'field' when the label has no ASCII letters/digits at all", () => {
  assert.equal(deriveFieldName("מספר טלפון", []), "field");
});

test("deriveFieldName appends the first free numeric suffix on a case-insensitive collision with an existing field on the same entity", () => {
  assert.equal(deriveFieldName("Phone", ["name"]), "phone");
  assert.equal(deriveFieldName("Phone", ["name", "phone"]), "phone2");
  assert.equal(deriveFieldName("phone", ["name", "phone"]), "phone2");
  assert.equal(deriveFieldName("Phone", ["phone", "phone2"]), "phone3");
});

/**
 * A field named "id" or "createdAt" (in any casing) collides with the two
 * built-in columns every table already has (see FieldSchema's own
 * RESERVED_FIELD_NAMES check in @forge/shared) -- without this, a label
 * like "Id" or "Created At" would hand FieldSchema's refine() a name it
 * rejects, crashing updateProjectSpec's re-read with an uncaught schema
 * error instead of just picking a free name the same way a real collision
 * with another field on the entity does.
 */
test("deriveFieldName treats the built-in 'id'/'createdAt' column names as already taken", () => {
  assert.equal(deriveFieldName("Id", []), "id2");
  assert.equal(deriveFieldName("Created At", []), "createdAt2");
});
