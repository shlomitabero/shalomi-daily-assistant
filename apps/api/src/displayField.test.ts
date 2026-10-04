import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@forge/shared";
import { pickDisplayField, recordDisplayLabel } from "./displayField.js";

test("pickDisplayField prefers a field literally named name or title over any other field", () => {
  const entity: Entity = {
    name: "Customer",
    fields: [
      { name: "phone", type: "text", required: false },
      { name: "name", type: "text", required: true },
      { name: "email", type: "text", required: false },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "name");
});

test("pickDisplayField falls back to the first text field when there's no name/title field", () => {
  const entity: Entity = {
    name: "Order",
    fields: [
      { name: "total", type: "number", required: true },
      { name: "notes", type: "text", required: false },
    ],
  };
  assert.equal(pickDisplayField(entity)?.name, "notes");
});

test("pickDisplayField falls back to the entity's first field of any type as a last resort", () => {
  const entity: Entity = {
    name: "Metric",
    fields: [{ name: "value", type: "number", required: true }],
  };
  assert.equal(pickDisplayField(entity)?.name, "value");
});

test("pickDisplayField's tie-break between a name field and a title field follows field declaration order, not name-before-title priority", () => {
  // DISPLAY_FIELD_NAME_HINTS lists "name" before "title", which reads like a
  // priority order, but pickDisplayField iterates entity.fields (not the
  // hints list) and returns the first field whose own name matches any
  // hint -- so when an entity happens to declare "title" before "name",
  // "title" wins, not "name". This is a real, if accidental, behavior that
  // a future refactor (e.g. "look up each hint in priority order instead")
  // would plausibly and silently flip.
  const titleFirst: Entity = {
    name: "Article",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "name", type: "text", required: true },
    ],
  };
  assert.equal(pickDisplayField(titleFirst)?.name, "title");

  const nameFirst: Entity = {
    name: "Article",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "title", type: "text", required: true },
    ],
  };
  assert.equal(pickDisplayField(nameFirst)?.name, "name");
});

test("recordDisplayLabel renders #<id> when the display field's value is missing or empty", () => {
  const entity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  assert.equal(recordDisplayLabel(entity, { id: 7, createdAt: "", name: "" }), "#7");
  assert.equal(recordDisplayLabel(entity, { id: 8, createdAt: "", name: null }), "#8");
  assert.equal(recordDisplayLabel(entity, { id: 9, createdAt: "", name: "Dana Levi" }), "Dana Levi");
});
