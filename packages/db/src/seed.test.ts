import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { applyMigrations } from "./migrate.js";
import { insertRecord } from "./repository.js";
import { generateSeedRecords, orderForSeeding } from "./seed.js";

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

test("the Vendor, Expense, and Review entities each get believable seed values, not the generic person-name or placeholder fallback", () => {
  const vendor: Entity = {
    name: "Vendor",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "contactPerson", type: "text", required: false },
    ],
  };
  const expense: Entity = {
    name: "Expense",
    fields: [
      { name: "description", type: "text", required: true },
      { name: "vendor", type: "text", required: false },
    ],
  };
  const review: Entity = {
    name: "Review",
    fields: [
      { name: "reviewerName", type: "text", required: true },
      { name: "rating", type: "number", required: true },
    ],
  };

  const [vendorRecord] = generateSeedRecords(vendor, 1);
  // Vendor's own "name" is a business name, not a person -- must not fall
  // back to the generic person-name pool every other unrecognized "name"
  // field gets.
  assert.notEqual(vendorRecord.name, "Dana Levi");
  assert.equal(vendorRecord.contactPerson, "Dana Levi");

  const [expenseRecord] = generateSeedRecords(expense, 1);
  assert.doesNotMatch(expenseRecord.description as string, /Expense description/);
  assert.notEqual(expenseRecord.vendor, "Dana Levi");

  const [reviewRecord] = generateSeedRecords(review, 1);
  assert.equal(reviewRecord.reviewerName, "Dana Levi");
  // A star rating must stay in its real 1-5 domain, not the generic
  // (index+1)*10 formula every other numeric field uses.
  assert.ok((reviewRecord.rating as number) >= 1 && (reviewRecord.rating as number) <= 5);
});

test("the WorkOrder, Volunteer, and Case entities each get believable seed values, not the generic placeholder formula", () => {
  const workOrder: Entity = {
    name: "WorkOrder",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "technician", type: "text", required: false },
    ],
  };
  const volunteer: Entity = {
    name: "Volunteer",
    fields: [{ name: "name", type: "text", required: true }],
  };
  const legalCase: Entity = {
    name: "Case",
    fields: [{ name: "title", type: "text", required: true }],
  };

  const [workOrderRecord] = generateSeedRecords(workOrder, 1);
  assert.doesNotMatch(workOrderRecord.technician as string, /WorkOrder technician/);

  const [volunteerRecord] = generateSeedRecords(volunteer, 1);
  assert.doesNotMatch(volunteerRecord.name as string, /Volunteer name/);

  const [caseRecord] = generateSeedRecords(legalCase, 1);
  assert.doesNotMatch(caseRecord.title as string, /Case title/);
});

/**
 * Round 827's finding: the test above only ever checked that WorkOrder's
 * and Case's "title" field wasn't the generic "<Entity> title" placeholder
 * -- it already wasn't, but only because textSeedValueFor's "title" case
 * had no entity-aware dispatch at all (unlike its "name"/"description"
 * siblings just below it), so every entity with a "title" field silently
 * got Deal's own sample titles instead ("Annual contract", "Service
 * upgrade") -- nonsensical as a repair job description or a legal case
 * subject. Confirms WorkOrder/Case/Task each get their own dedicated,
 * field-appropriate title pool now, not Deal's.
 */
test("WorkOrder, Case, and Task each get their own field-appropriate 'title' seed values, not Deal's sales-pitch titles", () => {
  const workOrder: Entity = { name: "WorkOrder", fields: [{ name: "title", type: "text", required: true }] };
  const legalCase: Entity = { name: "Case", fields: [{ name: "title", type: "text", required: true }] };
  const task: Entity = { name: "Task", fields: [{ name: "title", type: "text", required: true }] };
  const deal: Entity = { name: "Deal", fields: [{ name: "title", type: "text", required: true }] };

  const dealTitles = new Set(generateSeedRecords(deal, 4).map((r) => r.title as string));

  const workOrderTitles = generateSeedRecords(workOrder, 4).map((r) => r.title as string);
  for (const title of workOrderTitles) assert.ok(!dealTitles.has(title), `WorkOrder's title "${title}" must not be one of Deal's own sample titles`);

  const caseTitles = generateSeedRecords(legalCase, 4).map((r) => r.title as string);
  for (const title of caseTitles) assert.ok(!dealTitles.has(title), `Case's title "${title}" must not be one of Deal's own sample titles`);

  const taskTitles = generateSeedRecords(task, 4).map((r) => r.title as string);
  for (const title of taskTitles) assert.ok(!dealTitles.has(title), `Task's title "${title}" must not be one of Deal's own sample titles`);
});

