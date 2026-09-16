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

test("the Ticket, Subscription, and JobApplicant entities each get believable seed values, not the generic placeholder formula", () => {
  const ticket: Entity = {
    name: "Ticket",
    fields: [
      { name: "subject", type: "text", required: true },
      { name: "customerId", type: "relation", required: false, relationTo: "Customer" },
      { name: "assignee", type: "text", required: false },
    ],
  };
  const subscription: Entity = {
    name: "Subscription",
    fields: [{ name: "planName", type: "text", required: true }],
  };
  const jobApplicant: Entity = {
    name: "JobApplicant",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "appliedFor", type: "text", required: false },
    ],
  };

  const [ticketRecord] = generateSeedRecords(ticket, 1);
  assert.doesNotMatch(ticketRecord.subject as string, /Ticket subject/);
  assert.equal(ticketRecord.customerId, null); // optional relation: no guaranteed related row to point at
  assert.doesNotMatch(ticketRecord.assignee as string, /Ticket assignee/);

  const [subscriptionRecord] = generateSeedRecords(subscription, 1);
  assert.doesNotMatch(subscriptionRecord.planName as string, /Subscription planName/);

  const [applicantRecord] = generateSeedRecords(jobApplicant, 1);
  // "name" means a person here (not a catalog item), same as Customer.
  assert.equal(applicantRecord.name, "Dana Levi");
  assert.doesNotMatch(applicantRecord.appliedFor as string, /JobApplicant appliedFor/);
});

test("the Donation, Shipment, and InsuranceClaim entities each get believable seed values, not the generic placeholder formula", () => {
  const donation: Entity = {
    name: "Donation",
    fields: [
      { name: "donorName", type: "text", required: true },
      { name: "campaign", type: "text", required: false },
    ],
  };
  const shipment: Entity = {
    name: "Shipment",
    fields: [
      { name: "trackingNumber", type: "text", required: true },
      { name: "carrier", type: "text", required: false },
      { name: "destination", type: "text", required: false },
    ],
  };
  const claim: Entity = {
    name: "InsuranceClaim",
    fields: [
      { name: "claimant", type: "text", required: true },
      { name: "policyNumber", type: "text", required: false },
    ],
  };

  const [donationRecord] = generateSeedRecords(donation, 1);
  assert.equal(donationRecord.donorName, "Dana Levi");
  assert.doesNotMatch(donationRecord.campaign as string, /Donation campaign/);

  const [shipmentRecord] = generateSeedRecords(shipment, 1);
  assert.doesNotMatch(shipmentRecord.trackingNumber as string, /Shipment trackingNumber/);
  assert.match(shipmentRecord.trackingNumber as string, /^TRK-\d+$/);
  assert.doesNotMatch(shipmentRecord.carrier as string, /Shipment carrier/);
  assert.doesNotMatch(shipmentRecord.destination as string, /Shipment destination/);

  const [claimRecord] = generateSeedRecords(claim, 1);
  assert.equal(claimRecord.claimant, "Dana Levi");
  assert.match(claimRecord.policyNumber as string, /^POL-\d+$/);
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
