import assert from "node:assert/strict";
import { test } from "node:test";
import { ProductSpecSchema } from "@forge/shared";
import { isHebrewText } from "./domainEntities.js";
import { TEMPLATES } from "./templates.js";

test("every template exposes a schema-valid ProductSpec, in both languages", () => {
  for (const template of TEMPLATES) {
    const result = ProductSpecSchema.safeParse(template.spec);
    assert.ok(result.success, `template "${template.id}" has an invalid spec: ${!result.success ? JSON.stringify(result.error.issues) : ""}`);
    const resultEn = ProductSpecSchema.safeParse(template.specEn);
    assert.ok(resultEn.success, `template "${template.id}" has an invalid specEn: ${!resultEn.success ? JSON.stringify(resultEn.error.issues) : ""}`);
  }
});

/**
 * Round 492's finding: `/projects/from-template`'s own doc comment says
 * `lang` was designed to pick a whole language, but only ever translated
 * the template's name/description -- `spec` (the actual entities/fields a
 * project is built from) stayed Hebrew-only even when `lang: "en"` was
 * requested. `specEn` fixes that, but only if it genuinely describes the
 * *same* entities as `spec` (same names, field names, types, relationTo,
 * enumValues) with just the display text swapped -- otherwise an English
 * pick could silently diverge in shape from its Hebrew counterpart.
 */
test("spec and specEn describe the exact same entity/field shape, with only display text differing", () => {
  for (const template of TEMPLATES) {
    assert.deepEqual(
      template.spec.entities.map((e) => e.name),
      template.specEn.entities.map((e) => e.name),
      `template "${template.id}": spec and specEn must declare entities in the same order with the same names`,
    );
    for (let i = 0; i < template.spec.entities.length; i++) {
      const he = template.spec.entities[i];
      const en = template.specEn.entities[i];
      assert.ok(he.label && he.label.trim().length > 0, `template "${template.id}" entity "${he.name}" is missing a Hebrew label`);
      assert.ok(en.label && en.label.trim().length > 0, `template "${template.id}" entity "${he.name}" is missing an English label`);
      assert.notEqual(en.label, he.label, `template "${template.id}" entity "${he.name}": specEn's label must actually differ from spec's`);
      assert.deepEqual(
        en.fields.map((f) => [f.name, f.type, f.relationTo ?? null, "enumValues" in f ? f.enumValues : null]),
        he.fields.map((f) => [f.name, f.type, f.relationTo ?? null, "enumValues" in f ? f.enumValues : null]),
        `template "${template.id}" entity "${he.name}": specEn's fields must match spec's fields (name/type/relationTo/enumValues), with only labels differing`,
      );
      for (let j = 0; j < he.fields.length; j++) {
        const heField = he.fields[j];
        const enField = en.fields[j];
        assert.ok(enField.label && enField.label.trim().length > 0, `template "${template.id}" entity "${he.name}" field "${heField.name}" is missing an English label`);
        if ("enumLabels" in heField && heField.enumLabels) {
          assert.ok("enumLabels" in enField && enField.enumLabels, `template "${template.id}" entity "${he.name}" field "${heField.name}" is missing English enumLabels`);
          assert.deepEqual(
            Object.keys(enField.enumLabels as Record<string, string>).sort(),
            Object.keys(heField.enumLabels as Record<string, string>).sort(),
            `template "${template.id}" entity "${he.name}" field "${heField.name}": specEn's enumLabels keys must match spec's`,
          );
        }
      }
    }
  }
});

test("template ids are unique", () => {
  const ids = TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids, [...new Set(ids)]);
});

test("every template has non-empty Hebrew and English display text", () => {
  for (const template of TEMPLATES) {
    assert.ok(template.name.trim().length > 0, `template "${template.id}" is missing an English name`);
    assert.ok(template.nameHe.trim().length > 0, `template "${template.id}" is missing a Hebrew name`);
    assert.ok(template.description.trim().length > 0, `template "${template.id}" is missing an English description`);
    assert.ok(template.descriptionHe.trim().length > 0, `template "${template.id}" is missing a Hebrew description`);
    assert.ok(template.icon.trim().length > 0, `template "${template.id}" is missing an icon`);
  }
});

