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