/**
 * Round 1105's finding: Case's own optional "caseType" field (the domain
 * entity's "practice area" field, added in the same commit as "title"'s
 * own Case branch just above) had no case in textSeedValueFor at all --
 * unlike "title", it was simply missed by both this fix and round 828's
 * sibling fix, so it fell through to the generic default placeholder
 * ("Case caseType 1" / "Case - caseType 1"), exactly the "obviously a
 * placeholder" formula this whole generator exists to avoid.
 */
test("Case's 'caseType' seed values are a plausible legal practice area, not the generic placeholder formula", () => {
  const legalCase: Entity = { name: "Case", fields: [{ name: "caseType", type: "text", required: false }] };

  const caseTypes = generateSeedRecords(legalCase, 4).map((r) => r.caseType as string);
  for (const caseType of caseTypes) assert.doesNotMatch(caseType, /Case caseType/, `"${caseType}" must not be the generic entity/field-name placeholder`);
});

/**
 * Round 1107's finding: Milestone and Supplier are hand-authored entities
 * in packages/spec-engine/src/templates.ts's Project Tracker and Inventory
 * templates respectively -- a separate catalog from domainEntities.ts that
 * none of the many past per-entity seed fixes (including round 827's own
 * "title" fix just above) ever cross-checked. Milestone's "title" fell all
 * the way through to Deal's sales-pitch titles ("Service upgrade"); a
 * Supplier (a business, the same shape as the already-covered Vendor
 * entity) fell through "name" to a random person's name instead of a
 * company name.
 */
test("Milestone's 'title' and Supplier's 'name' seed values are entity-appropriate, not Deal's sales titles or a random person's name", () => {
  const milestone: Entity = { name: "Milestone", fields: [{ name: "title", type: "text", required: true }] };
  const supplier: Entity = { name: "Supplier", fields: [{ name: "name", type: "text", required: true }] };
  const vendor: Entity = { name: "Vendor", fields: [{ name: "name", type: "text", required: true }] };
  const deal: Entity = { name: "Deal", fields: [{ name: "title", type: "text", required: true }] };

  const dealTitles = new Set(generateSeedRecords(deal, 4).map((r) => r.title as string));
  const milestoneTitles = generateSeedRecords(milestone, 4).map((r) => r.title as string);
  for (const title of milestoneTitles) assert.ok(!dealTitles.has(title), `Milestone's title "${title}" must not be one of Deal's own sample titles`);

  const vendorNames = new Set(generateSeedRecords(vendor, 4).map((r) => r.name as string));
  const supplierNames = generateSeedRecords(supplier, 4).map((r) => r.name as string);
  for (const name of supplierNames) assert.ok(vendorNames.has(name), `Supplier's name "${name}" must reuse Vendor's own business-name pool, not fall through to a random person's name`);
});

/**
 * Round 1114's finding: the CRM template's own Contact entity and the
 * Project Tracker template's own TeamMember entity (both templates.ts
 * hand-authored entities, same provenance as round 1107's Milestone/
 * Supplier) each have a "jobTitle" field with no case of its own in
 * textSeedValueFor -- round 1107's own cross-check only ever covered the
 * "title" and "name" cases, never auditing every other field name these
 * hand-authored entities use. "jobTitle" fell all the way through to the
 * generic placeholder ("Contact - jobTitle 1"), even though a pool for
 * this exact concept (a person's job title) already existed, built for
 * JobApplicant's "appliedFor" field. Mirrors round 1107's own fix: reuses
 * the existing pool rather than inventing a near-duplicate one.
 */