/**
 * Round 513's finding: the "Appointments & Clients" template's Appointment.date
 * field was labeled "תאריך ושעה"/"Date & Time" even though no field "type" in
 * this whole system (see @forge/shared's FieldType) captures a time-of-day --
 * `type: "date"` renders as a plain browser <input type="date">
 * (apps/web/src/EntityPanel.tsx) and stores as a date-only TEXT column
 * (packages/db/src/migrate.ts's sqlTypeFor). A curated template's label
 * promising a capability the field type can never deliver is a one-click,
 * permanent user-facing lie, not a one-off AI-generated mistake -- generalized
 * here so any future "date" field whose label claims a time component gets
 * caught immediately, not just this one template's one field.
 */
test("no \"date\"-type field's label claims a time-of-day capability the field can't actually hold", () => {
  const TIME_CLAIM_HINTS_HE = ["ושעה", "שעה "];
  const TIME_CLAIM_HINTS_EN = ["time", "& time"];
  for (const template of TEMPLATES) {
    for (const entity of template.spec.entities) {
      for (const field of entity.fields) {
        if (field.type !== "date") continue;
        const labelLower = field.label.toLowerCase();
        for (const hint of TIME_CLAIM_HINTS_HE) {
          assert.ok(
            !field.label.includes(hint),
            `template "${template.id}" entity "${entity.name}" field "${field.name}": Hebrew label "${field.label}" claims a time component but type:"date" has no time-of-day support`,
          );
        }
        for (const hint of TIME_CLAIM_HINTS_EN) {
          assert.ok(
            !labelLower.includes(hint),
            `template "${template.id}" entity "${entity.name}" field "${field.name}": label "${field.label}" claims a time component but type:"date" has no time-of-day support`,
          );
        }
      }
    }
    for (const entity of template.specEn.entities) {
      for (const field of entity.fields) {
        if (field.type !== "date") continue;
        const labelLower = field.label.toLowerCase();
        for (const hint of TIME_CLAIM_HINTS_EN) {
          assert.ok(
            !labelLower.includes(hint),
            `template "${template.id}" entity "${entity.name}" field "${field.name}": English label "${field.label}" claims a time component but type:"date" has no time-of-day support`,
          );
        }
      }
    }
  }
});

test("every relation field's relationTo names an entity that actually exists in the same template", () => {
  for (const template of TEMPLATES) {
    const entityNames = new Set(template.spec.entities.map((e) => e.name));
    for (const entity of template.spec.entities) {
      for (const field of entity.fields) {
        if (field.type === "relation") {
          assert.ok(
            field.relationTo && entityNames.has(field.relationTo),
            `template "${template.id}" entity "${entity.name}" field "${field.name}" relates to missing entity "${field.relationTo}"`,
          );
        }
      }
    }
  }
});

/**
 * Round 1273's finding: the CRM template's own Task entity gave it only a
 * bare boolean "done" field, unlike (a) domainEntities.ts's real Task
 * domain rule (keywords include "tasks"/"משימות", which the CRM template's
 * own summary text literally contains -- "...follow-up tasks"/"משימות
 * מעקב" -- so an equivalent from-scratch description would trigger it),
 * which always gives Task a required status enum (Todo/InProgress/Done),
 * and (b) this same templates.ts file's own Project Tracker template,
 * whose Task entity already uses a required status enum (todo/inprogress/
 * done) instead of a plain boolean. A "done" boolean can't represent "in
 * progress," so a CRM Task genuinely lost workflow fidelity compared to
 * both the heuristic/AI path and this codebase's own sibling template.
 */
