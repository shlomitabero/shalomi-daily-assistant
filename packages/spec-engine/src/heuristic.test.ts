import assert from "node:assert/strict";
import { test } from "node:test";
import { HeuristicSpecProvider } from "./heuristic.js";

test("generates a beauty-clinic appointment spec from the acceptance-test description", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate(
    "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
  );

  const entityNames = spec.entities.map((e) => e.name).sort();
  assert.deepEqual(entityNames, ["Appointment", "Customer", "Employee", "Service"]);
  assert.ok(spec.roles.includes("Admin"));
  assert.ok(spec.roles.includes("Employee"));
  assert.ok(spec.screens.some((s) => s.type === "dashboard"));

  const appointment = spec.entities.find((e) => e.name === "Appointment")!;
  const statusField = appointment.fields.find((f) => f.name === "status");
  assert.ok(statusField, "Appointment must have a status field");
  assert.equal(statusField!.type, "enum");
});

test("falls back to a generic Item entity when nothing recognizable is mentioned", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("I want to organize my hobby collection.");
  assert.deepEqual(
    spec.entities.map((e) => e.name),
    ["Item"],
  );
});

test("rejects an empty description", async () => {
  const provider = new HeuristicSpecProvider();
  await assert.rejects(() => provider.generate(""));
});

test("asks about payments when billing entities are implied", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("A shop that tracks orders and sends invoices to customers.");
  const paymentQuestion = spec.openQuestions.find((q) => q.question.toLowerCase().includes("payment"));
  assert.ok(paymentQuestion);
  assert.ok(paymentQuestion!.options.includes("Stripe"));
});

test("detects Hebrew input and returns Hebrew labels while keeping ASCII names", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate(
    "אני צריך אפליקציה לניהול לקוחות למספרה, עם תורים, עובדים ושירותים",
  );

  const entityNames = spec.entities.map((e) => e.name).sort();
  assert.deepEqual(entityNames, ["Appointment", "Customer", "Employee", "Service"]);

  // Names stay ASCII (real SQL identifiers); labels are the Hebrew display text.
  const customer = spec.entities.find((e) => e.name === "Customer")!;
  assert.equal(customer.label, "לקוחות");
  const nameField = customer.fields.find((f) => f.name === "name")!;
  assert.equal(nameField.label, "שם");

  assert.match(spec.summary, /[֐-׿]/);
  assert.ok(spec.roles.some((r) => /[֐-׿]/.test(r)));
  assert.ok(spec.assumptions.every((a) => /[֐-׿]/.test(a)));
  assert.match(spec.openQuestions[0].question, /[֐-׿]/);
});

test("English input still produces English labels (no Hebrew leaks in)", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("A CRM with customers and deals.");
  const customer = spec.entities.find((e) => e.name === "Customer")!;
  assert.equal(customer.label, undefined);
  assert.doesNotMatch(spec.summary, /[֐-׿]/);
});

// Regression test for a real user complaint: describing a delivery app like
// Wolt used to fall through to the generic single "Item" entity because no
// domain rule recognized "delivery"/"משלוחים" at all -- see docs/roadmap.md.
test("a delivery app description (like the real 'wolt' user report) produces a real tailored Order entity, not the generic Item fallback", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("אפליקציה משלוחים כמו wolt");
  const entityNames = spec.entities.map((e) => e.name);
  assert.ok(!entityNames.includes("Item"), `Expected tailored entities, got generic fallback: ${entityNames}`);
  assert.ok(entityNames.includes("Order"), `Expected an Order entity for a delivery app, got: ${entityNames}`);
});

test("a restaurant-with-delivery description produces menu, order, and courier entities together", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("An order-management app for a restaurant with delivery, including a menu and couriers.");
  const entityNames = spec.entities.map((e) => e.name).sort();
  assert.deepEqual(entityNames, ["Courier", "MenuItem", "Order"]);
});

test("recognizes real-estate, education, healthcare, and project-management descriptions with tailored entities", async () => {
  const provider = new HeuristicSpecProvider();

  const realEstate = await provider.generate("An app to manage real estate properties and listings for sale or rent.");
  assert.ok(realEstate.entities.some((e) => e.name === "Property"));

  const education = await provider.generate("An app for a school to manage students and their courses.");
  const eduNames = education.entities.map((e) => e.name).sort();
  assert.deepEqual(eduNames, ["Course", "Student"]);

  const clinic = await provider.generate("An app for a clinic to manage patients.");
  assert.ok(clinic.entities.some((e) => e.name === "Patient"));

  const agency = await provider.generate("An app for an agency to manage projects and tasks.");
  const agencyNames = agency.entities.map((e) => e.name).sort();
  assert.deepEqual(agencyNames, ["Project", "Task"]);
});

test("the Course entity rule doesn't spuriously trigger on the common English phrase 'of course'", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("I want to track my customers, of course, and their orders.");
  assert.ok(!spec.entities.some((e) => e.name === "Course"), "the substring 'course' inside 'of course' must not match the Course entity rule");
});

test("recognizes vehicle/garage, event-planning, veterinary, and equipment-rental descriptions with tailored entities", async () => {
  const provider = new HeuristicSpecProvider();

  const garage = await provider.generate("An app for a garage to manage vehicles and mechanics.");
  assert.ok(garage.entities.some((e) => e.name === "Vehicle"));

  const eventPlanner = await provider.generate("An app for an event planning business to manage events and weddings.");
  assert.ok(eventPlanner.entities.some((e) => e.name === "Event"));

  const vet = await provider.generate("An app for a veterinary clinic to track pet owners' animals.");
  assert.ok(vet.entities.some((e) => e.name === "Pet"));

  const rentalShop = await provider.generate("An app for an equipment rental business.");
  assert.ok(rentalShop.entities.some((e) => e.name === "Rental"));
});

test("the new Event/Vehicle/Rental keywords don't spuriously trigger on common unrelated phrases", async () => {
  const provider = new HeuristicSpecProvider();

  const spec1 = await provider.generate("This prevents double bookings and keeps our current customers happy.");
  assert.ok(!spec1.entities.some((e) => e.name === "Event"), "'prevents'/'current' must not match the Event entity rule");

  const spec2 = await provider.generate("A CRM that helps our sales team close more deals with current clients.");
  assert.ok(!spec2.entities.some((e) => e.name === "Vehicle"), "must not spuriously match Vehicle");
  assert.ok(!spec2.entities.some((e) => e.name === "Rental"), "must not spuriously match Rental");
});
