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

/**
 * Round 768: the sentence the test above locked in ("no granular
 * permission tier yet -- every collaborator gets full data access") went
 * stale the moment real two-tier RBAC shipped (packages/db/src/
 * collaborators.ts's role column, apps/api/src/routes/projects.ts's
 * requireProjectWriteAccess 403 for a viewer, CollaboratorsPanel.tsx's
 * role selector) -- an earlier fix for this exact function's exact kind of
 * staleness (the test just above it), now stale itself in the same way.
 * Confirms the claim that every collaborator gets full access is gone, and
 * the real viewer/read-only distinction is described instead, in both
 * languages.
 */
test("the generated assumptions no longer claim every collaborator gets full access, since real viewer/editor roles already ship", async () => {
  const provider = new HeuristicSpecProvider();

  const enSpec = await provider.generate("I want to organize my hobby collection.");
  assert.ok(
    enSpec.assumptions.every((a) => !/no granular permission tier|every collaborator gets full/i.test(a)),
    "must not claim there's no permission tier or every collaborator gets full access -- viewer/editor roles exist",
  );
  assert.ok(
    enSpec.assumptions.some((a) => /viewer/i.test(a) && /editor/i.test(a)),
    "should instead describe the real editor/viewer role distinction",
  );

  const heSpec = await provider.generate("אני רוצה לנהל את אוסף התחביב שלי.");
  assert.ok(
    heSpec.assumptions.every((a) => !/גישה מלאה לנתונים/.test(a)),
    "must not claim every collaborator gets full data access -- viewer/editor roles exist",
  );
  assert.ok(
    heSpec.assumptions.some((a) => /צפייה בלבד/.test(a) && /עורך/.test(a)),
    "should instead describe the real editor/viewer role distinction",
  );
});

/**
 * Round 769: the third sentence of this same function lumped "messaging"
 * in with "payments" as an integration that's "not wired up yet" --
 * false for messaging since a real WhatsApp Web connection
 * (apps/api/src/whatsappWeb.ts's baileys-based QR linking, real
 * inbound/outbound messages, apps/api/src/automations.ts's
 * send_whatsapp action) is available for every project, surfaced by an
 * unconditional "WhatsApp" button in the preview header (App.tsx) with no
 * gating on the project's own description or entities. Payments remain
 * genuinely unwired (no Stripe/PayPal/checkout code exists anywhere
 * outside this package's own open-question keyword matching), so the
 * fix narrows the claim to payments and describes the real WhatsApp
 * capability instead of denying it -- the same move round 768 made for
 * the RBAC sentence right above this one.
 */
test("the generated assumptions no longer claim messaging integrations aren't wired up, since a real WhatsApp connection already ships for every project", async () => {
  const provider = new HeuristicSpecProvider();

  const enSpec = await provider.generate("I want to organize my hobby collection.");
  assert.ok(
    enSpec.assumptions.every((a) => !/messaging, etc\.\) are not wired up/i.test(a)),
    "must not claim messaging integrations aren't wired up -- a real WhatsApp connection exists",
  );
  assert.ok(
    enSpec.assumptions.some((a) => /WhatsApp/i.test(a)),
    "should instead describe the real WhatsApp capability",
  );
  assert.ok(
    enSpec.assumptions.some((a) => /payments/i.test(a) && /not wired up/i.test(a)),
    "payments remain genuinely unwired and should still be named as such",
  );

  const heSpec = await provider.generate("אני רוצה לנהל את אוסף התחביב שלי.");
  assert.ok(
    heSpec.assumptions.every((a) => !/הודעות וכו'\) עדיין לא מחוברת/.test(a)),
    "must not claim messaging integrations aren't wired up -- a real WhatsApp connection exists",
  );
  assert.ok(
    heSpec.assumptions.some((a) => /וואטסאפ/.test(a)),
    "should instead describe the real WhatsApp capability",
  );
  assert.ok(
    heSpec.assumptions.some((a) => /תשלומים/.test(a) && /לא מחוברת/.test(a)),
    "payments remain genuinely unwired and should still be named as such",
  );
});

/**
 * Round 708: isHebrewText only checks whether ANY Hebrew character appears
 * anywhere in its input, not which language dominates -- so without this
 * override, a single Hebrew word mixed into an otherwise-English
 * description (exactly what /refine and /answers do when they concatenate
 * a project's own established description with new, unrelated text) flips
 * the WHOLE spec's labels to Hebrew. Confirms isHebrewOverride lets a
 * caller that already knows the real, established language pin it
 * explicitly, regardless of what isHebrewText would have concluded from
 * the raw text alone.
 */