test("the CRM template's Task entity has a real status enum, not just a boolean, matching the Project Tracker template's own established convention", () => {
  const crmTemplate = TEMPLATES.find((t) => t.id === "crm");
  assert.ok(crmTemplate, "expected a \"crm\" template to exist");

  const task = crmTemplate!.spec.entities.find((e) => e.name === "Task");
  assert.ok(task, "expected the CRM template to have a Task entity");
  assert.equal(task!.fields.some((f) => f.name === "done" && f.type === "boolean"), false, "the CRM Task entity must no longer use a plain boolean \"done\" field");
  const status = task!.fields.find((f) => f.name === "status");
  assert.ok(status, "expected the CRM Task entity to have a status field");
  assert.equal(status!.type, "enum");
  assert.equal(status!.required, true);
  assert.ok(status!.enumValues && status!.enumValues.length >= 2, "expected the status field to have at least 2 enum values");

  const taskEn = crmTemplate!.specEn.entities.find((e) => e.name === "Task");
  assert.ok(taskEn, "expected the CRM specEn to have a Task entity");
  const statusEn = taskEn!.fields.find((f) => f.name === "status");
  assert.ok(statusEn, "expected the CRM specEn Task entity to have a status field");
  assert.equal(statusEn!.type, "enum");
  assert.equal(statusEn!.required, true);
});

/**
 * Round 1274's finding: the same "curated template vs. its own matching
 * domain rule" gap round 1273 just fixed for CRM's Task entity, in a
 * sibling template round 1273's own closing note explicitly left
 * unaudited. The Volunteer & Shift Management template's Volunteer entity
 * gave it only name/phone/email/skills -- no status at all -- unlike
 * domainEntities.ts's real Volunteer domain rule (keywords include
 * "volunteer management"/"מתנדבים", which this template's own summary
 * text literally contains -- "A volunteer management system..."/"מערכת
 * לניהול מתנדבים..." -- so an equivalent from-scratch description would
 * trigger it), which always gives Volunteer a required status enum
 * (Active/Inactive) plus role/joinedDate. Without a status field, a
 * volunteer org can't distinguish active from inactive volunteers at all
 * in the generated app -- no status filter, board view, or automation
 * trigger is possible on a field that doesn't exist.
 */
test("the Volunteer template's Volunteer entity has a real status enum, matching domainEntities.ts's own matching domain rule", () => {
  const volunteersTemplate = TEMPLATES.find((t) => t.id === "volunteers");
  assert.ok(volunteersTemplate, "expected a \"volunteers\" template to exist");

  const volunteer = volunteersTemplate!.spec.entities.find((e) => e.name === "Volunteer");
  assert.ok(volunteer, "expected the Volunteer template to have a Volunteer entity");
  const status = volunteer!.fields.find((f) => f.name === "status");
  assert.ok(status, "expected the Volunteer entity to have a status field");
  assert.equal(status!.type, "enum");
  assert.equal(status!.required, true);
  assert.ok(status!.enumValues && status!.enumValues.length >= 2, "expected the status field to have at least 2 enum values");

  const volunteerEn = volunteersTemplate!.specEn.entities.find((e) => e.name === "Volunteer");
  assert.ok(volunteerEn, "expected the Volunteer specEn to have a Volunteer entity");
  const statusEn = volunteerEn!.fields.find((f) => f.name === "status");
  assert.ok(statusEn, "expected the Volunteer specEn entity to have a status field");
  assert.equal(statusEn!.type, "enum");
  assert.equal(statusEn!.required, true);
});

/**
 * Round 1275's finding: continuing the exact round 1273/1274 "curated
 * template vs. its own matching domain rule" lead. The Project Tracker
 * template's own Project entity (name/description/status/owner) was
 * missing the `deadline` (date) and `budget` (number) fields that
 * domainEntities.ts's real Project domain rule (keywords
 * /\bproject(s)?\b/, "פרויקט"/"פרויקטים") always produces -- and this
 * template's own summary text literally contains the matching phrase
 * ("A project tracking system..."/"מערכת למעקב פרויקטים..."), so an
 * equivalent from-scratch description would trigger the rule and get
 * both fields. Unlike rounds 1273/1274 (a missing REQUIRED status enum),
 * this template's `status` was already present and correctly shaped --
 * the gap here is specifically the two missing optional fields, so a
 * template literally named "Project Tracker" had no way to record a
 * project's own deadline or budget at all.
 */