test("Contact's and TeamMember's 'jobTitle' seed values are real job titles, not the generic placeholder formula", () => {
  const contact: Entity = { name: "Contact", fields: [{ name: "jobTitle", type: "text", required: false }] };
  const teamMember: Entity = { name: "TeamMember", fields: [{ name: "jobTitle", type: "text", required: false }] };
  const jobApplicant: Entity = { name: "JobApplicant", fields: [{ name: "appliedFor", type: "text", required: false }] };

  const appliedForValues = new Set(generateSeedRecords(jobApplicant, 4).map((r) => r.appliedFor as string));

  const contactTitles = generateSeedRecords(contact, 4).map((r) => r.jobTitle as string);
  for (const title of contactTitles) {
    assert.doesNotMatch(title, /Contact.*jobTitle/, `"${title}" must not be the generic entity/field-name placeholder`);
    assert.ok(appliedForValues.has(title), `Contact's jobTitle "${title}" must reuse appliedFor's own job-title pool`);
  }

  const teamMemberTitles = generateSeedRecords(teamMember, 4).map((r) => r.jobTitle as string);
  for (const title of teamMemberTitles) {
    assert.doesNotMatch(title, /TeamMember.*jobTitle/, `"${title}" must not be the generic entity/field-name placeholder`);
    assert.ok(appliedForValues.has(title), `TeamMember's jobTitle "${title}" must reuse appliedFor's own job-title pool`);
  }
});

/**
 * Round 1115's finding: the same "N copies, N+1th missed" pattern as round
 * 1114's jobTitle fix, three more field names over. The Sales CRM
 * template's Customer.company, the Volunteer & Shift Management
 * template's Volunteer.skills and Shift.timeRange, and the Appointments &
 * Clients template's Staff.specialty (all templates.ts hand-authored
 * entities) had no case of their own, falling through to the generic
 * placeholder ("Customer - company 1", etc).
 */
test("Customer's 'company', Volunteer's 'skills', Shift's 'timeRange', and Staff's 'specialty' seed values are entity-appropriate, not the generic placeholder formula", () => {
  const customerEntity: Entity = { name: "Customer", fields: [{ name: "company", type: "text", required: false }] };
  const vendor: Entity = { name: "Vendor", fields: [{ name: "name", type: "text", required: true }] };
  const volunteer: Entity = { name: "Volunteer", fields: [{ name: "skills", type: "text", required: false }] };
  const shift: Entity = { name: "Shift", fields: [{ name: "timeRange", type: "text", required: false }] };
  const staff: Entity = { name: "Staff", fields: [{ name: "specialty", type: "text", required: false }] };

  const vendorNames = new Set(generateSeedRecords(vendor, 4).map((r) => r.name as string));
  const companies = generateSeedRecords(customerEntity, 4).map((r) => r.company as string);
  for (const company of companies) {
    assert.doesNotMatch(company, /Customer.*company/, `"${company}" must not be the generic entity/field-name placeholder`);
    assert.ok(vendorNames.has(company), `Customer's company "${company}" must reuse Vendor's own business-name pool`);
  }

  const skills = generateSeedRecords(volunteer, 4).map((r) => r.skills as string);
  for (const skill of skills) assert.doesNotMatch(skill, /Volunteer.*skills/, `"${skill}" must not be the generic entity/field-name placeholder`);

  const timeRanges = generateSeedRecords(shift, 4).map((r) => r.timeRange as string);
  for (const timeRange of timeRanges) assert.doesNotMatch(timeRange, /Shift.*timeRange/, `"${timeRange}" must not be the generic entity/field-name placeholder`);

  const specialties = generateSeedRecords(staff, 4).map((r) => r.specialty as string);
  for (const specialty of specialties) assert.doesNotMatch(specialty, /Staff.*specialty/, `"${specialty}" must not be the generic entity/field-name placeholder`);
});

/**
 * Round 828's finding: the exact same shape as round 827's "title" fix,
 * one case below it. textSeedValueFor's "service"/"itemName" case had no
 * entity-aware dispatch either -- ITEM_NAMES_HE/EN was written for
 * Appointment's "service" field ("Standard Treatment"/"Monthly Plan" fit a
 * scheduled service), but Rental's own required "itemName" field ("an item
 * rented out to a customer for a defined period" -- a physical piece of
 * equipment, not a service plan) silently fell into the same pool and
 * sample set.
 */
