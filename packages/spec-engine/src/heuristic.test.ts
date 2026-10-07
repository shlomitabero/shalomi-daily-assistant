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

test("even a purely personal description with no role language gets an Admin role and a Dashboard screen, by design", async () => {
  // matchRoles always adds Admin -- every project has exactly one owner
  // account, and that owner is always an admin of their own app -- and
  // buildScreens always adds a Dashboard as a direct consequence. This is
  // intentional (not dead conditional logic that happens to always be
  // true), documented explicitly here so it isn't mistaken for an
  // oversight later.
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("I want to organize my hobby collection.");
  assert.deepEqual(spec.roles, ["Admin", "Member"]);
  assert.ok(spec.screens.some((s) => s.type === "dashboard"));
});

test("rejects an empty description", async () => {
  const provider = new HeuristicSpecProvider();
  await assert.rejects(() => provider.generate(""));
});

/**
 * New in this round: buildAssumptions used to tell every heuristic-
 * generated project's owner "multi-user authentication is not implemented
 * yet" / "אין עדיין שיתוף בין כמה משתמשים על אותו פרויקט" -- false since
 * real signup/login (apps/api/src/routes/auth.ts) and real per-project
 * collaborator invites (packages/db/src/collaborators.ts,
 * CollaboratorsPanel.tsx) both already exist. A Hebrew-speaking owner with
 * no Anthropic key reading their generated spec was told the app couldn't
 * do something it demonstrably already does, while a working
 * "Collaborators" button sat right there in the same UI. Confirms the
 * stale claim is gone and the real, narrower limitation (no granular
 * permission tier -- every collaborator gets full access, only the owner
 * can manage who's invited) is stated instead, in both languages.
 */
test("the generated assumptions no longer claim multi-user support doesn't exist, since real auth + collaborator sharing both already ship", async () => {
  const provider = new HeuristicSpecProvider();

  const enSpec = await provider.generate("I want to organize my hobby collection.");
  assert.ok(
    enSpec.assumptions.every((a) => !/multi-user authentication is not implemented/i.test(a)),
    "must not claim multi-user auth is unimplemented -- it is",
  );
  assert.ok(
    enSpec.assumptions.some((a) => /collaborator/i.test(a) && /owner/i.test(a)),
    "should instead describe the real collaborator-invite capability and its actual limitation",
  );

  const heSpec = await provider.generate("אני רוצה לנהל את אוסף התחביב שלי.");
  assert.ok(
    heSpec.assumptions.every((a) => !/שיתוף בין כמה משתמשים/.test(a)),
    "must not claim no multi-user sharing exists -- it does",
  );
  assert.ok(
    heSpec.assumptions.some((a) => /שותפים/.test(a) && /בעלים/.test(a)),
    "should instead describe the real collaborator-invite capability and its actual limitation",
  );
});

test("asks about payments when billing entities are implied", async () => {
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("A shop that tracks orders and sends invoices to customers.");
  const paymentQuestion = spec.openQuestions.find((q) => q.question.toLowerCase().includes("payment"));
  assert.ok(paymentQuestion);
  assert.ok(paymentQuestion!.options.includes("Stripe"));
});

test("asks about payments (recommending Stripe) for a donation-only description, even though it names none of PAYMENT_KEYWORDS", async () => {
  // "donation"/"donor"/"nonprofit"/"fundraising campaign" match the
  // Donation entity but share no substring with "payment"/"billing"/
  // "invoice"/"checkout"/"stripe"/"subscription" -- accepting donations is
  // plainly accepting payments, so recommending "No payments" here would be
  // actively wrong, not just an incomplete guess.
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate(
    "A donation tracking app for a small nonprofit, with donor records and fundraising campaigns.",
  );
  assert.deepEqual(spec.entities.map((e) => e.name), ["Donation"]);
  const paymentQuestion = spec.openQuestions.find((q) => q.question.toLowerCase().includes("payment"));
  assert.ok(paymentQuestion);
  assert.equal(paymentQuestion!.recommendation, "Stripe");
});