test("the Project Tracker template's Project entity has deadline and budget fields, matching domainEntities.ts's own matching domain rule", () => {
  const projectTrackerTemplate = TEMPLATES.find((t) => t.id === "project-tracker");
  assert.ok(projectTrackerTemplate, "expected a \"project-tracker\" template to exist");

  const project = projectTrackerTemplate!.spec.entities.find((e) => e.name === "Project");
  assert.ok(project, "expected the Project Tracker template to have a Project entity");
  const deadline = project!.fields.find((f) => f.name === "deadline");
  assert.ok(deadline, "expected the Project entity to have a deadline field");
  assert.equal(deadline!.type, "date");
  const budget = project!.fields.find((f) => f.name === "budget");
  assert.ok(budget, "expected the Project entity to have a budget field");
  assert.equal(budget!.type, "number");

  const projectEn = projectTrackerTemplate!.specEn.entities.find((e) => e.name === "Project");
  assert.ok(projectEn, "expected the Project Tracker specEn to have a Project entity");
  const deadlineEn = projectEn!.fields.find((f) => f.name === "deadline");
  assert.ok(deadlineEn, "expected the Project specEn entity to have a deadline field");
  assert.equal(deadlineEn!.type, "date");
  const budgetEn = projectEn!.fields.find((f) => f.name === "budget");
  assert.ok(budgetEn, "expected the Project specEn entity to have a budget field");
  assert.equal(budgetEn!.type, "number");
});

/**
 * Round 1282's finding: round 1275's own closing note claimed it checked
 * "Customer/Order/Service/Appointment/MenuItem/Product across Restaurant,
 * Appointments, and Inventory" against their own matching domainEntities.ts
 * domain rules and found no concretely-verified gap of this shape -- but
 * that appears to have been an oversight for exactly this template's own
 * Service and Appointment entities. domainEntities.ts's real Service domain
 * rule (keywords /\bservice(s)?\b/, "שירות") always also produces a
 * `description` (longtext) field, and its real Appointment domain rule
 * (keywords "appointment", /\bbookings?\b/, "תורים") always also produces a
 * `notes` (longtext) field -- both present in this template's own
 * name/summary text, so an equivalent from-scratch description would
 * trigger both rules and get both fields. The Appointments & Clients
 * template's own Service/Appointment entities never had either.
 */
test("the Appointments & Clients template's Service entity has a description field, and its Appointment entity has a notes field, matching domainEntities.ts's own matching domain rules", () => {
  const appointmentsTemplate = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointmentsTemplate, "expected an \"appointments\" template to exist");

  const service = appointmentsTemplate!.spec.entities.find((e) => e.name === "Service");
  assert.ok(service, "expected the Appointments & Clients template to have a Service entity");
  const description = service!.fields.find((f) => f.name === "description");
  assert.ok(description, "expected the Service entity to have a description field");
  assert.equal(description!.type, "longtext");

  const appointment = appointmentsTemplate!.spec.entities.find((e) => e.name === "Appointment");
  assert.ok(appointment, "expected the Appointments & Clients template to have an Appointment entity");
  const notes = appointment!.fields.find((f) => f.name === "notes");
  assert.ok(notes, "expected the Appointment entity to have a notes field");
  assert.equal(notes!.type, "longtext");

  const serviceEn = appointmentsTemplate!.specEn.entities.find((e) => e.name === "Service");
  assert.ok(serviceEn, "expected the Appointments & Clients specEn to have a Service entity");
  const descriptionEn = serviceEn!.fields.find((f) => f.name === "description");
  assert.ok(descriptionEn, "expected the Service specEn entity to have a description field");
  assert.equal(descriptionEn!.type, "longtext");

  const appointmentEn = appointmentsTemplate!.specEn.entities.find((e) => e.name === "Appointment");
  assert.ok(appointmentEn, "expected the Appointments & Clients specEn to have an Appointment entity");
  const notesEn = appointmentEn!.fields.find((f) => f.name === "notes");
  assert.ok(notesEn, "expected the Appointment specEn entity to have a notes field");
  assert.equal(notesEn!.type, "longtext");
});