test("Rental's 'itemName' seed values are a plausible rentable item, not Appointment's service-plan phrasing", () => {
  const rental: Entity = { name: "Rental", fields: [{ name: "itemName", type: "text", required: true }] };
  const appointment: Entity = { name: "Appointment", fields: [{ name: "service", type: "text", required: false }] };

  const servicePlanNames = new Set(generateSeedRecords(appointment, 4).map((r) => r.service as string));

  const itemNames = generateSeedRecords(rental, 4).map((r) => r.itemName as string);
  for (const name of itemNames) assert.ok(!servicePlanNames.has(name), `Rental's itemName "${name}" must not be one of Appointment's own service-plan sample names`);
});

/**
 * Round 1244: the exact same shape as round 828's Rental fix just above,
 * for the sibling "name" case instead of "service"/"itemName". Product
 * (domainEntities.ts: "An item the business sells or tracks", with its own
 * sku/quantity fields -- a physical, countable inventory good) was lumped
 * into CATALOG_NAME_ENTITIES alongside Service, so its seeded "name" came
 * from the exact same ITEM_NAMES pool written for Appointment's own
 * "service" field ("Standard Treatment"/"Monthly Plan" fit a scheduled
 * service, not a SKU-and-stock-quantity inventory item).
 */
test("Product's 'name' seed values are a plausible retail good, not Appointment's service-plan phrasing", () => {
  const product: Entity = {
    name: "Product",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "sku", type: "text", required: false },
      { name: "quantity", type: "number", required: false },
    ],
  };
  const appointment: Entity = { name: "Appointment", fields: [{ name: "service", type: "text", required: false }] };

  const servicePlanNames = new Set(generateSeedRecords(appointment, 4).map((r) => r.service as string));

  const productNames = generateSeedRecords(product, 4).map((r) => r.name as string);
  for (const name of productNames) assert.ok(!servicePlanNames.has(name), `Product's name "${name}" must not be one of Appointment's own service-plan sample names`);
});

test("an unrecognized field name still gets a labeled fallback value instead of throwing", () => {
  const custom: Entity = { name: "Widget", fields: [{ name: "colorPreference", type: "text", required: false }] };
  const [record] = generateSeedRecords(custom, 1);
  assert.equal(record.colorPreference, "Widget colorPreference 1");
});

test("an entity with two date fields (e.g. Rental's startDate/endDate) gets distinct values, not the same date for both", () => {
  // seedValueFor's "date" case previously computed the value from the
  // record index alone, ignoring the field's own name -- every seeded
  // Rental record ended up with startDate === endDate (a 0-day rental),
  // which is visibly wrong the moment a real UI renders it.
  const rental: Entity = {
    name: "Rental",
    fields: [
      { name: "itemName", type: "text", required: true },
      { name: "startDate", type: "date", required: false },
      { name: "endDate", type: "date", required: false },
    ],
  };
  const [record] = generateSeedRecords(rental, 1);
  assert.notEqual(record.startDate, record.endDate, "startDate and endDate must not collapse to the same day");
  assert.ok((record.endDate as string) > (record.startDate as string), "endDate should be after startDate");
});

test("an entity with a checkInDate/checkoutDate pair (not literally named 'endDate') also gets distinct values", () => {
  // The previous fix above only ever matched a field name containing the
  // literal substring "end" -- a plausible, equally common booking-style
  // field name like "checkoutDate" (recognized as a real end-of-range field
  // by apps/web/src/entityFormatting.ts's own findEndDateField, used by the
  // calendar view and ICS export) fell through unnoticed and still
  // collapsed to the same 0-day-stay bug this file's own Rental test above
  // already guards against, just under a different field name.
  const booking: Entity = {
    name: "Booking",
    fields: [
      { name: "guestName", type: "text", required: true },
      { name: "checkInDate", type: "date", required: false },
      { name: "checkoutDate", type: "date", required: false },
    ],
  };
  const [record] = generateSeedRecords(booking, 1);
  assert.notEqual(record.checkInDate, record.checkoutDate, "checkInDate and checkoutDate must not collapse to the same day");
  assert.ok((record.checkoutDate as string) > (record.checkInDate as string), "checkoutDate should be after checkInDate");
});