test("isHebrewOverride pins the generated labels' language, regardless of what isHebrewText would conclude from the raw text", async () => {
  const provider = new HeuristicSpecProvider();

  // Mostly-English text containing one stray Hebrew word (a name) --
  // isHebrewText alone would call this Hebrew; the override says no.
  const pinnedEnglish = await provider.generate("A CRM to track customers for my shop, run by דנה.", false);
  assert.equal(pinnedEnglish.entities[0].label, undefined, "an English-pinned spec must not carry a Hebrew label");

  // Mostly-Hebrew text with no Hebrew characters at all in THIS particular
  // call's own text (e.g. an all-ASCII clarifying answer) -- isHebrewText
  // alone would call this English; the override says Hebrew.
  const pinnedHebrew = await provider.generate("A CRM to track customers for my shop.", true);
  assert.equal(pinnedHebrew.entities[0].label, "לקוחות", "a Hebrew-pinned spec must carry the real Hebrew label even though this text has no Hebrew characters at all");

  // Omitting the override entirely must keep the pre-existing behavior:
  // decide purely from the text itself.
  const unpinned = await provider.generate("A CRM to track customers for my shop.");
  assert.equal(unpinned.entities[0].label, undefined, "omitting the override must still infer English from all-English text, exactly as before this round");
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

test("asks about payments (recommending Stripe) for a rental-business description, even though it names none of PAYMENT_KEYWORDS", async () => {
  // "tool rental"/"rental business" match the Rental entity but share no
  // substring with "payment"/"billing"/"invoice"/"checkout"/"stripe"/
  // "subscription" -- renting items out for a fee is plainly a paid
  // transaction, so recommending "No payments" here would be actively
  // wrong, not just an incomplete guess. Regression test for round 566's
  // finding that Rental (added after BILLING_ENTITY_NAMES was introduced)
  // was never added to that set.
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("A tool rental business for a hardware store.");
  assert.deepEqual(spec.entities.map((e) => e.name), ["Rental"]);
  const paymentQuestion = spec.openQuestions.find((q) => q.question.toLowerCase().includes("payment"));
  assert.ok(paymentQuestion);
  assert.equal(paymentQuestion!.recommendation, "Stripe");
});

test("asks about payments (recommending Stripe) for a real-estate description, even though it names none of PAYMENT_KEYWORDS", async () => {
  // "track properties"/"apartment listings" match only the Property entity
  // and share no substring with "payment"/"billing"/"invoice"/"checkout"/
  // "stripe"/"subscription" -- selling or renting out real estate is
  // plainly a paid transaction, so recommending "No payments" here would be
  // actively wrong, not just an incomplete guess. Regression test for round
  // 622's finding that Property (like Rental before it, round 566) was
  // never added to BILLING_ENTITY_NAMES.
  const provider = new HeuristicSpecProvider();
  const spec = await provider.generate("A real estate agency to track properties for sale and apartment listings.");
  assert.deepEqual(spec.entities.map((e) => e.name), ["Property"]);
  const paymentQuestion = spec.openQuestions.find((q) => q.question.toLowerCase().includes("payment"));
  assert.ok(paymentQuestion);
  assert.equal(paymentQuestion!.recommendation, "Stripe");
});

test("does not ask about payments for a clothing-store description mentioning 'striped' shirts, but still asks when 'stripe' itself is used", async () => {
  // Regression test for a real bug found by a round 460 Explore survey:
  // PAYMENT_KEYWORDS's bare "stripe" hint matched via plain .includes(),
  // so it was also a substring of "striped"/"pinstripe" -- an ordinary
  // clothing-store or tailoring description that never mentions payments
  // at all would still get "Which payment provider should this use?"
  // (recommending Stripe), purely because of the fabric-pattern word.
  // Fixed with a \b-bounded regex, reusing the matchesKeyword helper this
  // file already uses for DOMAIN_ENTITY_RULES/ROLE_RULES.
  const provider = new HeuristicSpecProvider();

  const stripedSpec = await provider.generate(
    "An inventory tracker for a clothing store selling striped shirts, scarves, and seasonal collections.",
  );
  assert.deepEqual(stripedSpec.entities.map((e) => e.name), ["Product"]);
  const stripedQuestion = stripedSpec.openQuestions[0];
  assert.equal(stripedQuestion.question, "Does this application need to accept payments?");
  assert.equal(stripedQuestion.recommendation, "No payments");

  const pinstripeSpec = await provider.generate(
    "A catalog app for a boutique tailor to track pinstripe suits, fabric swatches, and client measurements.",
  );
  const pinstripeQuestion = pinstripeSpec.openQuestions[0];
  assert.equal(pinstripeQuestion.question, "Does this application need to accept payments?");
  assert.equal(pinstripeQuestion.recommendation, "No payments");

  const realStripeSpec = await provider.generate(
    "A small business app that integrates with stripe to process customer payments.",
  );
  const realStripeQuestion = realStripeSpec.openQuestions[0];
  assert.equal(realStripeQuestion.question, "Which payment provider should this use?");
  assert.equal(realStripeQuestion.recommendation, "Stripe");
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
 * Regression test for round 812's finding: round 454's own fix above
 * \b-bounded "garage" and excluded "garage sale(s)", but never added
 * plural support for "garage" itself -- unlike every sibling keyword in
 * this same list (the very next one, "mechanic(s)?", plus driver(s)?/
 * worker(s)?/service(s)?/product(s)? elsewhere in this file), all of
 * which explicitly handle their natural plural next to the \b bound.
 * `\b` can't match inside "garages" at all (no boundary between "garage"
 * and the trailing "s"), so a description naming only the plural fell
 * through to the generic DEFAULT_ENTITY instead of Vehicle -- the exact
 * same gap round 577 (above) already found and fixed for this same
 * keyword's own Hebrew plural "מוסכים", just never checked against its
 * English sibling "garages" in the same rule.
 */
test("Vehicle's 'garage' keyword also matches its plural 'garages', which the round-454 \\b-bound alone can't reach", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralOnly = await provider.generate("A platform for a group of garages to coordinate repairs.");
  assert.ok(pluralOnly.entities.some((e) => e.name === "Vehicle"), "'garages' (plural) alone must match Vehicle");

  // The plural exclusion of "garage sale(s)" must still hold too.
  const garageSalesStillExcluded = await provider.generate(
    "An app to list items for our weekend garage sales in the neighborhood.",
  );
  assert.ok(
    !garageSalesStillExcluded.entities.some((e) => e.name === "Vehicle"),
    "'garage sales' alone must still not spuriously match Vehicle via the plural 'garages'",
  );
});

/**
 * Regression test for a real bug found in round 567: Vehicle's bare "רכב"
 * ("car"/"vehicle") keyword is a literal prefix-substring of the ordinary,
 * extremely common Hebrew word "רכבת" ("train") and its plural "רכבות"
 * ("trains") -- Israel Railways is "רכבת ישראל" -- so a train/station
 * description spuriously matched Vehicle even though it has nothing to do
 * with cars. Same unbounded-Hebrew-substring shape as every other fix in
 * this file (round 518 "מלאי", round 563 "מנוי", round 564 "מוצר", round
 * 565 "עובד"), fixed with the same negative-lookahead style.
 */
test("Vehicle's 'רכב' keyword doesn't spuriously match 'רכבת'/'רכבות' (train/trains)", async () => {
  const provider = new HeuristicSpecProvider();

  const trainStation = await provider.generate(
    "אפליקציה לניהול תחנות רכבת, לוחות זמנים ומעקב אחרי כרטיסי נוסעים.",
  );
  assert.ok(
    !trainStation.entities.some((e) => e.name === "Vehicle"),
    "'רכבת' (train) alone must not spuriously match Vehicle via a bare 'רכב' substring",
  );

  const trains = await provider.generate(
    "מערכת לניהול רכבות, תחנות, ומכירת כרטיסים לנוסעים.",
  );
  assert.ok(
    !trains.entities.some((e) => e.name === "Vehicle"),
    "'רכבות' (trains) alone must not spuriously match Vehicle via a bare 'רכב' substring",
  );

  // The real word still works, singular and plural (these descriptions
  // avoid this rule's other keywords -- "מוסך", "מכונאי", "כלי רכב" --
  // so a match here can only come from "רכב"/"רכבים" itself).
  const realVehicle = await provider.generate("אפליקציה למעקב אחרי רכב אחד של העסק.");
  assert.ok(realVehicle.entities.some((e) => e.name === "Vehicle"), "'רכב' must still match Vehicle");

  const realVehicles = await provider.generate("ניהול צי רכבים להשכרה.");
  assert.ok(realVehicles.entities.some((e) => e.name === "Vehicle"), "'רכבים' must still match Vehicle");
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

/**
 * Regression test for a real bug surfaced (but left unverified) by round
 * 455's systematic survey and verified+fixed in round 457: Property's
 * bare "listing" keyword is a substring of "enlisting" -- an ordinary
 * word in a nonprofit/volunteer-outreach description that has nothing to
 * do with real estate, so it spuriously matched this entity. Fixed with
 * the same `\b`-bounded RegExp pattern this file's other collision fixes
 * already use.
 */
test("Property's 'listing' keyword doesn't spuriously match 'enlisting'", async () => {
  const provider = new HeuristicSpecProvider();

  const enlisting = await provider.generate(
    "An app for a nonprofit coordinator enlisting local volunteers and businesses to sponsor an annual charity run.",
  );
  assert.ok(
    !enlisting.entities.some((e) => e.name === "Property"),
    "'enlisting' alone must not spuriously match Property via a bare 'listing' substring",
  );

  // The real word still works on its own, singular and plural (this
  // description avoids this rule's other keywords -- "property", "real
  // estate", "apartment for rent" -- so a match here can only come from
  // "listing" itself).
  const realListing = await provider.generate("An app for an agent to manage each listing and schedule viewings with buyers.");
  assert.ok(realListing.entities.some((e) => e.name === "Property"), "'listing' must still match Property");

  const realListings = await provider.generate("An app for an agent to manage all the listings and schedule viewings with buyers.");
  assert.ok(realListings.entities.some((e) => e.name === "Property"), "'listings' must still match Property");
});

/**
 * Regression test for round 558's finding: Property's bare "property"
 * keyword is genuinely ambiguous English -- it means a real-estate asset
 * in most descriptions, but "intellectual property" (patents/trademarks),
 * "lost property" (a lost-and-found service), and "property damage" (an
 * insurance/incident-tracking app) are all ordinary idioms with nothing to
 * do with real estate. `\b` alone can't fix this (it's a whole word, not a
 * substring), so the keyword now excludes only those specific phrases via
 * lookbehind/lookahead, the same disambiguation style "garage"/"checkout"
 * already use.
 */
test("Property's 'property' keyword doesn't spuriously match 'intellectual property', 'lost property', or 'property damage'", async () => {
  const provider = new HeuristicSpecProvider();

  const ipLaw = await provider.generate(
    "Track intellectual property filings for our law firm, including patents and trademarks for clients.",
  );
  assert.ok(
    !ipLaw.entities.some((e) => e.name === "Property"),
    "'intellectual property' alone must not spuriously match Property via a bare 'property' keyword",
  );

  const lostProperty = await provider.generate(
    "A lost-property office app for a train station, logging found items and owners.",
  );
  assert.ok(
    !lostProperty.entities.some((e) => e.name === "Property"),
    "'lost property' alone must not spuriously match Property via a bare 'property' keyword",
  );

  const propertyDamage = await provider.generate(
    "Manages property damage claims reported by employees after an incident.",
  );
  assert.ok(
    !propertyDamage.entities.some((e) => e.name === "Property"),
    "'property damage' alone must not spuriously match Property via a bare 'property' keyword",
  );

  // The real word still works on its own, singular and plural (this
  // description avoids this rule's other keywords -- "real estate",
  // "listing", "apartment for rent" -- so a match here can only come from
  // "property" itself).
  const realProperty = await provider.generate("An app for a landlord to track each rental property and its tenants.");
  assert.ok(realProperty.entities.some((e) => e.name === "Property"), "'property' must still match Property");

  const realProperties = await provider.generate("An app for a landlord to track all the rental properties and their tenants.");
  assert.ok(realProperties.entities.some((e) => e.name === "Property"), "'properties' must still match Property");
});

/**
 * Regression test for round 501's finding: Appointment's bare "reservation"
 * keyword is a substring of the unrelated, ordinary word "preservation" --
 * a historic/data/wildlife-preservation description has nothing to do with
 * booking a customer appointment, so it spuriously matched this entity too.
 * Fixed with the same `\b`-bounded RegExp pattern (plus the "(s)?" plural
 * handling) this file's other collision fixes already use.
 */
test("Appointment's 'reservation' keyword doesn't spuriously match 'preservation'", async () => {
  const provider = new HeuristicSpecProvider();

  const preservation = await provider.generate(
    "An app for a historic preservation nonprofit to track buildings, donors, and fundraising campaigns.",
  );
  assert.ok(
    !preservation.entities.some((e) => e.name === "Appointment"),
    "'preservation' alone must not spuriously match Appointment via a bare 'reservation' substring",
  );

  // The real word still works on its own, singular and plural (this
  // description avoids this rule's other keywords -- "appointment",
  // "booking" -- so a match here can only come from "reservation" itself).
  const realReservation = await provider.generate("An app for a restaurant host to track each table reservation for the evening.");
  assert.ok(realReservation.entities.some((e) => e.name === "Appointment"), "'reservation' must still match Appointment");

  const realReservations = await provider.generate("An app for a restaurant host to track all the table reservations for the evening.");
  assert.ok(realReservations.entities.some((e) => e.name === "Appointment"), "'reservations' must still match Appointment");
});

/**
 * Regression test for round 548's finding: Donation's bare "donation"/
 * "donations" keyword is a substring of the unrelated, ordinary legal/
 * compliance phrase "condonation" (as in "condonation of delay", used to
 * excuse a missed filing deadline) -- a law-firm/compliance description
 * using that word has nothing to do with charitable donations, so it
 * spuriously matched this entity too. Fixed with the same `\b`-bounded
 * RegExp pattern (plus the "(s)?" plural handling) this file's other
 * collision fixes already use.
 */
test("Donation's 'donation' keyword doesn't spuriously match 'condonation'", async () => {
  const provider = new HeuristicSpecProvider();

  const condonation = await provider.generate(
    "An app for a law firm to track condonation of delay petitions filed by clients, with case status and hearing dates.",
  );
  assert.ok(
    !condonation.entities.some((e) => e.name === "Donation"),
    "'condonation' alone must not spuriously match Donation via a bare 'donation' substring",
  );

  // The real word still works on its own, singular and plural (this
  // description avoids this rule's other keywords -- "donor", "nonprofit",
  // "fundraising campaign" -- so a match here can only come from
  // "donation" itself).
  const realDonation = await provider.generate("An app for a charity to track each donation made by supporters.");
  assert.ok(realDonation.entities.some((e) => e.name === "Donation"), "'donation' must still match Donation");

  const realDonations = await provider.generate("An app for a charity to track all the donations made by supporters.");
  assert.ok(realDonations.entities.some((e) => e.name === "Donation"), "'donations' must still match Donation");
});

/**
 * Regression test for round 557's finding: Appointment's bare "booking"
 * keyword is a substring of the unrelated, ordinary word "overbooking"
 * (airline/hotel capacity management) -- the same pitfall-1 shape as
 * reservation/preservation above. Fixed with the same `\b`-bounded RegExp
 * pattern (plus the "(s)?" plural handling) this file's other collision
 * fixes already use.
 */
test("Appointment's 'booking' keyword doesn't spuriously match 'overbooking'", async () => {
  const provider = new HeuristicSpecProvider();

  const overbooking = await provider.generate(
    "An airline tool to track overbooking rates and flight seat capacity.",
  );
  assert.ok(
    !overbooking.entities.some((e) => e.name === "Appointment"),
    "'overbooking' alone must not spuriously match Appointment via a bare 'booking' substring",
  );

  // The real word still works on its own, singular and plural (this
  // description avoids this rule's other keywords -- "appointment",
  // "reservation" -- so a match here can only come from "booking" itself).
  const realBooking = await provider.generate("An app for a salon to track each booking a client makes.");
  assert.ok(realBooking.entities.some((e) => e.name === "Appointment"), "'booking' must still match Appointment");

  const realBookings = await provider.generate("An app for a salon to track all the bookings clients make.");
  assert.ok(realBookings.entities.some((e) => e.name === "Appointment"), "'bookings' must still match Appointment");
});

/**
 * Regression test for round 557's finding: Task's bare "task" keyword is a
 * substring of the unrelated, ordinary word "multitasking" (a personal-
 * productivity/time-management skill) -- the same pitfall-1 shape as
 * reservation/preservation and booking/overbooking above. Fixed with the
 * same `\b`-bounded RegExp pattern (plus the "(s)?" plural handling) this
 * file's other collision fixes already use.
 */
test("Task's 'task' keyword doesn't spuriously match 'multitasking'", async () => {
  const provider = new HeuristicSpecProvider();

  const multitasking = await provider.generate(
    "A coaching app to help employees improve multitasking and focus skills during the workday.",
  );
  assert.ok(
    !multitasking.entities.some((e) => e.name === "Task"),
    "'multitasking' alone must not spuriously match Task via a bare 'task' substring",
  );

  // The real word still works on its own, singular and plural (this
  // description avoids this rule's other keywords -- "todo", "action item"
  // -- so a match here can only come from "task" itself).
  const realTask = await provider.generate("An app for a team to track each task assigned to a member.");
  assert.ok(realTask.entities.some((e) => e.name === "Task"), "'task' must still match Task");

  const realTasks = await provider.generate("An app for a team to track all the tasks assigned to members.");
  assert.ok(realTasks.entities.some((e) => e.name === "Task"), "'tasks' must still match Task");
});

/**
 * Regression test for round 550's finding: Order's bare "checkout" keyword
 * (and PAYMENT_KEYWORDS's own identical bare "checkout") is genuinely
 * ambiguous English -- it means an e-commerce purchase in most
 * descriptions, but is equally the ordinary word for a library's book
 * checkout process, with nothing to do with orders or payments. `\b` alone
 * can't fix this (it's a whole word, not a substring), so both lists now
 * require a specific e-commerce phrase ("checkout page"/"checkout flow"/
 * "online checkout") instead of the bare word.
 */
test("Order's 'checkout' keyword doesn't spuriously match a library's book checkout", async () => {
  const provider = new HeuristicSpecProvider();

  const library = await provider.generate(
    "An app for our local library to manage book checkout, returns, and member records.",
  );
  assert.ok(
    !library.entities.some((e) => e.name === "Order"),
    "a library's book checkout must not spuriously match Order via a bare 'checkout' substring",
  );
  // Every spec gets exactly one payment open-question; its wording/
  // recommendation (not its mere presence) is what PAYMENT_KEYWORDS
  // controls via needsPayments -- "checkout" alone must not flip it to
  // recommending Stripe.
  const paymentQuestion = library.openQuestions.find((q) => q.question.toLowerCase().includes("payment"));
  assert.ok(paymentQuestion);
  assert.equal(
    paymentQuestion!.recommendation,
    "No payments",
    "a library's book checkout must not spuriously trigger PAYMENT_KEYWORDS either",
  );

  // The real e-commerce phrase still works (this description avoids this
  // rule's other keywords -- "order", "purchase", "delivery" -- so a match
  // here can only come from the checkout phrase itself).
  const realCheckout = await provider.generate("An online store where customers browse products and complete a checkout page to buy them.");
  assert.ok(realCheckout.entities.some((e) => e.name === "Order"), "a real 'checkout page' must still match Order");
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

/**
 * Regression test for round 660's finding: MenuItem's plural "מנות"
 * keyword -- chosen specifically (see the comment above the rule) to
 * dodge the "מנה"/"מנהל" (manager) collision -- is itself a bare
 * substring of this very file's own Order rule's "הזמנות" ("orders")
 * keyword a few entries up. A description naming only orders, with no
 * restaurant/menu concept at all, spuriously matched MenuItem too,
 * fabricating a restaurant-menu entity (price/category/available fields,
 * List/Form screens) for e.g. a clothing store's order tracker. Fixed
 * with a negative lookbehind excluding exactly that root, the same
 * disambiguation idiom this file already uses for its other collisions.
 */
test("MenuItem's 'מנות' keyword doesn't spuriously match inside Order's own 'הזמנות' keyword", async () => {
  const provider = new HeuristicSpecProvider();

  const ordersOnly = await provider.generate("אפליקציה לניהול הזמנות של חנות בגדים אונליין");
  assert.ok(
    !ordersOnly.entities.some((e) => e.name === "MenuItem"),
    "a pure order-management description must not spuriously match MenuItem via a bare 'מנות' substring inside 'הזמנות'",
  );
  assert.ok(ordersOnly.entities.some((e) => e.name === "Order"), "the real 'הזמנות' keyword must still match Order");

  // The real word still works on its own (this description avoids this
  // rule's other keywords -- "menu", "תפריט", "מסעדה", etc. -- so a match
  // here can only come from a standalone "מנות" not preceded by "ז").
  const realMenu = await provider.generate("אפליקציה לניהול מנות של בית אוכל קטן");
  assert.ok(realMenu.entities.some((e) => e.name === "MenuItem"), "a standalone 'מנות' must still match MenuItem");
});

/**
 * Regression test for round 518's finding: Product's bare "מלאי"
 * ("inventory/stock") keyword is a substring of two unrelated, ordinary
 * Hebrew words -- WorkOrder's own "חשמלאי"/"חשמלאים" ("electrician(s)")
 * and the common adjective "מלאים" ("full", plural). An electrician/
 * field-service app description, or any description using "full" as a
 * plural adjective, has nothing to do with retail inventory, so Product
 * spuriously matched in both cases. Fixed with a lookbehind/lookahead
 * regex that excludes exactly these two collisions while "מלאי" still
 * matches as its own word.
 */
test("Product's 'מלאי' keyword doesn't spuriously match 'חשמלאי' (electrician) or 'מלאים' (full)", async () => {
  const provider = new HeuristicSpecProvider();

  const electrician = await provider.generate("אפליקציה לניהול קריאות שירות לחשמלאים עם לקוחות וטכנאים");
  assert.ok(
    !electrician.entities.some((e) => e.name === "Product"),
    "'חשמלאים' (electricians) alone must not spuriously match Product via a bare 'מלאי' substring",
  );

  const fullAdjective = await provider.generate("אפליקציה למעקב אחרי ארונות מלאים במחסן");
  assert.ok(
    !fullAdjective.entities.some((e) => e.name === "Product"),
    "'מלאים' (full, plural adjective) alone must not spuriously match Product via a bare 'מלאי' substring",
  );

  // The real business term still works, including with a definite
  // article/preposition prefix and no suffix at all.
  const inventory = await provider.generate("אפליקציה לניהול מלאי בחנות");
  assert.ok(inventory.entities.some((e) => e.name === "Product"), "'מלאי' must still match Product");
});

/**
 * Regression test for round 527's finding: bare "חיוב" ("charge"), used in
 * both PAYMENT_KEYWORDS and the Invoice entry's keywords, is a substring
 * of the ordinary, unrelated adjective/noun "חיובי"/"חיובית"/"חיוביות"
 * ("positive"/"positivity") -- extremely natural phrasing for a feedback/
 * review/survey app ("משוב חיובי", "ביקורת חיובית"). A description with no
 * mention of money at all would still spuriously get a full Invoice
 * entity and the "which payment provider" question, purely from this
 * substring, the same collision class already fixed for "stripe"
 * (round 460) and "מלאי" (round 518). Fixed with a lookahead regex that
 * excludes "חיוב" immediately followed by "י" unless that "י" is itself
 * followed by "ם" -- which still matches the real plural "חיובים"
 * ("charges") while rejecting the "positive" forms.
 */
test("'חיוב' keyword doesn't spuriously match 'חיובי'/'חיובית'/'חיוביות' (positive)", async () => {
  const provider = new HeuristicSpecProvider();

  const positiveFeedback = await provider.generate("אפליקציה לאיסוף משוב חיובי מלקוחות על השירות שלנו");
  assert.ok(
    !positiveFeedback.entities.some((e) => e.name === "Invoice"),
    "'חיובי' (positive) alone must not spuriously match Invoice via a bare 'חיוב' substring",
  );
  const positiveQuestion = positiveFeedback.openQuestions[0];
  assert.equal(positiveQuestion.question, "האם האפליקציה צריכה לקבל תשלומים?");
  assert.equal(positiveQuestion.recommendation, "בלי תשלומים");

  const positiveReview = await provider.generate("מערכת לניהול ביקורות חיוביות ושליליות על מוצרים");
  assert.ok(
    !positiveReview.entities.some((e) => e.name === "Invoice"),
    "'חיוביות' (positivity) alone must not spuriously match Invoice via a bare 'חיוב' substring",
  );

  // The real business terms still work: the bare word itself, and its
  // real plural "חיובים" ("charges"), which shares the same "י" character
  // immediately after "חיוב" that the positive forms do.
  const billing = await provider.generate("אפליקציה לניהול חיוב חודשי למנויים");
  assert.ok(billing.entities.some((e) => e.name === "Invoice"), "'חיוב' must still match Invoice");

  const charges = await provider.generate("אפליקציה למעקב אחרי חיובים פתוחים של לקוחות");
  assert.ok(charges.entities.some((e) => e.name === "Invoice"), "'חיובים' (charges) must still match Invoice");
  const chargesQuestion = charges.openQuestions[0];
  assert.equal(chargesQuestion.question, "באיזה ספק תשלומים כדאי להשתמש?");
  assert.equal(chargesQuestion.recommendation, "Stripe");
});

/**
 * Regression test for round 559's finding: ROLE_RULES.Manager's bare
 * "management" keyword is a substring of the unrelated, ordinary word
 * "mismanagement" -- the same pitfall-1 shape as reservation/preservation,
 * booking/overbooking, and task/multitasking above, but on the ROLE_RULES
 * table (which governs spec.roles) rather than DOMAIN_ENTITY_RULES. A
 * compliance/nonprofit description that only mentions "mismanagement" (of
 * funds, say) has no manager-role concept at all, yet spuriously got a
 * fabricated "Manager" role shown to the user. Fixed with the same
 * `\b`-bounded RegExp pattern this file's other collision fixes already
 * use (matchesKeyword/ROLE_RULES already supported RegExp keywords since
 * round 446's Employee/"worker" role-side fix).
 */
test("Manager's 'management' keyword doesn't spuriously match 'mismanagement'", async () => {
  const provider = new HeuristicSpecProvider();

  const mismanagement = await provider.generate(
    "An app for a nonprofit to track grants and detect any financial mismanagement of donated funds.",
  );
  assert.ok(
    !mismanagement.roles.includes("Manager"),
    "'mismanagement' alone must not spuriously add a Manager role via a bare 'management' substring",
  );

  // The real word still works on its own (this description avoids this
  // rule's other keywords -- "manager" itself, "ניהול" -- so a match here
  // can only come from "management").
  const realManagement = await provider.generate("An app to support property management operations for a landlord.");
  assert.ok(realManagement.roles.includes("Manager"), "'management' must still add the Manager role");
});

/**
 * Regression test for round 659's finding: the same substring-collision
 * shape as round 559's "management"/"mismanagement" fix just above, but
 * on ROLE_RULES's own Hebrew side -- Manager's bare "מנהל" keyword is
 * itself a plain substring of Admin's own "מנהל מערכת" ("system admin")
 * phrase two lines above it in the same table. A description naming only
 * a system admin, with no manager concept at all, spuriously matched
 * Manager too. Since matchRoles only adds the generic Member fallback
 * when exactly one non-Admin role was detected, this silently suppressed
 * Member and fabricated a Manager role/persona/screens the description
 * never asked for -- a strictly worse outcome than simply matching
 * nothing extra. Fixed with the same negative-lookahead idiom this file
 * already uses for e.g. "חיוב"/"חיובים" and "מוצר"/"מוצרט".
 */
test("Manager's bare 'מנהל' keyword doesn't spuriously match inside Admin's own 'מנהל מערכת' phrase", async () => {
  const provider = new HeuristicSpecProvider();

  const adminOnly = await provider.generate("האפליקציה מיועדת למנהל מערכת אחד בלבד, בלי תפקידים אחרים.");
  assert.ok(
    !adminOnly.roles.includes("מנהל/ת"),
    "a description naming only a system admin must not spuriously add a Manager role via a bare 'מנהל' substring",
  );
  assert.ok(
    adminOnly.roles.includes("חבר/ת צוות"),
    "with no second real role detected, the generic Member fallback must still be added, not silently suppressed",
  );

  // The real word still works on its own (via "מנהלת"/"ניהול", which this
  // description also avoids, so a match here can only come from a
  // standalone "מנהל" not followed by "מערכת").
  const realManager = await provider.generate("אפליקציה למנהל חנות שעוקב אחרי המלאי והעובדים.");
  assert.ok(realManager.roles.includes("מנהל/ת"), "a standalone 'מנהל' (store manager) must still add the Manager role");
});

/**
 * Regression test for round 811's finding: the identical substring
 * collision round 659 (above) fixed for the masculine "מנהל מערכת" was
 * never carried through to the feminine form -- "מנהלת מערכת" ("female
 * system admin") contains the bare substring "מנהל" (מנהלת's own first
 * four letters) immediately followed by "ת", not "מערכת", so round 659's
 * own `(?!\s*מערכת)` lookahead didn't fire for it, and the separate bare
 * "מנהלת" keyword (with no lookahead of its own) matched it outright. A
 * description naming only a female system admin spuriously got Manager
 * too, silently suppressing the generic Member fallback the same way
 * round 659's own bug did for the masculine phrase.
 */
test("Manager's 'מנהל'/'מנהלת' keywords don't spuriously match inside Admin's own feminine 'מנהלת מערכת' phrase", async () => {
  const provider = new HeuristicSpecProvider();

  const adminOnly = await provider.generate("האפליקציה מיועדת למנהלת מערכת אחת בלבד, בלי תפקידים אחרים.");
  assert.ok(
    !adminOnly.roles.includes("מנהל/ת"),
    "a description naming only a female system admin must not spuriously add a Manager role via the 'מנהל'/'מנהלת' substring",
  );
  assert.ok(
    adminOnly.roles.includes("חבר/ת צוות"),
    "with no second real role detected, the generic Member fallback must still be added, not silently suppressed",
  );

  // The real feminine word still works on its own, the same way round
  // 659's own masculine counterpart does.
  const realManager = await provider.generate("אפליקציה למנהלת חנות שעוקבת אחרי המלאי והעובדים.");
  assert.ok(realManager.roles.includes("מנהל/ת"), "a standalone 'מנהלת' (female store manager) must still add the Manager role");
});

/**
 * Regression test for round 814's finding: a third inflection of the same
 * word family rounds 659/811 (above) already fixed for the masculine and
 * feminine singular -- the Hebrew construct-state plural "מנהלי מערכת"
 * ("system administrators"), the standard phrasing for naming the role/
 * permission group rather than one person. After "מנהל" the next letter
 * is "י" (not "ת" or whitespace), so neither prior lookahead fires for it.
 * A description naming only system administrators, in this far more
 * natural plural phrasing, spuriously got Manager too, silently
 * suppressing the generic Member fallback the same way rounds 659/811's
 * own bugs did for the singular forms.
 */
test("Manager's 'מנהל' keyword doesn't spuriously match inside Admin's own construct-plural 'מנהלי מערכת' phrase", async () => {
  const provider = new HeuristicSpecProvider();

  const adminOnly = await provider.generate("האפליקציה מיועדת למנהלי מערכת בלבד, בלי תפקידים אחרים.");
  assert.ok(
    !adminOnly.roles.includes("מנהל/ת"),
    "a description naming only system administrators (plural) must not spuriously add a Manager role via the 'מנהל' substring",
  );
  assert.ok(
    adminOnly.roles.includes("חבר/ת צוות"),
    "with no second real role detected, the generic Member fallback must still be added, not silently suppressed",
  );

  // The real construct-plural word still works on its own, the same way
  // rounds 659/811's own singular counterparts do.
  const realManagers = await provider.generate("אפליקציה למנהלי חנות שעוקבים אחרי המלאי והעובדים.");
  assert.ok(realManagers.roles.includes("מנהל/ת"), "a standalone 'מנהלי' (plural store managers) must still add the Manager role");
});

/**
 * Regression test for round 561's finding: Student's bare "pupil" keyword
 * is a whole-word genuine polysemy collision (not a substring issue) with
 * the ophthalmology/optometry term "pupil" (the part of the eye) -- the
 * same shape as the already-fixed "garage"/"garage sale" (round 454) and
 * "property"/"intellectual property" (round 558) collisions, not the
 * substring-in-a-longer-word shape. An eye-care description mentioning
 * pupil size, dilation, or reaction has nothing to do with a school.
 * Fixed by excluding the specific known eye-anatomy idioms via
 * lookbehind/lookahead, the same disambiguation style this file's other
 * polysemy fixes already use.
 */
test("Student's 'pupil' keyword doesn't spuriously match the eye-anatomy sense of 'pupil'", async () => {
  const provider = new HeuristicSpecProvider();

  const eyeSize = await provider.generate(
    "An ophthalmology clinic app to record each patient's pupil size during an eye exam.",
  );
  assert.ok(
    !eyeSize.entities.some((e) => e.name === "Student"),
    "'pupil size' alone must not spuriously match Student via the eye-anatomy sense of 'pupil'",
  );

  const dilation = await provider.generate("An optometry app to track pupil dilation measurements for each patient.");
  assert.ok(
    !dilation.entities.some((e) => e.name === "Student"),
    "'pupil dilation' alone must not spuriously match Student via the eye-anatomy sense of 'pupil'",
  );

  const dilatedPupils = await provider.generate("A clinic app to log dilated pupils and reflex response for patients.");
  assert.ok(
    !dilatedPupils.entities.some((e) => e.name === "Student"),
    "'dilated pupils' alone must not spuriously match Student via the eye-anatomy sense of 'pupil'",
  );

  // The real school term still works on its own, singular and plural (these
  // descriptions avoid this rule's other keywords -- "student", "learner",
  // etc. -- so a match here can only come from "pupil"/"pupils" itself).
  const realPupil = await provider.generate("An app for a school to track each pupil's attendance and homework.");
  assert.ok(realPupil.entities.some((e) => e.name === "Student"), "'pupil' must still match Student");

  const realPupils = await provider.generate("An app for a school to track all the pupils' attendance and homework.");
  assert.ok(realPupils.entities.some((e) => e.name === "Student"), "'pupils' must still match Student");
});

/**
 * Regression test for round 562's finding: Event's bare Hebrew keyword
 * "כנס" ("conference") is a substring of common conjugations of the
 * כ.נ.ס root ("to enter"/"to log in") -- "להיכנס" (to log in), "נכנס"
 * (logs in/enters), "תיכנס" (you'll log in), "מתכנס"/"התכנסות" (convenes/
 * convening) -- the exact "event" ⊂ "prevents" substring pitfall this
 * same entity's own Review-entity comment a few hundred lines up already
 * warns about, but on the Hebrew side where JS's \b can't bound words at
 * all (same reason round 518's "מלאי" and round 527's "חיוב" fixes needed
 * lookbehind/lookahead instead). A plain employee/task-management app
 * description mentioning a login flow had nothing to do with conferences.
 * Fixed by excluding the specific known כ.נ.ס verb-conjugation prefixes
 * via negative lookbehind, the same disambiguation style this file's
 * other collision fixes already use.
 */
test("Event's 'כנס' keyword doesn't spuriously match conjugations of the כ.נ.ס root ('to log in'/'to enter')", async () => {
  const provider = new HeuristicSpecProvider();

  const login = await provider.generate(
    "אפליקציה לניהול משימות לעובדים, כל עובד יכול להיכנס למערכת ולראות את המשימות שלו",
  );
  assert.ok(
    !login.entities.some((e) => e.name === "Event"),
    "'להיכנס' (to log in) alone must not spuriously match Event via a bare 'כנס' substring",
  );

  const enters = await provider.generate("המערכת שולחת התראה בכל פעם שעובד נכנס למשרד בבוקר");
  assert.ok(
    !enters.entities.some((e) => e.name === "Event"),
    "'נכנס' (enters/logs in) alone must not spuriously match Event via a bare 'כנס' substring",
  );

  const convenes = await provider.generate("אפליקציה למעקב אחרי ועד בית שמתכנס כל חודש לדון בתקציב");
  assert.ok(
    !convenes.entities.some((e) => e.name === "Event"),
    "'מתכנס' (convenes) alone must not spuriously match Event via a bare 'כנס' substring",
  );

  // The real word still works on its own, singular and plural (these
  // descriptions avoid this rule's other keywords -- "אירוע"/"חתונה" etc.
  // -- so a match here can only come from "כנס"/"כנסים" itself).
  const realConference = await provider.generate("אפליקציה לניהול כנס מקצועי עם הרשמת משתתפים");
  assert.ok(realConference.entities.some((e) => e.name === "Event"), "'כנס' must still match Event");

  const realConferences = await provider.generate("אפליקציה למעקב אחרי כנסים שונים ברחבי הארץ");
  assert.ok(realConferences.entities.some((e) => e.name === "Event"), "'כנסים' must still match Event");
});

/**
 * Regression test for round 563's finding: Subscription's bare Hebrew
 * keyword "מנוי" ("subscriber"/"subscription") -- and PAYMENT_KEYWORDS's
 * own identical bare "מנוי" -- is a substring of the ordinary plural
 * "אומנויות"/"אמנויות" ("arts"/"crafts"), as in the standard phrase
 * "אומנויות לחימה" (martial arts). A plain martial-arts/dance-school
 * description had nothing to do with recurring billing. JS's \b doesn't
 * bound Hebrew (same reason round 518's "מלאי" and round 562's "כנס"
 * fixes needed lookahead/lookbehind too), so this excludes "מנוי"
 * immediately followed by the "ות" plural suffix that marks the
 * unrelated "arts" word, while still matching "מנוי"/"מנויים".
 */
test("Subscription's 'מנוי' keyword doesn't spuriously match 'אומנויות' (arts/crafts)", async () => {
  const provider = new HeuristicSpecProvider();

  const martialArts = await provider.generate(
    "אפליקציה לניהול מועדון אומנויות לחימה עם תלמידים ושיעורים",
  );
  assert.ok(
    !martialArts.entities.some((e) => e.name === "Subscription"),
    "'אומנויות לחימה' (martial arts) alone must not spuriously match Subscription via a bare 'מנוי' substring",
  );
  // Every spec gets exactly one payment open-question; its recommendation
  // (not its mere presence) is what PAYMENT_KEYWORDS controls via
  // needsPayments -- "אומנויות" alone must not flip it to recommending
  // Stripe either.
  const paymentQuestion = martialArts.openQuestions.find((q) => q.question.includes("תשלו"));
  assert.ok(paymentQuestion);
  assert.equal(
    paymentQuestion!.recommendation,
    "בלי תשלומים",
    "'אומנויות' alone must not spuriously trigger PAYMENT_KEYWORDS either",
  );

  const artsSchool = await provider.generate("בית ספר לאמנויות מציע קורסים לציור ולפיסול");
  assert.ok(
    !artsSchool.entities.some((e) => e.name === "Subscription"),
    "'אמנויות' (arts) alone must not spuriously match Subscription via a bare 'מנוי' substring",
  );

  // The real word still works, singular and plural (these descriptions
  // avoid this rule's other keywords -- "subscription", "membership plan",
  // etc. -- so a match here can only come from "מנוי"/"מנויים" itself).
  const realSubscription = await provider.generate("אפליקציה לניהול מנוי בתשלום חוזר לחדר כושר");
  assert.ok(realSubscription.entities.some((e) => e.name === "Subscription"), "'מנוי' must still match Subscription");

  const realSubscriptions = await provider.generate("מערכת למעקב אחרי כל המנויים הפעילים במועדון");
  assert.ok(
    realSubscriptions.entities.some((e) => e.name === "Subscription"),
    "'מנויים' must still match Subscription",
  );
});

/**
 * Regression test for round 564's finding: Product's bare Hebrew keyword
 * "מוצר" ("product") is a substring of "מוצרט" ("Mozart" transliterated
 * into Hebrew). A concert/music-school description mentioning Mozart had
 * nothing to do with retail inventory. JS's \b doesn't bound Hebrew (same
 * reason round 518's "מלאי", round 562's "כנס", and round 563's "מנוי"
 * fixes needed lookahead/lookbehind too), so this excludes the specific
 * "ט" that marks "Mozart" while still matching "מוצר"/"מוצרים".
 */
test("Product's 'מוצר' keyword doesn't spuriously match 'מוצרט' (Mozart)", async () => {
  const provider = new HeuristicSpecProvider();

  const mozart = await provider.generate(
    "אפליקציה למכירת כרטיסים להופעות של מוצרט לתלמידי המוסיקה",
  );
  assert.ok(
    !mozart.entities.some((e) => e.name === "Product"),
    "'מוצרט' (Mozart) alone must not spuriously match Product via a bare 'מוצר' substring",
  );

  // The real word still works, singular and plural (these descriptions
  // avoid this rule's other keywords -- "inventory", "stock", etc. -- so a
  // match here can only come from "מוצר"/"מוצרים" itself).
  const realProduct = await provider.generate("אפליקציה לניהול מוצר אחד בחנות קטנה");
  assert.ok(realProduct.entities.some((e) => e.name === "Product"), "'מוצר' must still match Product");

  const realProducts = await provider.generate("אפליקציה לניהול מוצרים בחנות");
  assert.ok(realProducts.entities.some((e) => e.name === "Product"), "'מוצרים' must still match Product");
});

/**
 * Regression test for round 565's finding: Employee's bare Hebrew
 * keywords "עובד"/"עובדת"/"עובדים" ("employee"/"employee (f)"/
 * "employees") -- in both DOMAIN_ENTITY_RULES and ROLE_RULES -- are
 * substrings of the pu'al passive-participle adjective "מעובד"
 * ("processed", as in processed food/data/materials), an extremely
 * common Hebrew word with nothing to do with staff. A manufacturing
 * description mentioning processed food had nothing to do with
 * employees. JS's \b doesn't bound Hebrew (same reason round 518's
 * "מלאי" and round 564's "מוצר" fixes needed lookbehind too), so this
 * excludes the specific "מ" pu'al prefix while still matching
 * "עובד"/"עובדת"/"עובדים" in every real phrasing.
 */
test("Employee's 'עובד' keyword doesn't spuriously match 'מעובד' (processed), for both the entity and the role", async () => {
  const provider = new HeuristicSpecProvider();

  const processedFood = await provider.generate(
    "אפליקציה לניהול מפעל שמייצר מזון מעובד ומוכר אותו לחנויות",
  );
  assert.ok(
    !processedFood.entities.some((e) => e.name === "Employee"),
    "'מעובד' (processed) alone must not spuriously match Employee via a bare 'עובד' substring",
  );
  assert.ok(
    !processedFood.roles.includes("עובד/ת"),
    "'מעובד' (processed) alone must not spuriously add an Employee role via a bare 'עובד' substring",
  );

  // The real word still works, singular and plural, for both the entity
  // and the role (these descriptions avoid this rule's other keywords --
  // "staff", "צוות", etc. -- so a match here can only come from
  // "עובד"/"עובדים" itself). Hebrew descriptions report roles via their
  // Hebrew label ("עובד/ת"), not the English role name.
  const realEmployee = await provider.generate("אפליקציה לניהול עובד אחד בחנות קטנה");
  assert.ok(realEmployee.entities.some((e) => e.name === "Employee"), "'עובד' must still match Employee");
  assert.ok(realEmployee.roles.includes("עובד/ת"), "'עובד' must still add the Employee role");

  const realEmployees = await provider.generate("אפליקציה לניהול עובדים בחברה");
  assert.ok(realEmployees.entities.some((e) => e.name === "Employee"), "'עובדים' must still match Employee");
  assert.ok(realEmployees.roles.includes("עובד/ת"), "'עובדים' must still add the Employee role");
});

/**
 * Regression test for round 571's finding: Vendor's bare Hebrew keyword
 * "ספק" ("supplier"/"vendor") is a true Hebrew homograph, not just an
 * unbounded substring like the file's other fixes -- the identical
 * spelling "ספק" is also the ordinary word for "doubt", used in extremely
 * common filler idioms like "ללא ספק"/"אין ספק"/"בלי ספק" (undoubtedly/no
 * doubt) and "מוטל בספק" (in doubt). A plain task-management description
 * that happened to include "ללא ספק" as filler spuriously matched Vendor,
 * even though it has nothing to do with purchasing or suppliers. JS's \b
 * doesn't bound Hebrew (same reason round 518's "מלאי", round 562's
 * "כנס", round 563's "מנוי", round 564's "מוצר", round 565's "עובד", and
 * round 567's "רכב" fixes needed lookahead/lookbehind), so this excludes
 * "ספק" immediately preceded by those specific idiom words, while still
 * matching real usage like "ספק"/"ספקים".
 */
test("Vendor's 'ספק' keyword doesn't spuriously match the unrelated 'doubt' idioms sharing the same spelling", async () => {
  const provider = new HeuristicSpecProvider();

  const noDoubtTasks = await provider.generate(
    "אפליקציה לניהול משימות לעסק קטן. ללא ספק הצוות שלנו צריך את זה.",
  );
  assert.ok(
    !noDoubtTasks.entities.some((e) => e.name === "Vendor"),
    "'ללא ספק' (undoubtedly) alone must not spuriously match Vendor via a bare 'ספק' substring",
  );

  const noDoubtHelp = await provider.generate(
    "אפליקציה לניהול משימות לעסק קטן. אין ספק שזה יעזור לנו.",
  );
  assert.ok(
    !noDoubtHelp.entities.some((e) => e.name === "Vendor"),
    "'אין ספק' (no doubt) alone must not spuriously match Vendor via a bare 'ספק' substring",
  );

  const inDoubt = await provider.generate(
    "אפליקציה לניהול משימות לעסק קטן. בלי ספק זה ישתלם, אבל התוצאה מוטל בספק.",
  );
  assert.ok(
    !inDoubt.entities.some((e) => e.name === "Vendor"),
    "'בלי ספק'/'מוטל בספק' alone must not spuriously match Vendor via a bare 'ספק' substring",
  );

  // The real word still works, singular and plural (this description
  // avoids this rule's other keywords -- "vendor", "procurement", etc. --
  // so a match here can only come from "ספק"/"ספקים" itself).
  const realVendor = await provider.generate("אנחנו עסק קטן שצריך לנהל ספק אחד שמספק לנו חומרי גלם.");
  assert.ok(realVendor.entities.some((e) => e.name === "Vendor"), "'ספק' must still match Vendor");

  const realVendors = await provider.generate("אנחנו עסק קטן שצריך לנהל ספקים ורכש.");
  assert.ok(realVendors.entities.some((e) => e.name === "Vendor"), "'ספקים' must still match Vendor");
});

/**
 * Regression test for round 572's finding: InsuranceClaim's bare Hebrew
 * keyword "תביעה" is the ordinary, generic word for "claim"/"lawsuit" in
 * Hebrew, used constantly in general legal contexts ("הגשת תביעה", "תביעה
 * אזרחית") with zero connection to insurance. A plain law-firm/legal-case
 * description mentioning a client's claim spuriously matched
 * InsuranceClaim. Unlike this file's substring-within-a-word fixes
 * (רכב/מלאי/מוצר/etc.), this is whole-word polysemy, same shape as
 * "property"/"garage"/"pupil" -- but the fix here is simpler: "תביעת
 * ביטוח"/"תביעות ביטוח" already cover every genuine insurance phrasing on
 * their own, so the redundant bare word is just removed, not regex-guarded.
 */
test("InsuranceClaim's 'תביעה' keyword doesn't spuriously match the generic legal sense of 'claim'/'lawsuit'", async () => {
  const provider = new HeuristicSpecProvider();

  const legalCase = await provider.generate(
    "אפליקציה לניהול תיקים משפטיים למשרד עורכי דין, כולל מעקב אחר תביעה של לקוח, סטטוס תיק ותאריך אירוע.",
  );
  assert.ok(
    !legalCase.entities.some((e) => e.name === "InsuranceClaim"),
    "'תביעה' (claim/lawsuit) alone in a law-firm description must not spuriously match InsuranceClaim",
  );

  // The real phrase still works, singular and plural (these descriptions
  // avoid this rule's other keywords -- "insurance claim", "policyholder",
  // etc. -- so a match here can only come from "תביעת ביטוח"/"תביעות
  // ביטוח" itself).
  const realInsurance = await provider.generate("אפליקציה לניהול תביעת ביטוח של בעלי פוליסה, כולל סכום וסטטוס.");
  assert.ok(realInsurance.entities.some((e) => e.name === "InsuranceClaim"), "'תביעת ביטוח' must still match InsuranceClaim");

  const realInsurancePlural = await provider.generate("אפליקציה לטיפול בתביעות ביטוח מבעלי פוליסה");
  assert.ok(realInsurancePlural.entities.some((e) => e.name === "InsuranceClaim"), "'תביעות ביטוח' must still match InsuranceClaim");
});

/**
 * Regression test for round 574's finding: Employee's bare "staff"
 * keyword (used both in DOMAIN_ENTITY_RULES and ROLE_RULES) is a
 * substring of "Staffordshire" (the dog breed) -- a plain dog-breeding
 * app description had nothing to do with HR/staff management, so it
 * spuriously fabricated both an Employee entity AND an Employee role.
 * Fixed with the same `\b`-bounded RegExp pattern this file's own
 * "worker"/"coworker" fix (round 446) already uses for the identical
 * collision shape, right next to it in the same keyword arrays.
 */
test("Employee's 'staff' keyword doesn't spuriously match 'Staffordshire', for both the entity and the role", async () => {
  const provider = new HeuristicSpecProvider();

  const dogBreeding = await provider.generate(
    "An app to track Staffordshire Terrier puppies I breed and sell, including their vaccination records and buyer info.",
  );
  assert.ok(
    !dogBreeding.entities.some((e) => e.name === "Employee"),
    "'Staffordshire' alone must not spuriously match Employee via a bare 'staff' substring",
  );
  assert.ok(
    !dogBreeding.roles.includes("Employee"),
    "'Staffordshire' alone must not spuriously add an Employee role via a bare 'staff' substring",
  );

  // The real HR/staff term still works, for both the entity and the role
  // (this description avoids the rule's other keywords -- "employee",
  // "worker", etc. -- so a match here can only come from "staff" itself).
  const staffApp = await provider.generate("An app to manage our retail staff and their shift schedules.");
  assert.ok(staffApp.entities.some((e) => e.name === "Employee"), "'staff' must still match Employee");
  assert.ok(staffApp.roles.includes("Employee"), "'staff' must still add the Employee role");
});

/**
 * Regression test for round 575's finding: Event's bare "חתונה"
 * (wedding) and "חתונות" (weddings) keywords are substrings of
 * "תחתונה"/"תחתונות" ("lower [clothing]"/"underwear", e.g. the common
 * phrase "הלבשה תחתונה" -- lingerie) -- a plain underwear/lingerie-store
 * description has nothing to do with weddings or events, so it
 * spuriously fabricated an Event entity purely from "תחתונה" containing
 * "חתונה" letter-for-letter. Hebrew has no `\b`, so this is fixed with a
 * negative lookbehind excluding the specific "ת" prefix, the same
 * approach this file's own "כנס" fix (round 562) already uses right
 * above it in the same keyword array.
 */
test("Event's 'חתונה'/'חתונות' keywords don't spuriously match 'תחתונה'/'תחתונות' (lower clothing/underwear)", async () => {
  const provider = new HeuristicSpecProvider();

  const underwearSingular = await provider.generate("חנות הלבשה תחתונה לנשים, עם מעקב מלאי ומחירים.");
  assert.ok(
    !underwearSingular.entities.some((e) => e.name === "Event"),
    "'תחתונה' (lower clothing, singular) alone must not spuriously match Event via a bare 'חתונה' substring",
  );

  const underwearPlural = await provider.generate("ניהול מלאי של תחתונות וחזיות בחנות הלבשה.");
  assert.ok(
    !underwearPlural.entities.some((e) => e.name === "Event"),
    "'תחתונות' (underwear, plural) alone must not spuriously match Event via a bare 'חתונות' substring",
  );

  // The real wedding/event terms still work, singular and plural.
  const realWedding = await provider.generate("אפליקציה לניהול חתונה, כולל מקום, קיבולת וסטטוס.");
  assert.ok(realWedding.entities.some((e) => e.name === "Event"), "'חתונה' must still match Event");

  const realWeddingsPlural = await provider.generate("אפליקציה לניהול חתונות ואירועים, כולל מקום וקיבולת.");
  assert.ok(realWeddingsPlural.entities.some((e) => e.name === "Event"), "'חתונות' must still match Event");
});

/**
 * Regression test for round 576's finding: Donation's Hebrew keyword
 * "עמותה" (nonprofit) had no plural entry. Unlike most of this file's
 * Hebrew nouns, the plural "עמותות" replaces the final ה with ות rather
 * than appending a suffix, so it is not a substring of "עמותה" the way
 * "תרומה"/"תרומות" already are -- a description using only the plural
 * matched no domain entity at all (it fell back to the generic Item
 * entity), even though it is unambiguously describing nonprofits.
 */
test("Donation's 'עמותה' keyword also matches its plural 'עמותות', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralOnly = await provider.generate("מערכת לניהול עמותות בארץ, כולל מעקב סטטוס.");
  assert.ok(
    pluralOnly.entities.some((e) => e.name === "Donation"),
    "'עמותות' (nonprofits, plural) alone must match Donation",
  );

  const singular = await provider.generate("אפליקציה לניהול עמותה אחת, כולל מעקב סטטוס.");
  assert.ok(singular.entities.some((e) => e.name === "Donation"), "'עמותה' (singular) must still match Donation");
});

/**
 * Regression test for round 577's finding: Vehicle's Hebrew keyword
 * "מוסך" (garage) had no plural entry. Its plural "מוסכים" swaps the
 * word-final sofit-kaf ("ך") for a regular kaf ("כ") -- a different
 * Unicode character -- so "מוסך" is not a substring of "מוסכים" the way
 * most of this file's Hebrew nouns are of their own plurals. A
 * description using only the plural ("רשת מוסכים") matched no domain
 * entity at all. The test sentences deliberately avoid every other
 * Vehicle keyword ("רכב", "מכונאי", "כלי רכב", "garage", "mechanic", "car
 * dealership") so the assertion isolates "מוסך"/"מוסכים" alone, the same
 * vacuous-test pitfall round 576's own first test attempt fell into.
 */
test("Vehicle's 'מוסך' keyword also matches its plural 'מוסכים', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralOnly = await provider.generate("אפליקציה לניהול רשת מוסכים ברחבי הארץ, עם מעקב סטטוס.");
  assert.ok(
    pluralOnly.entities.some((e) => e.name === "Vehicle"),
    "'מוסכים' (garages, plural) alone must match Vehicle",
  );

  const singular = await provider.generate("אפליקציה לניהול מוסך אחד בעיר, עם מעקב סטטוס.");
  assert.ok(singular.entities.some((e) => e.name === "Vehicle"), "'מוסך' (singular) must still match Vehicle");
});

/**
 * Regression test for round 578's finding: Case's Hebrew keywords
 * "עורך דין" (attorney) and "עורכת דין" (female attorney) had no plural
 * entries. "עורך" ends in the word-final sofit-kaf ("ך"); its plural
 * "עורכי" swaps it for a regular kaf ("כ") -- the same bug shape round
 * 577 found for "מוסך"/"מוסכים". "עורכת"'s plural "עורכות" has the
 * analogous ת→ות gap round 576 found for "עמותה"/"עמותות". Either
 * plural-only phrasing matched no domain entity at all. The test
 * sentences contain no other Case keyword ("תיק", "law firm", "legal
 * matter", etc.) or any sibling entity's keyword, so they isolate the
 * plural keywords alone -- the same vacuous-test pitfall round 576's own
 * first test attempt fell into.
 */
test("Case's 'עורך דין'/'עורכת דין' keywords also match their plurals 'עורכי דין'/'עורכות דין', which aren't substrings of the singulars", async () => {
  const provider = new HeuristicSpecProvider();

  const mascPlural = await provider.generate("אפליקציה למעקב אחרי עורכי דין במשרד.");
  assert.ok(mascPlural.entities.some((e) => e.name === "Case"), "'עורכי דין' (attorneys, plural) alone must match Case");

  const mascSingular = await provider.generate("אפליקציה למעקב אחרי עורך דין במשרד.");
  assert.ok(mascSingular.entities.some((e) => e.name === "Case"), "'עורך דין' (singular) must still match Case");

  const femPlural = await provider.generate("אפליקציה למעקב אחרי עורכות דין במשרד.");
  assert.ok(femPlural.entities.some((e) => e.name === "Case"), "'עורכות דין' (female attorneys, plural) alone must match Case");

  const femSingular = await provider.generate("אפליקציה למעקב אחרי עורכת דין במשרד.");
  assert.ok(femSingular.entities.some((e) => e.name === "Case"), "'עורכת דין' (female singular) must still match Case");
});

/**
 * Regression test for round 579's finding: InsuranceClaim's Hebrew
 * keyword "פוליסת ביטוח" (insurance policy) had no plural entry. It's
 * the construct-state singular of "פוליסה"; the plural construct
 * "פוליסות ביטוח" replaces the ה with ות mid-word, so "פוליסת" is not a
 * substring of "פוליסות" -- the same ה→ות gap shape round 576 found for
 * "עמותה"/"עמותות". A description using only the plural matched no
 * domain entity at all. The test sentences contain none of
 * InsuranceClaim's other keywords ("insurance claim(s)", "claims
 * processing", "policy holder"/"policyholder", "תביעת ביטוח"/"תביעות
 * ביטוח"), isolating the policy keyword alone.
 */
test("InsuranceClaim's 'פוליסת ביטוח' keyword also matches its plural 'פוליסות ביטוח', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralOnly = await provider.generate("המערכת מנהלת רשימה של פוליסות ביטוח של העסק ומעדכנת אותן כל חודש.");
  assert.ok(
    pluralOnly.entities.some((e) => e.name === "InsuranceClaim"),
    "'פוליסות ביטוח' (insurance policies, plural) alone must match InsuranceClaim",
  );

  const singular = await provider.generate("המערכת מנהלת רשימה של פוליסת ביטוח של העסק ומעדכנת אותה כל חודש.");
  assert.ok(
    singular.entities.some((e) => e.name === "InsuranceClaim"),
    "'פוליסת ביטוח' (singular) must still match InsuranceClaim",
  );
});

/**
 * Regression test for round 580's finding: Property's Hebrew keywords
 * "דירה למכירה"/"דירה להשכרה" (apartment for sale/rent) had no plural
 * entries. The plurals "דירות למכירה"/"דירות להשכרה" replace the ה with
 * ות mid-word, the same construct-state gap shape rounds 576-579 found
 * for "עמותה"/"עמותות", "מוסך"/"מוסכים", "עורך/עורכת דין", and "פוליסת
 * ביטוח". A description using only the plural matched no domain entity
 * at all. The test sentences contain none of Property's other keywords
 * ("property"/"properties", "real estate", "listing(s)", "apartment for
 * rent", "נכס"/"נכסים", "נדל\"ן"), isolating each phrase alone.
 */
test("Property's 'דירה למכירה'/'דירה להשכרה' keywords also match their plurals 'דירות למכירה'/'דירות להשכרה', which aren't substrings of the singulars", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralSale = await provider.generate("האפליקציה מרכזת דירות למכירה בעיר אחת, עם מעקב סטטוס.");
  assert.ok(
    pluralSale.entities.some((e) => e.name === "Property"),
    "'דירות למכירה' (apartments for sale, plural) alone must match Property",
  );

  const singularSale = await provider.generate("האפליקציה מרכזת דירה למכירה אחת בעיר, עם מעקב סטטוס.");
  assert.ok(
    singularSale.entities.some((e) => e.name === "Property"),
    "'דירה למכירה' (singular) must still match Property",
  );

  const pluralRent = await provider.generate("האפליקציה מרכזת דירות להשכרה בעיר אחת, עם מעקב סטטוס.");
  assert.ok(
    pluralRent.entities.some((e) => e.name === "Property"),
    "'דירות להשכרה' (apartments for rent, plural) alone must match Property",
  );

  const singularRent = await provider.generate("האפליקציה מרכזת דירה להשכרה אחת בעיר, עם מעקב סטטוס.");
  assert.ok(
    singularRent.entities.some((e) => e.name === "Property"),
    "'דירה להשכרה' (singular) must still match Property",
  );
});

/**
 * Regression test for round 581's finding: WorkOrder's Hebrew keyword
 * "עבודת תחזוקה" (maintenance job) had no plural entry. The plural
 * "עבודות תחזוקה" replaces the ה with ות mid-word, the same
 * construct-state gap shape rounds 576-580 found for "עמותה", "פוליסת
 * ביטוח", and "דירה למכירה"/"דירה להשכרה". The test sentences contain
 * none of WorkOrder's other keywords ("work order", "field service",
 * "service call", "repair job", "maintenance request", "קריאת
 * שירות"/"קריאות שירות", "טכנאי", "אינסטלטור", "חשמלאי"), isolating the
 * maintenance-job phrase alone.
 */
test("WorkOrder's 'עבודת תחזוקה' keyword also matches its plural 'עבודות תחזוקה', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralOnly = await provider.generate("המערכת עוקבת אחרי עבודות תחזוקה שבוצעו בבניין במהלך השנה.");
  assert.ok(
    pluralOnly.entities.some((e) => e.name === "WorkOrder"),
    "'עבודות תחזוקה' (maintenance jobs, plural) alone must match WorkOrder",
  );

  const singular = await provider.generate("המערכת עוקבת אחרי עבודת תחזוקה אחת שבוצעה בבניין במהלך השנה.");
  assert.ok(
    singular.entities.some((e) => e.name === "WorkOrder"),
    "'עבודת תחזוקה' (singular) must still match WorkOrder",
  );
});

/**
 * Regression test for round 582's finding: MenuItem's Hebrew keyword
 * "בית קפה" (café) had no plural entry. Unlike the other missing-plural
 * fixes (rounds 576-581, all a ה→ות or sofit-letter swap), "בית"'s plural
 * "בתי" is an irregular construct form with a letter-order change, not a
 * suffix -- "בתי קפה" is not a substring superset of "בית קפה" either way.
 * The test sentences contain none of MenuItem's other keywords ("menu",
 * "dish(es)", "food item", "restaurant", "cafe", "מסעדה"/"מסעדות",
 * "תפריט", "מנות"), isolating the café phrase alone.
 */
test("MenuItem's 'בית קפה' keyword also matches its irregular plural 'בתי קפה', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralOnly = await provider.generate("אני רוצה לנהל רשת של בתי קפה בעיר, עם מעקב סטטוס.");
  assert.ok(
    pluralOnly.entities.some((e) => e.name === "MenuItem"),
    "'בתי קפה' (cafés, plural) alone must match MenuItem",
  );

  const singular = await provider.generate("אני רוצה לנהל בית קפה אחד בעיר, עם מעקב סטטוס.");
  assert.ok(
    singular.entities.some((e) => e.name === "MenuItem"),
    "'בית קפה' (singular) must still match MenuItem",
  );
});