/**
 * Round 1288: the exact same "curated template vs. its own matching domain
 * rule" gap class as the test above, for Inventory & Products' own Supplier
 * entity. domainEntities.ts's real Vendor domain rule (keywords "vendor",
 * "supplier", "suppliers", "procurement", "ספקים", "רכש") always also
 * produces a `contactPerson` (text) field and a required `category` enum
 * -- both generically meaningful for any supplier, with no semantic
 * mismatch the way the Vendor rule's other sibling fields might have for a
 * non-procurement "customer" concept. This template's own summary text
 * literally says "ספקים"/"suppliers" and "רכש"/"procurement", so an
 * equivalent from-scratch description would trigger this exact rule and
 * get both fields. The Inventory & Products template's own Supplier entity
 * never had either.
 */
test("the Inventory & Products template's Supplier entity has contactPerson and category fields, matching domainEntities.ts's own matching Vendor domain rule", () => {
  const inventoryTemplate = TEMPLATES.find((t) => t.id === "inventory");
  assert.ok(inventoryTemplate, "expected an \"inventory\" template to exist");

  const supplier = inventoryTemplate!.spec.entities.find((e) => e.name === "Supplier");
  assert.ok(supplier, "expected the Inventory & Products template to have a Supplier entity");
  const contactPerson = supplier!.fields.find((f) => f.name === "contactPerson");
  assert.ok(contactPerson, "expected the Supplier entity to have a contactPerson field");
  assert.equal(contactPerson!.type, "text");
  const category = supplier!.fields.find((f) => f.name === "category");
  assert.ok(category, "expected the Supplier entity to have a category field");
  assert.equal(category!.type, "enum");
  assert.equal(category!.required, true);

  const supplierEn = inventoryTemplate!.specEn.entities.find((e) => e.name === "Supplier");
  assert.ok(supplierEn, "expected the Inventory & Products specEn to have a Supplier entity");
  const contactPersonEn = supplierEn!.fields.find((f) => f.name === "contactPerson");
  assert.ok(contactPersonEn, "expected the Supplier specEn entity to have a contactPerson field");
  assert.equal(contactPersonEn!.type, "text");
  const categoryEn = supplierEn!.fields.find((f) => f.name === "category");
  assert.ok(categoryEn, "expected the Supplier specEn entity to have a category field");
  assert.equal(categoryEn!.type, "enum");
  assert.equal(categoryEn!.required, true);
});

/**
 * Round 516's finding: the "Appointments & Clients" template's Hebrew
 * Appointment.status enum mapped "scheduled" to "קבוע" (meaning "fixed" /
 * "permanent" / "standing" in Hebrew), not "scheduled". This codebase
 * already translates this exact concept correctly and consistently
 * elsewhere -- domainEntities.ts's own heuristic Appointment entity uses
 * "מתוכנן" and its WorkOrder entity uses "מתוזמנת" -- and "קבוע" appeared
 * nowhere else in spec-engine, confirming it was an isolated mistranslation,
 * not an intentional alternate wording. A Hebrew-UI user booking a one-off
 * appointment would see its status rendered as "standing/recurring", a
 * materially different and misleading meaning.
 */
test("the Appointments template's Hebrew status enum doesn't mistranslate \"scheduled\" as \"recurring/standing\"", () => {
  const appointmentsTemplate = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointmentsTemplate, "expected an \"appointments\" template to exist");
  const appointmentEntity = appointmentsTemplate!.spec.entities.find((e) => e.name === "Appointment");
  assert.ok(appointmentEntity, "expected the Appointments template to declare an Appointment entity");
  const statusField = appointmentEntity!.fields.find((f) => f.name === "status");
  assert.ok(statusField && "enumLabels" in statusField && statusField.enumLabels, "expected Appointment.status to have enumLabels");
  const scheduledLabel = (statusField as { enumLabels: Record<string, string> }).enumLabels.scheduled;
  assert.notEqual(scheduledLabel, "קבוע", "\"scheduled\" must not be mistranslated as \"קבוע\" (fixed/permanent/standing)");
  assert.equal(scheduledLabel, "מתוכנן", "\"scheduled\" should match this codebase's own established translation (domainEntities.ts's Appointment entity)");
});