test("an entity with two unrelated date fields (neither an end-of-range name) still gets distinct values", () => {
  // Both fixes above only ever distinguish a *recognized* end-of-range
  // field from its sibling -- seedValueFor's offset formula still ignored
  // the field's own identity for any two date fields that are both
  // unrecognized (not a start/end pair at all, e.g. an AI-generated
  // Employee's hireDate and birthDate), so they collapsed to the exact
  // same seeded date for every record, just like the Rental/Booking bugs
  // above but without either field matching an end-of-range name at all.
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "hireDate", type: "date", required: false },
      { name: "birthDate", type: "date", required: false },
    ],
  };
  const [record] = generateSeedRecords(employee, 1);
  assert.notEqual(record.hireDate, record.birthDate, "hireDate and birthDate must not collapse to the same day");
});

test("an entity with two RECOGNIZED end-of-range date fields (checkoutDate and returnDate) still gets distinct values", () => {
  // The fixes above only ever distinguish a recognized end-of-range field
  // from an unrecognized one, or two unrecognized fields from each other --
  // isEndLike's own branch gave every matching field the exact same
  // baseOffset - 3 with no further distinction, so two fields that BOTH
  // match END_DATE_FIELD_NAME_HINTS (e.g. a rental-style entity with both
  // checkoutDate and returnDate) still collapsed to the same seeded day,
  // the one case none of the prior fixes covered.
  const rental: Entity = {
    name: "Booking",
    fields: [
      { name: "startDate", type: "date", required: false },
      { name: "checkoutDate", type: "date", required: false },
      { name: "returnDate", type: "date", required: false },
    ],
  };
  const [record] = generateSeedRecords(rental, 1);
  assert.notEqual(record.checkoutDate, record.returnDate, "checkoutDate and returnDate must not collapse to the same day");
  assert.ok((record.checkoutDate as string) > (record.startDate as string), "checkoutDate should still be after startDate");
  assert.ok((record.returnDate as string) > (record.startDate as string), "returnDate should still be after startDate");
});

test("the generic fallback entity (Item, used when no domain keyword matches) seeds its name field as an item, not a person", () => {
  // "Item" is DEFAULT_ENTITY's real name (packages/spec-engine/src/
  // domainEntities.ts) -- the fallback hit whenever a description doesn't
  // match any domain-entity keyword. It wasn't in CATALOG_NAME_ENTITIES
  // (only Service/Product were), so its "name" field fell through to the
  // person-name pool, seeding e.g. "Dana Levi" as a generic item's name.
  const item: Entity = {
    name: "Item",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "longtext", required: false },
    ],
  };
  const [record] = generateSeedRecords(item, 1);
  assert.ok(
    !["Dana Levi", "Yossi Cohen", "Michal Abraham"].includes(record.name as string),
    `Item's name field should not be seeded as a person name, got: ${record.name}`,
  );
});

/**
 * Regression test: orderForSeeding is the fix for the gap seedValueFor's
 * own "relation" case documents (a required relation field's best-effort
 * id=1 guess is only correct if its target already has a real row 1).
 * A spec listing the dependent entity before its target -- an entirely
 * ordinary data model an AI-generated or refined spec can easily produce --
 * must come out reordered so the target is seeded first.
 */
test("orderForSeeding moves a required relation's target entity before its dependent, even when the spec lists them the other way around", () => {
  const invoice: Entity = {
    name: "Invoice",
    fields: [{ name: "customerId", type: "relation", relationTo: "Customer", required: true }],
  };
  const customerEntity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  assert.deepEqual(
    orderForSeeding([invoice, customerEntity]).map((e) => e.name),
    ["Customer", "Invoice"],
  );
});

