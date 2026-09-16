import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { applyMigrations } from "./migrate.js";
import { insertRecord } from "./repository.js";
import { generateSeedRecords } from "./seed.js";

const customer: Entity = {
  name: "Customer",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "vip", type: "boolean", required: false },
    { name: "status", type: "enum", required: true, enumValues: ["New", "Won"] },
    { name: "joined", type: "date", required: false },
  ],
};

test("generateSeedRecords produces the requested count with type-appropriate values", () => {
  const records = generateSeedRecords(customer, 3);
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(typeof record.name, "string");
    assert.equal(typeof record.vip, "boolean");
    assert.ok(["New", "Won"].includes(record.status as string));
  }
});

test("seed records use believable values for known field names, not a generic placeholder formula", () => {
  const customerEntity: Entity = {
    name: "Customer",
    label: "לקוחות",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "email", label: "אימייל", type: "text", required: false },
      { name: "phone", label: "טלפון", type: "text", required: false },
      { name: "source", label: "מקור", type: "text", required: false },
    ],
  };
  const records = generateSeedRecords(customerEntity, 2);

  for (const record of records) {
    // Not the old "לקוחות - שם 1" style placeholder formula.
    assert.doesNotMatch(record.name as string, /לקוחות - שם/);
    assert.match(record.email as string, /^[a-z.]+@example\.com$/);
    assert.match(record.phone as string, /^0\d{2}-\d{3}-\d{4}$/);
  }
  // The two records should actually differ, not repeat the same value.
  assert.notEqual(records[0].name, records[1].name);
  assert.notEqual(records[0].email, records[1].email);
});

test("the same 'name' field means a person for Customer but a catalog item for Service", () => {
  const customerEntity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const serviceEntity: Entity = { name: "Service", fields: [{ name: "name", type: "text", required: true }] };

  const [customerRecord] = generateSeedRecords(customerEntity, 1);
  const [serviceRecord] = generateSeedRecords(serviceEntity, 1);

  assert.equal(customerRecord.name, "Dana Levi");
  assert.equal(serviceRecord.name, "Basic Package");
});

test("the newer domain entities (MenuItem, Vehicle, Project, Event, Course, Pet, Property) each get their own believable values, not the generic person-name fallback", () => {
  const menuItem: Entity = { name: "MenuItem", fields: [{ name: "name", type: "text", required: true }] };
  const vehicle: Entity = {
    name: "Vehicle",
    fields: [
      { name: "licensePlate", type: "text", required: true },
      { name: "make", type: "text", required: false },
      { name: "model", type: "text", required: false },
    ],
  };
  const project: Entity = {
    name: "Project",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "client", type: "text", required: false },
    ],
  };
  const event: Entity = {
    name: "Event",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "venue", type: "text", required: false },
    ],
  };
  const course: Entity = {
    name: "Course",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "instructor", type: "text", required: false },
    ],
  };
  const pet: Entity = {
    name: "Pet",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "species", type: "text", required: false },
      { name: "ownerName", type: "text", required: false },
    ],
  };
  const property: Entity = { name: "Property", fields: [{ name: "address", type: "text", required: true }] };
  const rental: Entity = {
    name: "Rental",
    fields: [
      { name: "itemName", type: "text", required: true },
      { name: "renterName", type: "text", required: false },
    ],
  };

  assert.equal(generateSeedRecords(menuItem, 1)[0].name, "Margherita Pizza");

  const [vehicleRecord] = generateSeedRecords(vehicle, 1);
  assert.doesNotMatch(vehicleRecord.licensePlate as string, /Vehicle licensePlate/);
  assert.doesNotMatch(vehicleRecord.make as string, /Vehicle make/);
  assert.doesNotMatch(vehicleRecord.model as string, /Vehicle model/);

  const [projectRecord] = generateSeedRecords(project, 1);
  assert.equal(projectRecord.name, "Website Redesign");
  assert.doesNotMatch(projectRecord.client as string, /Project client/);

  const [eventRecord] = generateSeedRecords(event, 1);
  assert.equal(eventRecord.name, "Annual Conference");
  assert.doesNotMatch(eventRecord.venue as string, /Event venue/);

  const [courseRecord] = generateSeedRecords(course, 1);
  assert.equal(courseRecord.name, "Intro to Programming");
  assert.doesNotMatch(courseRecord.instructor as string, /Course instructor/);

  const [petRecord] = generateSeedRecords(pet, 1);
  assert.equal(petRecord.name, "Rex");
  assert.doesNotMatch(petRecord.species as string, /Pet species/);
  assert.doesNotMatch(petRecord.ownerName as string, /Pet ownerName/);

  const [propertyRecord] = generateSeedRecords(property, 1);
  assert.doesNotMatch(propertyRecord.address as string, /Property address/);

  const [rentalRecord] = generateSeedRecords(rental, 1);
  assert.doesNotMatch(rentalRecord.itemName as string, /Rental itemName/);
  assert.doesNotMatch(rentalRecord.renterName as string, /Rental renterName/);
});

test("an unrecognized field name still gets a labeled fallback value instead of throwing", () => {
  const custom: Entity = { name: "Widget", fields: [{ name: "colorPreference", type: "text", required: false }] };
  const [record] = generateSeedRecords(custom, 1);
  assert.equal(record.colorPreference, "Widget colorPreference 1");
});

test("seed records satisfy the real repository validation and insert cleanly", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", {
    summary: "t",
    personas: [],
    roles: ["Admin"],
    entities: [customer],
    screens: [],
    assumptions: [],
    openQuestions: [],
  });
  const records = generateSeedRecords(customer, 2);
  for (const record of records) {
    const inserted = insertRecord(db, "proj1", customer, record);
    assert.ok(inserted.id);
  }
});