/**
 * Regression test for round 583's finding: Course's Hebrew keyword
 * "כיתה" (classroom/class) had no plural entry. Its plural "כיתות"
 * replaces the ה with ות mid-word, the same construct-state gap shape
 * rounds 576-582 found elsewhere in this file. The test sentences
 * contain none of Course's other keywords ("courses", "curriculum",
 * "lesson(s)", "קורס"/"קורסים", "שיעור"/"שיעורים"), isolating the
 * classroom phrase alone.
 */
test("Course's 'כיתה' keyword also matches its plural 'כיתות', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const pluralOnly = await provider.generate("ניהול כיתות בבית ספר, עם מעקב סטטוס.");
  assert.ok(
    pluralOnly.entities.some((e) => e.name === "Course"),
    "'כיתות' (classes, plural) alone must match Course",
  );

  const singular = await provider.generate("ניהול כיתה אחת בבית ספר, עם מעקב סטטוס.");
  assert.ok(
    singular.entities.some((e) => e.name === "Course"),
    "'כיתה' (singular) must still match Course",
  );
});

/**
 * Regression test for round 584's finding: Courier's English keyword
 * "delivery person" had no plural entry. Unlike every other
 * missing-plural fix in this file (rounds 576-583, all Hebrew ה→ות,
 * sofit-letter, or construct-state gaps), this one is English: "person"
 * has the irregular plural "people", a completely different word with
 * zero textual overlap with "person", so "delivery person" is not a
 * substring of "delivery people" either way. The test sentences
 * contain none of Courier's other keywords ("courier", "driver(s)",
 * "שליח"/"שליחים", "נהג"/"נהגים"), isolating the delivery-staff phrase
 * alone.
 */
