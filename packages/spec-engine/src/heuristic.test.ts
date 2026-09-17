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

test("Order gets an optional courierId relation field pointing to Courier, not a raw duplicated text field", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("An order-management app for a restaurant with delivery, including a menu and couriers.");
  const order = spec.entities.find((e) => e.name === "Order")!;
  const courierField = order.fields.find((f) => f.name === "courierId");
  assert.ok(courierField, "Order must have a courierId field");
  assert.equal(courierField!.type, "relation");
  assert.equal(courierField!.relationTo, "Courier");
  assert.equal(courierField!.required, false); // optional: an order-only description won't have a Courier table at all

  // A plain order description (no courier/driver mentioned) still gets the
  // field -- it's just not assignable to anything real yet, same as a real
  // app's "assignee" field before anyone is hired.
  const plainOrders = await provider.generate("A shop that tracks customer orders.");
  const plainOrder = plainOrders.entities.find((e) => e.name === "Order")!;
  assert.ok(plainOrder.fields.some((f) => f.name === "courierId"));
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

test("recognizes support-desk, subscription-billing, and recruitment descriptions with tailored entities", async () => {
  const provider = new HeuristicSpecProvider();

  const helpdesk = await provider.generate("A support ticket system for our customer support team.");
  assert.ok(helpdesk.entities.some((e) => e.name === "Ticket"));

  // Regression test: Hebrew construct-state phrasing ("תמיכת לקוחות" =
  // "customer support") inflects the base word's ending, so the bare
  // "תמיכה" keyword alone doesn't match it as a substring -- caught by
  // actually running this exact phrase through a real build, not just
  // string-matching the keyword list. Fixed by also matching "תמיכת".
  const helpdeskHe = await provider.generate("אפליקציית תמיכת לקוחות לניהול פניות");
  assert.ok(helpdeskHe.entities.some((e) => e.name === "Ticket"), "the construct-state phrase 'תמיכת לקוחות' must still match Ticket");

  const saas = await provider.generate("A subscription management app to track customer membership plans.");
  assert.ok(saas.entities.some((e) => e.name === "Subscription"));

  const ats = await provider.generate("An app to track job applicants through our hiring process.");
  assert.ok(ats.entities.some((e) => e.name === "JobApplicant"));

  // Ticket and Subscription both get an optional relation to Customer.
  const ticket = helpdesk.entities.find((e) => e.name === "Ticket")!;
  const ticketCustomerField = ticket.fields.find((f) => f.name === "customerId")!;
  assert.equal(ticketCustomerField.type, "relation");
  assert.equal(ticketCustomerField.relationTo, "Customer");
  assert.equal(ticketCustomerField.required, false);

  const subscription = saas.entities.find((e) => e.name === "Subscription")!;
  const subCustomerField = subscription.fields.find((f) => f.name === "customerId")!;
  assert.equal(subCustomerField.type, "relation");
  assert.equal(subCustomerField.relationTo, "Customer");
});

test("Ticket/Subscription/JobApplicant keywords avoid the substring collisions their obvious phrasing would have caused", async () => {
  const provider = new HeuristicSpecProvider();

  // JobApplicant deliberately uses "hiring" alone, not "hiring pipeline" --
  // the obvious phrase -- because "pipeline" is Deal's own keyword. A
  // recruitment description would otherwise spuriously also match Deal.
  const recruiting = await provider.generate("Track candidates through our hiring process for open roles.");
  assert.ok(recruiting.entities.some((e) => e.name === "JobApplicant"));
  assert.ok(!recruiting.entities.some((e) => e.name === "Deal"), "'hiring' must not spuriously match Deal via a 'pipeline' substring that was deliberately left out");

  // Same reasoning in Hebrew: "גיוס" alone, not "גיוס עובדים" -- the obvious
  // phrase -- because "עובדים" is Employee's own keyword. A recruitment
  // description in Hebrew would otherwise spuriously also match Employee.
  const recruitingHe = await provider.generate("אפליקציה לניהול מועמדים בתהליך הגיוס שלנו");
  assert.ok(recruitingHe.entities.some((e) => e.name === "JobApplicant"));
  assert.ok(!recruitingHe.entities.some((e) => e.name === "Employee"), "'גיוס' must not spuriously match Employee via an 'עובדים' substring that was deliberately left out");
});

test("recognizes nonprofit-donation, logistics/warehouse, and insurance-claims descriptions with tailored entities", async () => {
  const provider = new HeuristicSpecProvider();

  const nonprofit = await provider.generate("A nonprofit app to track donations from our donors.");
  assert.ok(nonprofit.entities.some((e) => e.name === "Donation"));

  const warehouse = await provider.generate("A warehouse management app for package tracking and freight.");
  assert.ok(warehouse.entities.some((e) => e.name === "Shipment"));

  const insurer = await provider.generate("An app for processing insurance claims from policyholders.");
  assert.ok(insurer.entities.some((e) => e.name === "InsuranceClaim"));

  // The same phrasing in Hebrew.
  const nonprofitHe = await provider.generate("אפליקציה לעמותה למעקב אחר תרומות מתורמים");
  assert.ok(nonprofitHe.entities.some((e) => e.name === "Donation"));

  const warehouseHe = await provider.generate("אפליקציה לניהול מחסן ומעקב אחר שילוח חבילות");
  assert.ok(warehouseHe.entities.some((e) => e.name === "Shipment"));

  const insurerHe = await provider.generate("אפליקציה לטיפול בתביעות ביטוח מבעלי פוליסה");
  assert.ok(insurerHe.entities.some((e) => e.name === "InsuranceClaim"));
});

test("Donation/Shipment keywords avoid the substring collisions their obvious phrasing would have caused", async () => {
  const provider = new HeuristicSpecProvider();

  // Donation deliberately doesn't use "גיוס כספים" (fundraising) -- the
  // obvious Hebrew phrase -- because "גיוס" is JobApplicant's own keyword
  // and Hebrew overloads that root for both "recruiting people" and
  // "recruiting money".
  const nonprofitHe = await provider.generate("אפליקציה לעמותה עם תרומות מתורמים");
  assert.ok(nonprofitHe.entities.some((e) => e.name === "Donation"));
  assert.ok(!nonprofitHe.entities.some((e) => e.name === "JobApplicant"), "a donation description must not spuriously match JobApplicant");

  // Shipment uses "שילוח" (dispatch/freight), not "משלוח" (parcel/delivery)
  // -- Order's own keyword -- so a warehouse/logistics description doesn't
  // spuriously also match Order.
  const warehouseHe = await provider.generate("אפליקציה לניהול מחסן ולוגיסטיקה, כולל מעקב חבילות ושילוח");
  assert.ok(warehouseHe.entities.some((e) => e.name === "Shipment"));
  assert.ok(!warehouseHe.entities.some((e) => e.name === "Order"), "a warehouse/logistics description must not spuriously match Order via a 'משלוח' substring");
});

// Regression test for a real bug caught by actually running a build, not by
// inspecting the keyword lists: "תורם"/"תורמים" ("donor"/"donors") both
// *start with* "תור" ("turn/appointment", Appointment's own former bare
// keyword), a coincidental shared root -- not a prefix/suffix inflection
// issue like the earlier "תמיכת" construct-state bug. A donation
// description mentioning donors used to spuriously produce an Appointment
// entity too. Fixed by dropping the bare singular "תור" keyword from
// Appointment (the plural "תורים", used by every real test/description
// already, has no such collision).
test("a donation description mentioning 'תורמים' (donors) does not spuriously match Appointment via a 'תור' substring", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("אפליקציה לעמותה למעקב אחר תרומות מתורמים ומקבלי תרומה");
  assert.ok(spec.entities.some((e) => e.name === "Donation"));
  assert.ok(!spec.entities.some((e) => e.name === "Appointment"), "'תורמים' must not spuriously match Appointment via a 'תור' substring");
});