/**
 * Round 517's finding: every template's `roles` array was plain English,
 * reused byte-for-byte between the Hebrew `spec` and the English `specEn`
 * -- unlike every other display field (entity/field labels, enumLabels,
 * summary), which already has a real Hebrew/English split. heuristic.ts's
 * own matchRoles() already translates roles to Hebrew via ROLE_RULES's
 * labelHe when isHebrew is true, so templates were the one spec-generation
 * path that skipped this established convention. A Hebrew-UI user picking
 * any template (POST /projects/from-template) saw English role chips (e.g.
 * "Manager", "Staff") on the otherwise fully-Hebrew spec review screen
 * (apps/web/src/App.tsx's spec.roles.heading section).
 */
test("every template's Hebrew spec.roles are genuinely Hebrew, not reused English strings from specEn", () => {
  for (const template of TEMPLATES) {
    assert.ok(template.spec.roles.length > 0, `template "${template.id}" has an empty roles array`);
    assert.deepEqual(
      template.spec.roles.length,
      template.specEn.roles.length,
      `template "${template.id}": spec and specEn must declare the same number of roles`,
    );
    for (const role of template.spec.roles) {
      assert.ok(isHebrewText(role), `template "${template.id}": Hebrew spec.roles contains a non-Hebrew role "${role}"`);
    }
    assert.notDeepEqual(
      template.spec.roles,
      template.specEn.roles,
      `template "${template.id}": spec.roles must not be byte-identical to specEn.roles`,
    );
  }
});

/**
 * Round 1028's finding: screensFor() used to emit Dashboard plus one
 * "list" screen per entity (screens.length === entities.length + 1), but
 * heuristic.ts's own buildScreens() emits Dashboard plus a List+Form PAIR
 * per entity (screens.length === 2*entities.length + 1) for the exact
 * same real app shape -- `spec.screens` has no effect on what's actually
 * built (apps/api/src/pipeline.ts and codegen.ts never read it at all),
 * it's purely Time Machine/History display metadata, and both
 * HistoryPanel.tsx and checkpointDiff.ts display/export that count under
 * the explicit assumption that every generator follows the List+Form-pair
 * convention. A project built from a template showed roughly half the "N
 * screens" figure of an otherwise-identical heuristic-built project with
 * the same entities.
 */
/**
 * Round 1248's finding: `spec()` (templates.ts) hardcoded `openQuestions:
 * []` for every template, unlike a heuristic- or AI-generated spec with
 * the identical business shape, which always surfaces a payment-provider
 * open question when the generated entities include a billing entity
 * (heuristic.ts's own BILLING_ENTITY_NAMES/buildOpenQuestions). Answering
 * an open question is a real, functional decision point (POST
 * /projects/:id/answers genuinely re-generates the spec), unlike
 * `screens` (round 1028's own finding: purely display metadata) -- so a
 * Templates Gallery user reached no way to even surface the
 * payment-provider decision for a template whose entities are the exact
 * same shape (MenuItem with a required price field, Order) a from-scratch
 * "restaurant with a menu and orders" description would get it for.
 */
test("the Restaurant template (the one template with a billing entity -- MenuItem/Order) surfaces the same payment-provider open question heuristic.ts generates for an identical business shape, in both languages", () => {
  const restaurant = TEMPLATES.find((t) => t.id === "restaurant");
  assert.ok(restaurant, "expected a \"restaurant\" template to exist");
  assert.equal(restaurant!.spec.openQuestions.length, 1, "expected exactly one open question for the Hebrew spec");
  assert.equal(restaurant!.spec.openQuestions[0].question, "באיזה ספק תשלומים כדאי להשתמש?");
  assert.deepEqual(restaurant!.spec.openQuestions[0].options, ["Stripe", "PayPal", "בלי תשלומים", "תחליטו בשבילי"]);
  assert.equal(restaurant!.spec.openQuestions[0].recommendation, "Stripe");

  assert.equal(restaurant!.specEn.openQuestions.length, 1, "expected exactly one open question for the English specEn");
  assert.equal(restaurant!.specEn.openQuestions[0].question, "Which payment provider should this use?");
  assert.deepEqual(restaurant!.specEn.openQuestions[0].options, ["Stripe", "PayPal", "No payments", "Decide for me"]);
  assert.equal(restaurant!.specEn.openQuestions[0].recommendation, "Stripe");
});