test("Courier's 'delivery person' keyword also matches its irregular plural 'delivery people', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const plural = await provider.generate(
    "A food delivery app that tracks customers, orders, and delivery people who bring food to customers' homes.",
  );
  assert.ok(
    plural.entities.some((e) => e.name === "Courier"),
    "'delivery people' (plural) alone must match Courier",
  );

  const singular = await provider.generate(
    "A food delivery app that tracks customers, orders, and a delivery person who brings food to customers' homes.",
  );
  assert.ok(
    singular.entities.some((e) => e.name === "Courier"),
    "'delivery person' (singular) must still match Courier",
  );
});

/**
 * Regression test for round 813's finding: Courier's bare "שליח"
 * ("courier"/"messenger") is a literal 4-letter prefix of the
 * construct-state "שליחת" ("sending of ___") -- ordinary, frequent Hebrew
 * phrasing ("שליחת הודעות"/"שליחת חוזים"/"שליחת ניוזלטרים") with nothing
 * to do with delivery drivers -- and of the unrelated noun "שליחות"
 * ("errand(s)"). A description naming only an unrelated "sending X" or
 * "errand" concept spuriously matched Courier. The test sentences
 * deliberately avoid every other Courier keyword ("courier", "driver(s)",
 * "delivery person(s)", "שליחים", "נהג"/"נהגים") so the assertion isolates
 * "שליח" alone. Deliberately does NOT test bare "שליחה" (which can
 * legitimately mean "female courier") -- this fix only excludes the ת/ו
 * continuations that are never a real courier reference.
 */