test("recognizes vendor/supplier, business-expense, and customer-review descriptions with tailored entities", async () => {
  const provider = new HeuristicSpecProvider();

  const procurement = await provider.generate("An app to manage our vendors and suppliers for procurement.");
  assert.ok(procurement.entities.some((e) => e.name === "Vendor"));

  const bookkeeping = await provider.generate("An app for tracking business expenses.");
  assert.ok(bookkeeping.entities.some((e) => e.name === "Expense"));

  const reviews = await provider.generate("An app to collect customer reviews and testimonials for our shop.");
  assert.ok(reviews.entities.some((e) => e.name === "Review"));

  // The same phrasing in Hebrew.
  const procurementHe = await provider.generate("אפליקציה לניהול ספקים ורכש");
  assert.ok(procurementHe.entities.some((e) => e.name === "Vendor"));

  const bookkeepingHe = await provider.generate("אפליקציה למעקב הוצאות של העסק");
  assert.ok(bookkeepingHe.entities.some((e) => e.name === "Expense"));

  const reviewsHe = await provider.generate("אפליקציה לאיסוף ביקורות ומשוב מלקוחות");
  assert.ok(reviewsHe.entities.some((e) => e.name === "Review"));
});

// Regression guard for the exact "events" ⊂ "prevents" pitfall this file's
// header warns about: bare "rating"/"review" were deliberately left out of
// Review's keyword list because they're substrings of common unrelated
// words ("operating", "preview"). A description that happens to contain
// those words must not spuriously produce a Review entity.
test("Review's keywords avoid the substring collisions bare 'rating'/'review' would have caused", async () => {
  const provider = new HeuristicSpecProvider();

  const operations = await provider.generate("An app for operating and coordinating our field service team.");
  assert.ok(!operations.entities.some((e) => e.name === "Review"), "'operating' must not spuriously match Review via a 'rating' substring");

  const preview = await provider.generate("An app with a live preview of the product catalog for our sales team.");
  assert.ok(!preview.entities.some((e) => e.name === "Review"), "'preview' must not spuriously match Review via a 'review' substring");
});

