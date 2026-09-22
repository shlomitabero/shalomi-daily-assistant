import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { formatValidationError, HttpError } from "./httpError.js";

/**
 * Every existing test that exercises formatValidationError does so
 * indirectly, through an HTTP round-trip (app.test.ts's signup/login
 * validation tests, the project-routes validation test), and only ever
 * checks that ONE particular issue's message shows up somewhere in the
 * response. None of them pin down the actual join behavior -- that every
 * issue's message survives, in order, separated by "; " -- so a
 * regression that silently dropped all but the first issue, or joined
 * with the wrong separator, would only be caught by luck (a test schema
 * that happens to put its checked field first/last).
 */
test("formatValidationError returns a single issue's message unchanged", () => {
  const schema = z.object({ password: z.string().min(8, "password must be at least 8 characters") });
  const result = schema.safeParse({ password: "short" });
  assert.ok(!result.success);
  assert.equal(formatValidationError(result.error), "password must be at least 8 characters");
});

test("formatValidationError joins multiple simultaneous issues with '; ', in schema-declared order, not just the first one", () => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(8, "password must be at least 8 characters"),
  });
  const result = schema.safeParse({ email: "not-an-email", password: "short" });
  assert.ok(!result.success);
  assert.equal(formatValidationError(result.error), "Invalid email; password must be at least 8 characters");
});

test("formatValidationError never leaks Zod's own JSON issue dump (the pre-fix bug this function exists to prevent)", () => {
  const schema = z.object({ email: z.string().email() });
  const result = schema.safeParse({ email: 123 });
  assert.ok(!result.success);
  const formatted = formatValidationError(result.error);
  assert.doesNotMatch(formatted, /^\[?\s*\{/, `expected readable text, got a JSON dump: ${formatted}`);
});

test("HttpError carries status, message, and an optional stable code the client can key a translated message off of", () => {
  const withCode = new HttpError(404, "Project \"x\" not found", "PROJECT_NOT_FOUND");
  assert.equal(withCode.status, 404);
  assert.equal(withCode.message, 'Project "x" not found');
  assert.equal(withCode.code, "PROJECT_NOT_FOUND");

  const withoutCode = new HttpError(500, "boom");
  assert.equal(withoutCode.code, undefined);
});