/**
 * Round 1271's finding: round 1248's own paymentOpenQuestion early-returned
 * `[]` for any template with no billing entity, but heuristic.ts's real
 * buildOpenQuestions has no such early return -- it unconditionally
 * returns a 1-element array always, just varying the question text/
 * recommendation by needsPayments (confirmed by running
 * HeuristicSpecProvider.generate() against description text matching
 * these templates' own business shape). Since App.tsx gates the whole
 * Open Questions section on `.length > 0`, these 5 templates permanently
 * lost a real decision point (POST /projects/:id/answers genuinely
 * re-generates the spec from an answer) that an equivalent from-scratch
 * description always gets. This replaces the old "still gets an empty
 * array" test above, which had itself only verified the BILLING_ENTITY_NAMES
 * membership check, not whether buildOpenQuestions ever actually returns
 * `[]` for any input (it doesn't).
 */
test("a template with no billing entity (e.g. the CRM/Project Tracker/Volunteer/Appointments/Inventory templates) still gets the same always-present payment open question heuristic.ts generates for an identical business shape, in both languages", () => {
  for (const template of TEMPLATES) {
    if (template.id === "restaurant") continue;
    assert.equal(template.spec.openQuestions.length, 1, `template "${template.id}" must get the always-present payment open question like a from-scratch description would`);
    assert.equal(template.spec.openQuestions[0].question, "האם האפליקציה צריכה לקבל תשלומים?");
    assert.deepEqual(template.spec.openQuestions[0].options, ["Stripe", "PayPal", "בלי תשלומים", "תחליטו בשבילי"]);
    assert.equal(template.spec.openQuestions[0].recommendation, "בלי תשלומים");

    assert.equal(template.specEn.openQuestions.length, 1, `template "${template.id}" must get the always-present payment open question like a from-scratch description would`);
    assert.equal(template.specEn.openQuestions[0].question, "Does this application need to accept payments?");
    assert.deepEqual(template.specEn.openQuestions[0].options, ["Stripe", "PayPal", "No payments", "Decide for me"]);
    assert.equal(template.specEn.openQuestions[0].recommendation, "No payments");
  }
});

/**
 * Round 1257's finding: `spec()` (templates.ts) hardcoded `assumptions:
 * []` for every template, the exact same kind of gap round 1248 just
 * closed for `openQuestions` -- a heuristic- or AI-generated spec always
 * gets 3 real assumption strings (heuristic.ts's own buildAssumptions)
 * explaining the generic engine, the real auth/collaboration model, and
 * that only WhatsApp (not other integrations) is actually wired up, but
 * every template silently skipped all three. App.tsx renders the
 * "Assumptions" heading unconditionally (unlike `openQuestions`, which IS
 * gated on `.length > 0`), so a template user saw a bare heading with no
 * list and none of that explanatory text.
 */
