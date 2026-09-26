import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveName } from "./projects.js";

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