test("orderForSeeding leaves entities with no required-relation dependency between them in their original relative order", () => {
  const a: Entity = { name: "A", fields: [{ name: "name", type: "text", required: true }] };
  const b: Entity = { name: "B", fields: [{ name: "name", type: "text", required: true }] };
  const c: Entity = { name: "C", fields: [{ name: "name", type: "text", required: true }] };
  assert.deepEqual(
    orderForSeeding([a, b, c]).map((e) => e.name),
    ["A", "B", "C"],
  );
});

test("orderForSeeding doesn't reorder an OPTIONAL relation's target -- only a required one actually needs a real row to point at", () => {
  const order: Entity = {
    name: "Order",
    fields: [{ name: "courierId", type: "relation", relationTo: "Courier", required: false }],
  };
  const courier: Entity = { name: "Courier", fields: [{ name: "name", type: "text", required: true }] };
  assert.deepEqual(
    orderForSeeding([order, courier]).map((e) => e.name),
    ["Order", "Courier"],
  );
});

test("orderForSeeding falls back to the original order instead of looping forever when two entities require each other (a genuine cycle)", () => {
  const a: Entity = {
    name: "A",
    fields: [{ name: "bId", type: "relation", relationTo: "B", required: true }],
  };
  const b: Entity = {
    name: "B",
    fields: [{ name: "aId", type: "relation", relationTo: "A", required: true }],
  };
  assert.deepEqual(
    orderForSeeding([a, b]).map((e) => e.name),
    ["A", "B"],
  );
});

test("orderForSeeding doesn't loop forever on a self-relation (e.g. Employee.managerId -> Employee)", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [{ name: "managerId", type: "relation", relationTo: "Employee", required: true }],
  };
  assert.deepEqual(
    orderForSeeding([employee]).map((e) => e.name),
    ["Employee"],
  );
});

/**
 * Round 1209: the same casing drift rounds 1159-1188/1196/1208 already
 * fixed in every other consumer of relationTo -- an ordinary refine can
 * leave a relation field's relationTo differently cased from its real
 * target entity's declared name. Before this fix, "customer" (lower-case
 * relationTo) against a real entity declared "Customer" silently failed
 * the exact-string Set.has check this dependency edge relied on, so
 * Invoice was never recognized as depending on Customer and could be
 * seeded first -- exactly the gap this whole function exists to close.
 */
test("orderForSeeding still moves the target entity first when relationTo differs from the target's own declared name only by letter case", () => {
  const invoice: Entity = {
    name: "Invoice",
    fields: [{ name: "customerId", type: "relation", relationTo: "customer", required: true }],
  };
  const customerEntity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  assert.deepEqual(
    orderForSeeding([invoice, customerEntity]).map((e) => e.name),
    ["Customer", "Invoice"],
  );
});

test("orderForSeeding still recognizes a self-relation as a non-dependency when relationTo differs from the entity's own name only by letter case", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [{ name: "managerId", type: "relation", relationTo: "employee", required: true }],
  };
  assert.deepEqual(
    orderForSeeding([employee]).map((e) => e.name),
    ["Employee"],
  );
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

/**
 * Round 1148's finding: VolunteerEvent (the Volunteer & Shift Management
 * template's own entity, templates.ts) has a "name" field with no case of
 * its own in textSeedValueFor's "name" switch -- round 1115's own
 * cross-check of this exact template only ever reached three of its OTHER
 * field names (Volunteer.skills, Shift.timeRange, Staff.specialty), never
 * VolunteerEvent's own "name". It fell all the way through to the generic
 * person-name default, seeding an event's own name with a random person's
 * name ("Dana Levi") instead of an event name.
 */
test("VolunteerEvent's 'name' seed values are entity-appropriate event names, not a random person's name", () => {
  const volunteerEvent: Entity = { name: "VolunteerEvent", fields: [{ name: "name", type: "text", required: true }] };
  const event: Entity = { name: "Event", fields: [{ name: "name", type: "text", required: true }] };

  const eventNames = new Set(generateSeedRecords(event, 4).map((r) => r.name as string));
  const volunteerEventNames = generateSeedRecords(volunteerEvent, 4).map((r) => r.name as string);
  for (const name of volunteerEventNames) {
    assert.ok(eventNames.has(name), `VolunteerEvent's name "${name}" must reuse Event's own event-name pool, not fall through to a random person's name`);
  }
});