test("recognizes field-service/repair, nonprofit-volunteer, and legal-case descriptions with tailored entities", async () => {
  const provider = new HeuristicSpecProvider();

  const repair = await provider.generate("An app for scheduling repair jobs and service calls for our plumbing business.");
  assert.ok(repair.entities.some((e) => e.name === "WorkOrder"));

  const nonprofit = await provider.generate("An app to manage our volunteers and their shifts.");
  assert.ok(nonprofit.entities.some((e) => e.name === "Volunteer"));

  const legal = await provider.generate("An app for our law firm to track legal cases for clients.");
  assert.ok(legal.entities.some((e) => e.name === "Case"));

  // The same phrasing in Hebrew, using the natural plural form a real idea
  // description would use ("קריאות שירות"/"תיקים משפטיים"), not just the
  // singular/construct form the keyword list happens to lead with.
  const repairHe = await provider.generate("אפליקציה לניהול קריאות שירות לטכנאי מזגנים");
  assert.ok(repairHe.entities.some((e) => e.name === "WorkOrder"));

  const nonprofitHe = await provider.generate("אפליקציה לניהול מתנדבים בעמותה");
  assert.ok(nonprofitHe.entities.some((e) => e.name === "Volunteer"));

  const legalHe = await provider.generate("אפליקציה לניהול תיקים משפטיים למשרד עורכי דין");
  assert.ok(legalHe.entities.some((e) => e.name === "Case"));
});

test("WorkOrder deliberately avoids Vehicle's own 'מוסך'/'מכונאי'/'garage'/'mechanic' keywords, so a garage idea doesn't ambiguously pick up an unrelated WorkOrder match from those words alone", async () => {
  const provider = new HeuristicSpecProvider();
  const garage = await provider.generate("An app for our garage to track vehicles our mechanics service.");
  assert.ok(garage.entities.some((e) => e.name === "Vehicle"));
  assert.ok(
    !garage.entities.some((e) => e.name === "WorkOrder"),
    "'garage'/'mechanic' alone must not spuriously match WorkOrder -- only its own distinct keywords should",
  );
});
