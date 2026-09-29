import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveEntityName, deriveName } from "./projects.js";

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