test("asks about payments for a membership/subscription description phrased without the word 'subscription' or 'billing'", async () => {
  // "member management" matches the Subscription entity but contains
  // neither "subscription" nor any other PAYMENT_KEYWORDS substring, so a
  // membership-fee business would otherwise get the same wrong "No
  // payments" recommendation as the donation case above.
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("A member management app for our gym, tracking each member and their plan.");
  assert.deepEqual(spec.entities.map((e) => e.name), ["Subscription"]);
  const paymentQuestion = spec.openQuestions.find((q) => q.question.toLowerCase().includes("payment"));
  assert.ok(paymentQuestion);
  assert.equal(paymentQuestion!.recommendation, "Stripe");
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

/**
 * Regression test for a real bug found by this round's Explore survey:
 * Order's own keyword list had a bare "order" string, matched via plain
 * substring (`lower.includes("order")`). "disorder(s)", "recorder(s)", and
 * "border(s)" all contain "order" as a substring too, so an app that has
 * nothing to do with e-commerce -- a clinic tracking sleep disorders, a
 * rental business tracking video recorders -- spuriously got a whole spare
 * "Order" entity/table (with customerName/total/status/items/courierId
 * fields) injected into its generated spec and, if unnoticed, its built
 * schema. This is the exact same collision class already fixed once for
 * "deal" (see domainEntities.ts's own comment on that entity), but unlike
 * "deal" -> "deals", no alternate spelling of "order" avoids the collision
 * here, since every colliding word itself ends in "order(s)" -- the fix
 * needed a `\b`-bounded RegExp keyword instead of a plain string.
 */
test("Order's keyword match does not spuriously trigger on unrelated words that merely contain 'order' as a substring", async () => {
  const provider = new HeuristicSpecProvider();

  const clinic = await provider.generate(
    "A clinic app for tracking patients with sleep disorders and their therapy sessions.",
  );
  assert.ok(!clinic.entities.some((e) => e.name === "Order"), "a sleep-disorder clinic app must not get a spurious Order entity");

  const rentals = await provider.generate("Track our video recorders and equipment rentals.");
  assert.ok(!rentals.entities.some((e) => e.name === "Order"), "a video-recorder rental app must not get a spurious Order entity");

  const border = await provider.generate("Manage border crossing logs for our trucking fleet.");
  assert.ok(!border.entities.some((e) => e.name === "Order"), "a border-crossing description must not get a spurious Order entity");

  // The fix must not lose real recall for legitimate order-related wording:
  // whole-word "order"/"orders", including inside a hyphenated phrase, must
  // still match.
  const singleOrder = await provider.generate("Place an order for pickup.");
  assert.ok(singleOrder.entities.some((e) => e.name === "Order"), "a plain 'order' description must still get an Order entity");

  const hyphenated = await provider.generate("An order-management app for tracking sales.");
  assert.ok(hyphenated.entities.some((e) => e.name === "Order"), "'order-management' must still match Order across the hyphen");
});

/**
 * Regression test for the same bug class round 279 fixed for Order's
 * "order" keyword, found by this round's Explore survey re-checking the
 * REST of domainEntities.ts's keyword lists via real execution (not just
 * inspection): Courier's bare "driver" keyword is a substring of
 * "screwdriver(s)" (a hardware-store description) and "webdriver" (a
 * QA/testing-tool description), and Product's bare "stock" keyword is a
 * substring of "livestock" (a farm-management description). Confirmed by
 * direct execution before the fix: a hardware-store description returned
 * ["Courier"], a webdriver-testing description also returned ["Courier"],
 * and a livestock-farm description returned ["Product"] -- none of those
 * apps have anything to do with delivery couriers or retail inventory.
 * Both fixed with the same `\b`-bounded RegExp keyword pattern (see
 * Order's own fix/comment above) rather than a plain string.
 */
test("Courier's 'driver' and Product's 'stock' keywords don't spuriously trigger on 'screwdriver(s)'/'webdriver'/'livestock'", async () => {
  const provider = new HeuristicSpecProvider();

  const hardwareStore = await provider.generate(
    "We run a hardware store selling screwdrivers, hammers, and drills to contractors.",
  );
  assert.ok(!hardwareStore.entities.some((e) => e.name === "Courier"), "a hardware store selling screwdrivers must not get a spurious Courier entity");

  const webdriverApp = await provider.generate("An app to manage our webdriver test suite for QA engineers.");
  assert.ok(!webdriverApp.entities.some((e) => e.name === "Courier"), "a webdriver test-suite app must not get a spurious Courier entity");

  const farm = await provider.generate("A farm management app for tracking livestock and pasture rotation.");
  assert.ok(!farm.entities.some((e) => e.name === "Product"), "a livestock farm app must not get a spurious Product entity");

  // The fix must not lose real recall: whole-word "driver"/"drivers" and
  // "stock"/"stocks" must still match.
  const drivers = await provider.generate("Manage our fleet of delivery drivers.");
  assert.ok(drivers.entities.some((e) => e.name === "Courier"), "a plain 'drivers' description must still get a Courier entity");

  const stock = await provider.generate("Track warehouse stock levels for our shop.");
  assert.ok(stock.entities.some((e) => e.name === "Product"), "a plain 'stock' description must still get a Product entity");
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
  // the obvious phrase. Historically this was because "pipeline" was Deal's
  // own keyword too (removed in round 371, see domainEntities.ts's own
  // pitfall 1b comment), but the test below still exercises the plain
  // "hiring process" phrasing on its own terms, regardless of Deal's
  // current keyword list.
  const recruiting = await provider.generate("Track candidates through our hiring process for open roles.");
  assert.ok(recruiting.entities.some((e) => e.name === "JobApplicant"));
  assert.ok(!recruiting.entities.some((e) => e.name === "Deal"), "'hiring process' must not spuriously match Deal");

  // Same reasoning in Hebrew: "גיוס" alone, not "גיוס עובדים" -- the obvious
  // phrase -- because "עובדים" is Employee's own keyword. A recruitment
  // description in Hebrew would otherwise spuriously also match Employee.
  const recruitingHe = await provider.generate("אפליקציה לניהול מועמדים בתהליך הגיוס שלנו");
  assert.ok(recruitingHe.entities.some((e) => e.name === "JobApplicant"));
  assert.ok(!recruitingHe.entities.some((e) => e.name === "Employee"), "'גיוס' must not spuriously match Employee via an 'עובדים' substring that was deliberately left out");
});

/**
 * Regression test for a real bug found in round 371: Deal's own keyword
 * list used to include bare "pipeline", which is also the single most
 * idiomatic HR/ATS phrase for a recruitment funnel ("hiring pipeline") --
 * so any recruiting-app description using that ordinary phrase spuriously
 * got a sales Deal entity (title/value/stage/owner) injected alongside the
 * real JobApplicant entity. Confirmed via domainEntities.ts's own
 * doc-comment calling this out by name as a known pitfall (pitfall 1b) that
 * was never actually fixed on Deal's own side -- only worked around on
 * JobApplicant's side (see the test above). Fixed by dropping "pipeline"
 * from Deal's keyword list entirely, since "deals"/"negotiation" already
 * cover the ordinary English phrasing for a sales Deal on their own.
 */
test("Deal's keyword list no longer spuriously matches the idiomatic recruiting phrase 'hiring pipeline'", async () => {
  const provider = new HeuristicSpecProvider();
  const recruiting = await provider.generate("Track candidates through our hiring pipeline for open roles.");
  assert.ok(recruiting.entities.some((e) => e.name === "JobApplicant"));
  assert.ok(!recruiting.entities.some((e) => e.name === "Deal"), "'hiring pipeline' must not spuriously match Deal");

  // The real sales-pipeline phrasing for Deal must still work -- this isn't
  // a case of Deal becoming unreachable, just no longer reachable via the
  // single word "pipeline" on its own.
  const sales = await provider.generate("An app to track sales deals through our pipeline.");
  assert.ok(sales.entities.some((e) => e.name === "Deal"));
});

/**
 * Regression test for a real bug found in round 373: Appointment's own
 * "schedule" keyword is the same idiom-co-occurrence shape as Deal's
 * removed "pipeline" keyword (round 371), not a substring collision --
 * "payment schedule"/"project schedule"/"work schedule" are all ordinary
 * business-management phrases with nothing to do with booking a customer
 * appointment, and every one of them was spuriously matching this entity.
 */
test("Appointment's keyword list no longer spuriously matches 'payment schedule'/'work schedule'", async () => {
  const provider = new HeuristicSpecProvider();

  const invoicing = await provider.generate(
    "An invoicing app that tracks invoices and a payment schedule for each client project.",
  );
  assert.ok(
    !invoicing.entities.some((e) => e.name === "Appointment"),
    "'payment schedule' must not spuriously match Appointment",
  );

  const workforce = await provider.generate("A tool to manage our weekly work schedule for employees.");
  assert.ok(
    !workforce.entities.some((e) => e.name === "Appointment"),
    "'work schedule' must not spuriously match Appointment",
  );

  // The real appointment-booking phrasing must still work -- this isn't a
  // case of Appointment becoming unreachable, just no longer reachable via
  // the single word "schedule" on its own.
  const booking = await provider.generate("An app to book appointments with customers for haircuts.");
  assert.ok(booking.entities.some((e) => e.name === "Appointment"));
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

test("Customer's 'lead' keyword doesn't spuriously match plain 'leaders'/'leadership' text", async () => {
  const provider = new HeuristicSpecProvider();
  const leadership = await provider.generate("An app for managing team leaders and their schedules.");
  assert.ok(
    !leadership.entities.some((e) => e.name === "Customer"),
    "'leaders' alone must not spuriously match Customer via a bare 'lead' substring",
  );

  // The real business term still works.
  const salesLead = await provider.generate("An app to capture and follow up on new sales leads.");
  assert.ok(salesLead.entities.some((e) => e.name === "Customer"));
});

test("Deal's 'deal' keyword doesn't spuriously match 'ideal' or Vehicle's 'dealership' keyword", async () => {
  const provider = new HeuristicSpecProvider();

  const ideal = await provider.generate("An app to manage our ideal customers and their orders.");
  assert.ok(
    !ideal.entities.some((e) => e.name === "Deal"),
    "'ideal' alone must not spuriously match Deal via a bare 'deal' substring",
  );

  const dealership = await provider.generate("A CRM for a car dealership to manage vehicles.");
  assert.ok(dealership.entities.some((e) => e.name === "Vehicle"));
  assert.ok(
    !dealership.entities.some((e) => e.name === "Deal"),
    "'dealership' alone must not spuriously match Deal via a bare 'deal' substring",
  );

  // The real business term still works.
  const realDeal = await provider.generate("An app to track sales deals through our pipeline.");
  assert.ok(realDeal.entities.some((e) => e.name === "Deal"));
});

/**
 * Regression test for a real bug found in round 372: the test above already
 * covers the singular "deal" ⊂ "ideal" collision, but the plural "deals"
 * keyword had the exact same problem one letter over -- it's a substring of
 * "ideals" ("company values and ideals"), so a plain non-sales description
 * mentioning a business's ideals spuriously got a Deal/CRM entity injected.
 * Fixed with the same `\b`-bounded RegExp pattern Order's "order"/Product's
 * "stock" already use (confirmed, unlike Deal's removed "pipeline" keyword
 * in round 371, that this really is a substring-within-a-word collision a
 * word boundary can fix, not an idiom co-occurrence one).
 */
test("Deal's 'deals' keyword doesn't spuriously match 'ideals'", async () => {
  const provider = new HeuristicSpecProvider();

  const ideals = await provider.generate(
    "An app to track our company's core values and ideals, plus a list of our team members.",
  );
  assert.ok(
    !ideals.entities.some((e) => e.name === "Deal"),
    "'ideals' alone must not spuriously match Deal via a bare 'deals' substring",
  );

  // The real business term still works.
  const realDeal = await provider.generate("An app to track our deals and negotiations with clients.");
  assert.ok(realDeal.entities.some((e) => e.name === "Deal"));
});

/**
 * Regression test for a real bug found in round 372: Patient's bare
 * "patient" keyword is a substring of "impatient" -- an ordinary word in a
 * plain customer-support description ("handle impatient customers
 * politely") that has nothing to do with medical care, so it spuriously
 * matched this entity. Fixed with the same `\b`-bounded RegExp pattern
 * Order's "order"/Product's "stock" already use. Also confirms the fix
 * didn't introduce its own regression: "outpatient" (a real healthcare
 * term with no word boundary between "out" and "patient") still matches,
 * because it's now listed as its own explicit keyword alongside the regex.
 */
test("Patient's 'patient' keyword doesn't spuriously match 'impatient', and 'outpatient' still matches", async () => {
  const provider = new HeuristicSpecProvider();

  const impatient = await provider.generate(
    "A ticketing app for our support team to track tickets from impatient customers who want fast replies.",
  );
  assert.ok(
    !impatient.entities.some((e) => e.name === "Patient"),
    "'impatient' alone must not spuriously match Patient via a bare 'patient' substring",
  );

  // The real medical term still works, including the one real word that
  // has no boundary before "patient" and needs its own explicit keyword.
  const realPatient = await provider.generate("A clinic app to track patient visits and medical history.");
  assert.ok(realPatient.entities.some((e) => e.name === "Patient"));

  const outpatient = await provider.generate("A clinic app to manage outpatient appointments and follow-ups.");
  assert.ok(outpatient.entities.some((e) => e.name === "Patient"), "'outpatient' must still match Patient");
});

/**
 * Regression test for a real bug found in round 446: Employee's bare
 * "worker" keyword (used both in DOMAIN_ENTITY_RULES and ROLE_RULES) is a
 * substring of "coworker" -- an ordinary word in a plain personal
 * expense-splitting description that has nothing to do with staff
 * management, so it spuriously fabricated both an Employee entity AND an
 * Employee role. Fixed with the same `\b`-bounded RegExp pattern Order's
 * "order"/Product's "stock"/Deal's "deals"/Patient's "patient" already
 * use. ROLE_RULES.keywords was widened from `string[]` to
 * `(string | RegExp)[]` and matchRoles switched from a raw
 * `lower.includes(kw)` to the shared matchesKeyword helper (which already
 * supported RegExp) to make the role side of the fix possible at all.
 */
test("Employee's 'worker' keyword doesn't spuriously match 'coworker', for both the entity and the role", async () => {
  const provider = new HeuristicSpecProvider();

  const coworker = await provider.generate("An app to split shared expenses with my coworker, like rent and groceries.");
  assert.ok(
    !coworker.entities.some((e) => e.name === "Employee"),
    "'coworker' alone must not spuriously match Employee via a bare 'worker' substring",
  );
  assert.ok(
    !coworker.roles.includes("Employee"),
    "'coworker' alone must not spuriously add an Employee role via a bare 'worker' substring",
  );

  // The real HR/staff term still works, for both the entity and the role.
  const staffApp = await provider.generate("An app to manage our staff schedule: track every worker's shifts and hours.");
  assert.ok(staffApp.entities.some((e) => e.name === "Employee"), "'worker' must still match Employee");
  assert.ok(staffApp.roles.includes("Employee"), "'worker' must still add the Employee role");
});

/**
 * Regression test for a real bug found in round 447: Course's bare
 * "courses" keyword is a substring of "discourses" -- an ordinary word in
 * a plain discussion/forum description that has nothing to do with
 * education, so it spuriously matched this entity. Fixed with the same
 * `\b`-bounded RegExp pattern order/stock/driver/patient/deals/worker
 * already use.
 */
test("Course's 'courses' keyword doesn't spuriously match 'discourses'", async () => {
  const provider = new HeuristicSpecProvider();

  const discourses = await provider.generate(
    "A community platform for hosting public discourses and debates about philosophy.",
  );
  assert.ok(
    !discourses.entities.some((e) => e.name === "Course"),
    "'discourses' alone must not spuriously match Course via a bare 'courses' substring",
  );

  // The real education term still works.
  const realCourse = await provider.generate("An app to manage our online courses and curriculum for students.");
  assert.ok(realCourse.entities.some((e) => e.name === "Course"), "'courses' must still match Course");
});

/**
 * Regression test for a real bug found in round 448: MenuItem's bare
 * "dish" keyword is a substring of "dishonest" -- an ordinary word in a
 * consumer-protection/trust description that has nothing to do with
 * restaurants, so it spuriously matched this entity. Fixed with the same
 * `\b`-bounded RegExp pattern order/stock/driver/patient/deals/worker/
 * courses already use.
 */
test("MenuItem's 'dish' keyword doesn't spuriously match 'dishonest'", async () => {
  const provider = new HeuristicSpecProvider();

  const dishonest = await provider.generate(
    "An app for a consumer watchdog group to track dishonest sellers and scam reports.",
  );
  assert.ok(
    !dishonest.entities.some((e) => e.name === "MenuItem"),
    "'dishonest' alone must not spuriously match MenuItem via a bare 'dish' substring",
  );

  // The real restaurant term still works, singular and plural.
  const realDish = await provider.generate("An app for a restaurant to manage its menu and daily dish specials.");
  assert.ok(realDish.entities.some((e) => e.name === "MenuItem"), "'dish' must still match MenuItem");

  const realDishes = await provider.generate("An app for a cafe to track which dishes are available each day.");
  assert.ok(realDishes.entities.some((e) => e.name === "MenuItem"), "'dishes' must still match MenuItem");
});

/**
 * Regression test for a real bug found in round 448's survey and fixed in
 * round 449: Product's bare "product" keyword is a substring of
 * "production" -- an ordinary word in a creative/media description that has
 * nothing to do with selling or tracking products, so it spuriously matched
 * this entity. Fixed with the same `\b`-bounded RegExp pattern this file's
 * other collision fixes already use.
 */
test("Product's 'product' keyword doesn't spuriously match 'production'", async () => {
  const provider = new HeuristicSpecProvider();

  const production = await provider.generate("An app for a video production studio to manage clients and bookings.");
  assert.ok(
    !production.entities.some((e) => e.name === "Product"),
    "'production' alone must not spuriously match Product via a bare 'product' substring",
  );

  // The real retail term still works, singular and plural.
  const realProduct = await provider.generate("An app for a shop to track product price and quantity in inventory.");
  assert.ok(realProduct.entities.some((e) => e.name === "Product"), "'product' must still match Product");

  const realProducts = await provider.generate("An app for a store to manage its products and stock levels.");
  assert.ok(realProducts.entities.some((e) => e.name === "Product"), "'products' must still match Product");
});

/**
 * Regression test for a real bug found in round 448's survey and fixed in
 * round 450: Vehicle's bare "mechanic" keyword is a substring of
 * "mechanical" -- an ordinary word in a facilities-management description
 * that has nothing to do with vehicles, so it spuriously matched this
 * entity. Fixed with the same `\b`-bounded RegExp pattern this file's other
 * collision fixes already use.
 */
test("Vehicle's 'mechanic' keyword doesn't spuriously match 'mechanical'", async () => {
  const provider = new HeuristicSpecProvider();

  const mechanical = await provider.generate(
    "An app to track mechanical issues in a building for a facilities management team.",
  );
  assert.ok(
    !mechanical.entities.some((e) => e.name === "Vehicle"),
    "'mechanical' alone must not spuriously match Vehicle via a bare 'mechanic' substring",
  );

  // The real auto-repair term still works on its own, singular and plural
  // (neither description below mentions any of this rule's other
  // keywords, so a match here can only come from "mechanic" itself).
  const realMechanic = await provider.generate("An app for an auto repair business to schedule its mechanic for each job.");
  assert.ok(realMechanic.entities.some((e) => e.name === "Vehicle"), "'mechanic' must still match Vehicle");

  const realMechanics = await provider.generate("An app for an auto repair business to assign jobs to its mechanics.");
  assert.ok(realMechanics.entities.some((e) => e.name === "Vehicle"), "'mechanics' must still match Vehicle");
});

/**
 * Regression test for a real bug found in round 448's survey and fixed in
 * round 452: Service's bare "treatment" keyword is a substring of
 * "mistreatment" -- an ordinary word in an elder-care/social-work
 * complaint description that has nothing to do with selling a service, so
 * it spuriously matched this entity. Fixed with the same `\b`-bounded
 * RegExp pattern this file's other collision fixes already use.
 */
test("Service's 'treatment' keyword doesn't spuriously match 'mistreatment'", async () => {
  const provider = new HeuristicSpecProvider();

  const mistreatment = await provider.generate(
    "An app for a social worker to report mistreatment of elderly residents in care facilities.",
  );
  assert.ok(
    !mistreatment.entities.some((e) => e.name === "Service"),
    "'mistreatment' alone must not spuriously match Service via a bare 'treatment' substring",
  );

  // The real clinical term still works on its own, singular and plural
  // (neither description below mentions this rule's other keyword
  // "service", so a match here can only come from "treatment" itself).
  const realTreatment = await provider.generate("An app for a physical therapy clinic to schedule each patient's treatment.");
  assert.ok(realTreatment.entities.some((e) => e.name === "Service"), "'treatment' must still match Service");

  const realTreatments = await provider.generate("An app for a clinic to track the treatments it offers to patients.");
  assert.ok(realTreatments.entities.some((e) => e.name === "Service"), "'treatments' must still match Service");
});

/**
 * Regression test for a real bug found in round 448's survey and fixed in
 * round 453: Service's bare "service" keyword is a substring of
 * "disservice" -- an ordinary word (e.g. "do a disservice to their
 * reputation") that has nothing to do with selling a service, so it
 * spuriously matched this entity. Fixed with the same `\b`-bounded RegExp
 * pattern this file's other collision fixes already use.
 */
test("Service's 'service' keyword doesn't spuriously match 'disservice'", async () => {
  const provider = new HeuristicSpecProvider();

  const disservice = await provider.generate(
    "An app for a reputation management consultant to track clients who worry that bad reviews will do a disservice to their reputation.",
  );
  assert.ok(
    !disservice.entities.some((e) => e.name === "Service"),
    "'disservice' alone must not spuriously match Service via a bare 'service' substring",
  );

  // The real word still works on its own, singular and plural (neither
  // description below mentions this rule's other keyword "treatment", so a
  // match here can only come from "service" itself).
  const realService = await provider.generate("An app for a hair salon to manage the service it charges clients for.");
  assert.ok(realService.entities.some((e) => e.name === "Service"), "'service' must still match Service");

  const realServices = await provider.generate("An app for a hair salon to manage the services it offers to clients.");
  assert.ok(realServices.entities.some((e) => e.name === "Service"), "'services' must still match Service");
});

/**
 * Regression test for a real bug noticed in round 450 and fixed in round
 * 454: Vehicle's bare "garage" keyword is a whole word that's genuinely
 * ambiguous -- it means an auto-repair shop in most descriptions, but
 * "garage sale" is an unrelated everyday phrase (a household selling
 * unwanted items) with nothing to do with vehicles. Unlike the
 * substring-in-a-longer-word collisions fixed in earlier rounds, a plain
 * `\b`-bounded RegExp can't fix this since "garage" word-boundary-matches
 * correctly inside "garage sale" too -- fixed with a negative lookahead
 * that excludes only that specific phrase.
 */
test("Vehicle's 'garage' keyword doesn't spuriously match 'garage sale'", async () => {
  const provider = new HeuristicSpecProvider();

  const garageSale = await provider.generate(
    "An app for a neighborhood community to coordinate an annual garage sale, listing items each household wants to sell.",
  );
  assert.ok(
    !garageSale.entities.some((e) => e.name === "Vehicle"),
    "'garage sale' alone must not spuriously match Vehicle via the bare 'garage' word",
  );

  const garageSales = await provider.generate(
    "An app for a neighborhood community to coordinate annual garage sales, listing items each household wants to sell.",
  );
  assert.ok(
    !garageSales.entities.some((e) => e.name === "Vehicle"),
    "'garage sales' alone must not spuriously match Vehicle via the bare 'garage' word",
  );

  // The real auto-repair sense still works (this description avoids this
  // rule's other keywords -- "vehicle", "mechanic", "fleet management",
  // "car dealership" -- so a match here can only come from "garage"
  // itself).
  const realGarage = await provider.generate("An app for an auto repair garage to track customer jobs and parts inventory.");
  assert.ok(realGarage.entities.some((e) => e.name === "Vehicle"), "'garage' must still match Vehicle");
});

/**
 * Regression test for a real bug found in a fresh systematic survey in
 * round 455: Shipment's bare "shipping" keyword is a substring of
 * "worshipping" -- an ordinary word in a church/congregation attendance
 * description that has nothing to do with logistics, so it spuriously
 * matched this entity. Fixed with the same `\b`-bounded RegExp pattern
 * this file's other collision fixes already use.
 */
test("Shipment's 'shipping' keyword doesn't spuriously match 'worshipping'", async () => {
  const provider = new HeuristicSpecProvider();

  const worshipping = await provider.generate(
    "An app for a church to track members worshipping together every Sunday and record weekly attendance.",
  );
  assert.ok(
    !worshipping.entities.some((e) => e.name === "Shipment"),
    "'worshipping' alone must not spuriously match Shipment via a bare 'shipping' substring",
  );

  // The real logistics term still works on its own (this description
  // avoids this rule's other keywords -- "logistics", "warehouse
  // management", "package tracking", "freight" -- so a match here can
  // only come from "shipping" itself).
  const realShipping = await provider.generate("An app for an online retailer to track shipping of customer orders to their destinations.");
  assert.ok(realShipping.entities.some((e) => e.name === "Shipment"), "'shipping' must still match Shipment");
});

/**
 * Regression test for a real bug surfaced (but left unverified) by round
 * 455's systematic survey and verified+fixed in round 456: Project's bare
 * "project" keyword is a substring of "projector" -- an ordinary word in
 * an AV-equipment rental description that has nothing to do with managing
 * client work, so it spuriously matched this entity. Fixed with the same
 * `\b`-bounded RegExp pattern this file's other collision fixes already
 * use.
 */
test("Project's 'project' keyword doesn't spuriously match 'projector'", async () => {
  const provider = new HeuristicSpecProvider();

  const projectors = await provider.generate(
    "An app for a rental company to track projectors and sound equipment rented out for weddings and conferences.",
  );
  assert.ok(
    !projectors.entities.some((e) => e.name === "Project"),
    "'projectors' alone must not spuriously match Project via a bare 'project' substring",
  );

  // The real word still works on its own, singular and plural (this
  // rule's only other English keyword is "project" itself, so there is no
  // sibling keyword to avoid here).
  const realProject = await provider.generate("An app for a design agency to track every client project and its deadline.");
  assert.ok(realProject.entities.some((e) => e.name === "Project"), "'project' must still match Project");

  const realProjects = await provider.generate("An app for a design agency to track all its client projects and their deadlines.");
  assert.ok(realProjects.entities.some((e) => e.name === "Project"), "'projects' must still match Project");
});

test("MenuItem's 'מנה' keyword doesn't spuriously match 'מנהלים' (managers)", async () => {
  const provider = new HeuristicSpecProvider();
  const managers = await provider.generate("אפליקציה למעקב אחרי מנהלים בעסק");
  assert.ok(
    !managers.entities.some((e) => e.name === "MenuItem"),
    "'מנהלים' alone must not spuriously match MenuItem via a bare 'מנה' substring",
  );

  // The real business term still works.
  const restaurant = await provider.generate("אפליקציה לניהול תפריט ומנות למסעדה");
  assert.ok(restaurant.entities.some((e) => e.name === "MenuItem"));
});