test("every template's spec and specEn carry the same 3 assumptions heuristic.ts's own buildAssumptions always generates, in the matching language", () => {
  const heAssumptions = [
    "האפליקציה בנויה כרגע על מנוע גנרי משותף עם בסיס נתונים אמיתי — לא קוד ייעודי מלא לכל פרויקט.",
    "יש כניסה אמיתית למשתמשים (הרשמה+סיסמה), ואפשר להזמין משתמשים קיימים כשותפים לאותו פרויקט עם הרשאת \"עורך/ת\" (גישה מלאה) או \"צפייה בלבד\" שנאכפת בפועל על כל שינוי — רק הבעלים יכול לנהל מי מוזמן או לשנות את ההרשאה של שותף.",
    "חיבור וואטסאפ אמיתי קיים לכל פרויקט (סריקת QR, הודעות נכנסות/יוצאות, הפעלת אוטומציות) — אך כל אינטגרציה אחרת שהוזכרה בתיאור (תשלומים וכו') עדיין לא מחוברת בפועל, ראו את השאלות הפתוחות למטה.",
  ];
  const enAssumptions = [
    "Using a generic schema-driven CRUD engine backed by SQLite for this Phase 1 slice, not a dedicated generated codebase per project yet.",
    "Real signup/login authentication exists, and the project owner can invite existing users as collaborators on the same project with either \"editor\" (full access) or \"viewer\" (read-only) permission, enforced on every change — only the owner can manage who else is invited or change their role.",
    "A real WhatsApp Web connection is available for every project (QR-code linking, inbound/outbound messages, automation triggers) — but any other integration mentioned in the description (payments, etc.) is not wired up yet, see open questions and the product roadmap.",
  ];
  for (const template of TEMPLATES) {
    assert.deepEqual(template.spec.assumptions, heAssumptions, `template "${template.id}"'s Hebrew spec must carry the same generic-engine assumptions every other generation path gets`);
    assert.deepEqual(template.specEn.assumptions, enAssumptions, `template "${template.id}"'s English specEn must carry the same generic-engine assumptions every other generation path gets`);
  }
});

test("the Restaurant template composes correctly: it gets the new assumptions AND still keeps round 1248's own payment-provider open question", () => {
  const restaurant = TEMPLATES.find((t) => t.id === "restaurant");
  assert.ok(restaurant, "expected a \"restaurant\" template to exist");
  assert.equal(restaurant!.spec.assumptions.length, 3, "the payment-related open question must not suppress or alter the generic assumptions");
  assert.equal(restaurant!.spec.openQuestions.length, 1, "the new assumptions must not suppress or alter the existing payment-provider open question");
});

/**
 * Round 1266's finding: `spec()` (templates.ts) hardcoded `personas: []`
 * for every template, the third sibling in the same parity family rounds
 * 1248 (openQuestions) and 1257 (assumptions) already closed -- a
 * heuristic- or AI-generated spec with the identical roles always gets
 * real personas (heuristic.ts's own `roles.map(...)` 1:1 derivation), but
 * every template silently skipped it. App.tsx renders the "Who uses this
 * app" (personas) heading unconditionally, the same unconditional-render
 * shape round 1257's own finding already flagged for assumptions.
 */
test("every template's spec and specEn carry personas derived 1:1 from its own roles, in the matching language, exactly like heuristic.ts's own provider", () => {
  for (const template of TEMPLATES) {
    const expectedHe = template.spec.roles.map((r) => `משתמש/ת מסוג ${r}`);
    const expectedEn = template.specEn.roles.map((r) => `${r} user`);
    assert.deepEqual(template.spec.personas, expectedHe, `template "${template.id}"'s Hebrew spec must carry personas derived 1:1 from its own roles`);
    assert.deepEqual(template.specEn.personas, expectedEn, `template "${template.id}"'s English specEn must carry personas derived 1:1 from its own roles`);
  }
});

test("every template's screen count matches heuristic.ts's own Dashboard-plus-List+Form-pair-per-entity convention", () => {
  for (const template of TEMPLATES) {
    const expected = 2 * template.spec.entities.length + 1;
    assert.equal(
      template.spec.screens.length,
      expected,
      `template "${template.id}": expected ${expected} screens (Dashboard + a List/Form pair per entity), got ${template.spec.screens.length}`,
    );
    assert.equal(template.spec.screens[0].type, "dashboard", `template "${template.id}": the first screen must be the Dashboard`);
    for (const entity of template.spec.entities) {
      assert.ok(
        template.spec.screens.some((s) => s.type === "list" && s.entity === entity.name),
        `template "${template.id}": expected a "list" screen for entity "${entity.name}"`,
      );
      assert.ok(
        template.spec.screens.some((s) => s.type === "form" && s.entity === entity.name),
        `template "${template.id}": expected a "form" screen for entity "${entity.name}"`,
      );
    }
  }
});