test("Courier's 'שליח' keyword doesn't spuriously match inside 'שליחת' (sending of) or 'שליחות' (errand)", async () => {
  const provider = new HeuristicSpecProvider();

  const sendingContracts = await provider.generate("אפליקציה לשליחת חוזים לחתימה דיגיטלית.");
  assert.ok(
    !sendingContracts.entities.some((e) => e.name === "Courier"),
    "'שליחת חוזים' (sending contracts) alone must not spuriously match Courier via the bare 'שליח' substring",
  );

  const errands = await provider.generate("אפליקציה למעקב אחרי שליחויות ברחבי העיר.");
  assert.ok(
    !errands.entities.some((e) => e.name === "Courier"),
    "'שליחויות' (errands) alone must not spuriously match Courier via the bare 'שליח' substring",
  );

  // The real word still works on its own (this description avoids every
  // other Courier keyword, so a match here can only come from a
  // standalone "שליח" not followed by "ת"/"ו").
  const realCourier = await provider.generate("אפליקציה למעקב אחרי שליח שמחלק חבילות ללקוחות בעיר.");
  assert.ok(realCourier.entities.some((e) => e.name === "Courier"), "a standalone 'שליח' (courier) must still add the Courier entity");
});

/**
 * Regression test for round 585's finding: Rental's Hebrew construct-state
 * keyword "השכרת ציוד" (equipment rental) had no plural entry. Its plural
 * "השכרות ציוד" swaps the word-final ת for ות mid-word, the same
 * construct-state gap shape rounds 576-584 already found elsewhere in this
 * file. The test sentence contains none of Rental's other keywords, nor
 * any other entity's keyword, isolating the equipment-rental phrase alone.
 */
test("Rental's 'השכרת ציוד' keyword also matches its plural 'השכרות ציוד', which isn't a substring of the singular", async () => {
  const provider = new HeuristicSpecProvider();

  const plural = await provider.generate(
    "העסק שלנו מתמחה בהשכרות ציוד בניה ללקוחות פרטיים ועסקיים, עם מעקב סטטוס.",
  );
  assert.ok(
    plural.entities.some((e) => e.name === "Rental"),
    "'השכרות ציוד' (plural) alone must match Rental",
  );

  const singular = await provider.generate(
    "העסק שלנו מתמחה בהשכרת ציוד בניה ללקוחות פרטיים ועסקיים, עם מעקב סטטוס.",
  );
  assert.ok(
    singular.entities.some((e) => e.name === "Rental"),
    "'השכרת ציוד' (singular) must still match Rental",
  );
});
