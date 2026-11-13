import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
 * Round 1705: found via live browser testing -- building the Appointments &
 * Clients template and opening its Appointment tab shows every seeded
 * Appointment row with a blank Customer, blank Staff Member, and blank
 * Service, even though real Customer/Staff/Service rows exist two tabs
 * away. Same shape and same root cause as round 1704's Restaurant Order
 * fix (seed.ts's seedValueFor only guesses row 1 for a REQUIRED relation),
 * just with all three of this entity's relations missing `required`
 * instead of two -- an appointment with no customer, no staff member, and
 * no service isn't a meaningful record.
 */
test("the Appointments & Clients template's Appointment entity marks its customer/staff/service relations required, so seed.ts seeds real ids into all three instead of leaving them blank", () => {
  const appointmentsTemplate = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointmentsTemplate, "expected an \"appointments\" template to exist");

  const appointment = appointmentsTemplate!.spec.entities.find((e) => e.name === "Appointment");
  assert.ok(appointment, "expected the Appointments & Clients template to have an Appointment entity");
  const customer = appointment!.fields.find((f) => f.name === "customer");
  const staff = appointment!.fields.find((f) => f.name === "staff");
  const service = appointment!.fields.find((f) => f.name === "service");
  assert.ok(customer, "expected the Appointment entity to have a customer field");
  assert.ok(staff, "expected the Appointment entity to have a staff field");
  assert.ok(service, "expected the Appointment entity to have a service field");
  assert.equal(customer!.required, true, "an appointment with no customer isn't a meaningful record");
  assert.equal(staff!.required, true, "an appointment with no staff member isn't a meaningful record");
  assert.equal(service!.required, true, "an appointment with no service isn't a meaningful record");

  const appointmentEn2 = appointmentsTemplate!.specEn.entities.find((e) => e.name === "Appointment");
  assert.ok(appointmentEn2, "expected the Appointments & Clients specEn to have an Appointment entity");
  const customerEn = appointmentEn2!.fields.find((f) => f.name === "customer");
  const staffEn = appointmentEn2!.fields.find((f) => f.name === "staff");
  const serviceEn = appointmentEn2!.fields.find((f) => f.name === "service");
  assert.ok(customerEn, "expected the Appointment specEn entity to have a customer field");
  assert.ok(staffEn, "expected the Appointment specEn entity to have a staff field");
  assert.ok(serviceEn, "expected the Appointment specEn entity to have a service field");
  assert.equal(customerEn!.required, true);
  assert.equal(staffEn!.required, true);
  assert.equal(serviceEn!.required, true);
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
 * Round 1289: the sixth and final curated template in the "curated template
 * vs. its own matching domain rule" gap class (CRM's Task, round 1273;
 * Volunteer's Volunteer, 1274; Project Tracker's Project, 1275;
 * Appointments' Service/Appointment, 1282; Inventory's Supplier, 1288).
 * domainEntities.ts's real Order domain rule (keywords /\border(s)?\b/,
 * "הזמנה", "הזמנות") always also produces an `items` (longtext) field --
 * this template's own summary text literally says "הזמנות"/"orders", so an
 * equivalent from-scratch description would trigger this rule and get it.
 * The Restaurant Management template's own Order entity never had it, with
 * no way to record which dishes an order actually contains. The rule's own
 * optional `courierId` relation is correctly NOT ported: a restaurant
 * dine-in order has no courier/delivery concept at all.
 *
 * Round 2009: this comment's own "correctly NOT ported" claim about
 * `courierId` only ever addressed what the STATIC template should look
 * like, not what mergeRefinedSpec does with it on a later refine -- this
 * round found (and fixed, in index.ts's own mergeRefinedSpec, not here)
 * that an unrelated refine of this exact template was silently bolting a
 * dangling `courierId` relation (pointing at a "Courier" entity this
 * template never has) onto every Order record anyway, the same merge
 * vulnerability this file's own Customer/Deal/TeamMember/Staff/Appointment
 * fixes already closed for their own fields. `courierId` is still
 * correctly excluded from the field list below -- the fix there skips
 * merging any relation field whose target entity doesn't exist in either
 * spec being merged, which is the right place to close this specific gap
 * without permanently cluttering every Restaurant project with a Courier
 * picker that can never have anything to point at.
 */
test("the Restaurant Management template's Order entity has an items field, matching domainEntities.ts's own matching Order domain rule", () => {
  const restaurantTemplate = TEMPLATES.find((t) => t.id === "restaurant");
  assert.ok(restaurantTemplate, "expected a \"restaurant\" template to exist");

  const order = restaurantTemplate!.spec.entities.find((e) => e.name === "Order");
  assert.ok(order, "expected the Restaurant Management template to have an Order entity");
  const items = order!.fields.find((f) => f.name === "items");
  assert.ok(items, "expected the Order entity to have an items field");
  assert.equal(items!.type, "longtext");

  const orderEn = restaurantTemplate!.specEn.entities.find((e) => e.name === "Order");
  assert.ok(orderEn, "expected the Restaurant Management specEn to have an Order entity");
  const itemsEn = orderEn!.fields.find((f) => f.name === "items");
  assert.ok(itemsEn, "expected the Order specEn entity to have an items field");
  assert.equal(itemsEn!.type, "longtext");
});

/**
 * Round 2009: found via a live Playwright session surveying every curated
 * template's entities against domainEntities.ts's own matching rules (the
 * same bug class as rounds 1304/1898 (Customer), 1899 (Deal), 1999
 * (TeamMember/Staff), and 2008 (Appointment)) -- the Restaurant Management
 * template's own Order entity exact-name-matches domainEntities.ts's own
 * Order domain rule, whose own `customerName` (text, required) field was
 * missing here by name the whole time, even though round 1289 already
 * ported this same rule's `items` field. Live-reproduced: refining a real
 * build with an unrelated instruction ("Add an isVip field to
 * RestaurantTable") silently added `customerName` (not the requested field)
 * to every Order record. Deliberately left optional, not mirroring the
 * domain rule's `required: true` -- see templates.ts's own comment on this
 * field for why (this entity already has a real, required `customer`
 * relation).
 */
test("the Restaurant Management template's Order entity has a customerName field, matching domainEntities.ts's own Order domain rule", () => {
  const restaurantTemplate = TEMPLATES.find((t) => t.id === "restaurant");
  assert.ok(restaurantTemplate, "expected a \"restaurant\" template to exist");

  const order = restaurantTemplate!.spec.entities.find((e) => e.name === "Order");
  assert.ok(order, "expected the Restaurant Management template to have an Order entity");
  const customerName = order!.fields.find((f) => f.name === "customerName");
  assert.ok(customerName, "expected the Order entity to have a customerName field");
  assert.equal(customerName!.type, "text");
  assert.equal(customerName!.required, false, "deliberately optional -- see templates.ts's own comment on this field");

  const orderEn = restaurantTemplate!.specEn.entities.find((e) => e.name === "Order");
  assert.ok(orderEn, "expected the Restaurant Management specEn to have an Order entity");
  const customerNameEn = orderEn!.fields.find((f) => f.name === "customerName");
  assert.ok(customerNameEn, "expected the Order specEn entity to have a customerName field");
  assert.equal(customerNameEn!.type, "text");
  assert.equal(customerNameEn!.required, false, "deliberately optional -- see templates.ts's own comment on this field");
});

/**
 * Round 2009: the mechanism itself, proven directly against mergeRefinedSpec
 * and the real heuristic generator rather than just pinning the template's
 * own field list -- mirrors round 1999's and round 2008's own identical
 * mechanism tests. Without this, a future change to either the template or
 * the Order domain rule could silently reopen the exact live bug this round
 * fixed (an unrelated refine bolting an unrequested field, or a dangling
 * relation to a nonexistent entity, onto every Order record) with no test
 * catching it. Also exercises index.ts's own new mergeRefinedSpec fix: the
 * candidate's `courierId` field (relationTo "Courier", an entity this
 * template's spec never has) must still be silently skipped, not merged in
 * as a dangling relation.
 */
test("refining a Restaurant Management project with an unrelated instruction mentioning \"orders\" adds no new fields to Order, now that the template already has everything the domain rule would add (and never gains a dangling Courier relation)", async () => {
  const { HeuristicSpecProvider } = await import("./heuristic.js");
  const { mergeRefinedSpec } = await import("./index.js");
  const provider = new HeuristicSpecProvider();

  const restaurant = TEMPLATES.find((t) => t.id === "restaurant")!;
  const combinedDescription = `${restaurant.description}\n\nAdditional requirement: Add an isVip boolean field to RestaurantTable.`;
  const candidate = await provider.generate(combinedDescription, false);
  const merged = mergeRefinedSpec(restaurant.specEn, candidate);
  const orderBefore = new Set(restaurant.specEn.entities.find((e) => e.name === "Order")!.fields.map((f) => f.name));
  const orderAfter = merged.entities.find((e) => e.name === "Order")!.fields.map((f) => f.name);
  for (const name of orderAfter) {
    assert.ok(orderBefore.has(name), `refining Restaurant Management with an unrelated instruction must not add a new Order field, but added "${name}"`);
  }
  assert.ok(!orderAfter.includes("courierId"), "expected courierId to be skipped as a dangling relation to a nonexistent Courier entity");
});

/**
 * Round 1704: found via live browser testing -- building the Restaurant
 * Management template and opening its Order tab shows every seeded Order
 * row with a blank Customer and blank Table, even though real Customer/
 * RestaurantTable rows exist two tabs away. Root cause: Order's own
 * `customer`/`table` relation fields were never marked `required`, unlike
 * this same entity's own `status` field -- seed.ts's `seedValueFor`
 * deliberately (and correctly, per its own test) only guesses row 1 for a
 * REQUIRED relation, leaving an optional one `null` since there's no
 * guaranteed related row to point at. A restaurant order with no customer
 * and no table isn't a meaningful record, so this was a template-authoring
 * oversight, not the same deliberate choice `seedValueFor` itself encodes.
 */
test("the Restaurant Management template's Order entity marks its customer/table relations required, so seed.ts seeds real ids into both instead of leaving them blank", () => {
  const restaurantTemplate = TEMPLATES.find((t) => t.id === "restaurant");
  assert.ok(restaurantTemplate, "expected a \"restaurant\" template to exist");

  const order = restaurantTemplate!.spec.entities.find((e) => e.name === "Order");
  assert.ok(order, "expected the Restaurant Management template to have an Order entity");
  const customer = order!.fields.find((f) => f.name === "customer");
  const table = order!.fields.find((f) => f.name === "table");
  assert.ok(customer, "expected the Order entity to have a customer field");
  assert.ok(table, "expected the Order entity to have a table field");
  assert.equal(customer!.required, true, "a restaurant order with no customer isn't a meaningful record");
  assert.equal(table!.required, true, "a restaurant order with no table isn't a meaningful record");

  const orderEn = restaurantTemplate!.specEn.entities.find((e) => e.name === "Order");
  assert.ok(orderEn, "expected the Restaurant Management specEn to have an Order entity");
  const customerEn = orderEn!.fields.find((f) => f.name === "customer");
  const tableEn = orderEn!.fields.find((f) => f.name === "table");
  assert.ok(customerEn, "expected the Order specEn entity to have a customer field");
  assert.ok(tableEn, "expected the Order specEn entity to have a table field");
  assert.equal(customerEn!.required, true);
  assert.equal(tableEn!.required, true);
});

/**
 * Round 1294: the same "curated template entity is missing a field every
 * sibling entity of the identical shape already has" pattern as rounds
 * 1271-1289, found in three more places after those six templates were
 * each independently closed. Inventory & Products' own PurchaseOrder
 * entity (a "purchase placed with a party, tracked by status/total") is
 * the exact same shape as the Restaurant template's own Order entity
 * (fixed in round 1289) and domainEntities.ts's own generic Order rule --
 * both of which already carry an `items` field -- but PurchaseOrder never
 * had one, leaving no way to record which products or quantities a
 * purchase order actually covers.
 */
test("the Inventory & Products template's PurchaseOrder entity has an items field, matching the Restaurant template's own Order entity and domainEntities.ts's generic Order rule", () => {
  const inventoryTemplate = TEMPLATES.find((t) => t.id === "inventory");
  assert.ok(inventoryTemplate, "expected an \"inventory\" template to exist");

  const purchaseOrder = inventoryTemplate!.spec.entities.find((e) => e.name === "PurchaseOrder");
  assert.ok(purchaseOrder, "expected the Inventory & Products template to have a PurchaseOrder entity");
  const items = purchaseOrder!.fields.find((f) => f.name === "items");
  assert.ok(items, "expected the PurchaseOrder entity to have an items field");
  assert.equal(items!.type, "longtext");

  const purchaseOrderEn = inventoryTemplate!.specEn.entities.find((e) => e.name === "PurchaseOrder");
  assert.ok(purchaseOrderEn, "expected the Inventory & Products specEn to have a PurchaseOrder entity");
  const itemsEn = purchaseOrderEn!.fields.find((f) => f.name === "items");
  assert.ok(itemsEn, "expected the PurchaseOrder specEn entity to have an items field");
  assert.equal(itemsEn!.type, "longtext");
});

/**
 * Round 1294: Project Tracker's own Task entity (title/assignee/project/
 * status/priority) is the one Task-shaped entity in this codebase missing
 * `dueDate`. Both the CRM template's own Task entity (title/dueDate/
 * status/deal) and domainEntities.ts's generic Task rule already carry
 * it, and this same template's own sibling Milestone entity has it too --
 * leaving the more granular, more deadline-driven Task as the sole
 * exception, with no way to say when a task is due.
 */
test("the Project Tracker template's Task entity has a dueDate field, matching every other Task-shaped entity in this codebase", () => {
  const projectTrackerTemplate = TEMPLATES.find((t) => t.id === "project-tracker");
  assert.ok(projectTrackerTemplate, "expected a \"project-tracker\" template to exist");

  const task = projectTrackerTemplate!.spec.entities.find((e) => e.name === "Task");
  assert.ok(task, "expected the Project Tracker template to have a Task entity");
  const dueDate = task!.fields.find((f) => f.name === "dueDate");
  assert.ok(dueDate, "expected the Task entity to have a dueDate field");
  assert.equal(dueDate!.type, "date");

  const taskEn = projectTrackerTemplate!.specEn.entities.find((e) => e.name === "Task");
  assert.ok(taskEn, "expected the Project Tracker specEn to have a Task entity");
  const dueDateEn = taskEn!.fields.find((f) => f.name === "dueDate");
  assert.ok(dueDateEn, "expected the Task specEn entity to have a dueDate field");
  assert.equal(dueDateEn!.type, "date");
});

/**
 * Round 1294: Project Tracker's own TeamMember entity (name/email/
 * jobTitle) is the sole person-type entity across all 6 curated templates
 * missing `phone` -- CRM's Customer/Contact, Appointments' Customer/
 * Staff, Inventory's Supplier, and Volunteer's Volunteer all declare it,
 * leaving this template as the one place with no way to call or text a
 * team member even though every comparable person record elsewhere in
 * the gallery can.
 */
test("the Project Tracker template's TeamMember entity has a phone field, matching every other person-type entity across the curated templates", () => {
  const projectTrackerTemplate = TEMPLATES.find((t) => t.id === "project-tracker");
  assert.ok(projectTrackerTemplate, "expected a \"project-tracker\" template to exist");

  const teamMember = projectTrackerTemplate!.spec.entities.find((e) => e.name === "TeamMember");
  assert.ok(teamMember, "expected the Project Tracker template to have a TeamMember entity");
  const phone = teamMember!.fields.find((f) => f.name === "phone");
  assert.ok(phone, "expected the TeamMember entity to have a phone field");
  assert.equal(phone!.type, "text");

  const teamMemberEn = projectTrackerTemplate!.specEn.entities.find((e) => e.name === "TeamMember");
  assert.ok(teamMemberEn, "expected the Project Tracker specEn to have a TeamMember entity");
  const phoneEn = teamMemberEn!.fields.find((f) => f.name === "phone");
  assert.ok(phoneEn, "expected the TeamMember specEn entity to have a phone field");
  assert.equal(phoneEn!.type, "text");
});

/**
 * Round 1301: the Appointments & Clients template's own Staff entity
 * (name/specialty/phone) is the sole person-type entity across all 6
 * curated templates missing `email` -- this same template's own sibling
 * Customer entity has it, every other template's person-type entity
 * (Restaurant's Customer, CRM's Customer/Contact, Project Tracker's
 * TeamMember, Volunteer's Volunteer, Inventory's Supplier) has it, and
 * domainEntities.ts's generic "Employee" rule -- the closest heuristic
 * match for this exact real-world role -- has it too, leaving this
 * template as the one place with no way to record a staff member's email.
 */
test("the Appointments template's Staff entity has an email field, matching every other person-type entity across the curated templates", () => {
  const appointmentsTemplate = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointmentsTemplate, "expected an \"appointments\" template to exist");

  const staff = appointmentsTemplate!.spec.entities.find((e) => e.name === "Staff");
  assert.ok(staff, "expected the Appointments template to have a Staff entity");
  const email = staff!.fields.find((f) => f.name === "email");
  assert.ok(email, "expected the Staff entity to have an email field");
  assert.equal(email!.type, "text");

  const staffEn = appointmentsTemplate!.specEn.entities.find((e) => e.name === "Staff");
  assert.ok(staffEn, "expected the Appointments specEn to have a Staff entity");
  const emailEn = staffEn!.fields.find((f) => f.name === "email");
  assert.ok(emailEn, "expected the Staff specEn entity to have an email field");
  assert.equal(emailEn!.type, "text");
});

/**
 * Round 1302: the Inventory & Products template's own PurchaseOrder entity
 * (supplier/status/orderDate/total/items) is the one transactional,
 * status-tracked entity across the curated templates missing `notes` --
 * Restaurant's Order entity shares an almost identical status/total/items
 * shape and has `notes`, and PurchaseOrder's own sibling StockMovement in
 * this same template has `notes` too, leaving PurchaseOrder as the one
 * place with no way to record ad-hoc context (a partial shipment, a
 * cancellation reason) the way every comparable entity already can.
 */
test("the Inventory template's PurchaseOrder entity has a notes field, matching its own sibling StockMovement and Restaurant's Order entity", () => {
  const inventoryTemplate = TEMPLATES.find((t) => t.id === "inventory");
  assert.ok(inventoryTemplate, "expected an \"inventory\" template to exist");

  const purchaseOrder = inventoryTemplate!.spec.entities.find((e) => e.name === "PurchaseOrder");
  assert.ok(purchaseOrder, "expected the Inventory template to have a PurchaseOrder entity");
  const notes = purchaseOrder!.fields.find((f) => f.name === "notes");
  assert.ok(notes, "expected the PurchaseOrder entity to have a notes field");
  assert.equal(notes!.type, "longtext");

  const purchaseOrderEn = inventoryTemplate!.specEn.entities.find((e) => e.name === "PurchaseOrder");
  assert.ok(purchaseOrderEn, "expected the Inventory specEn to have a PurchaseOrder entity");
  const notesEn = purchaseOrderEn!.fields.find((f) => f.name === "notes");
  assert.ok(notesEn, "expected the PurchaseOrder specEn entity to have a notes field");
  assert.equal(notesEn!.type, "longtext");
});

/**
 * Round 1304: the CRM template's own Customer entity (name/company/email/
 * phone/notes) is missing a lead-stage status and a source field, unlike
 * domainEntities.ts's generic Customer domain rule (name/email/phone/
 * status enum New/Contacted/Qualified/Won/Lost, required/source/notes) --
 * the exact same real-world entity this template's Customer represents.
 * The only stage-like field anywhere in this template is Deal.stage, which
 * only exists once a Deal record has actually been created for that
 * customer; a brand-new prospect who hasn't been turned into a Deal yet
 * has nowhere to record whether they're a new lead, already contacted, or
 * qualified -- exactly the lifecycle a sales rep needs to track before a
 * deal even exists, and a core purpose of a CRM template specifically.
 */
test("the CRM template's Customer entity has a status enum and a source field, matching domainEntities.ts's own Customer domain rule", () => {
  const crmTemplate = TEMPLATES.find((t) => t.id === "crm");
  assert.ok(crmTemplate, "expected a \"crm\" template to exist");

  const customer = crmTemplate!.spec.entities.find((e) => e.name === "Customer");
  assert.ok(customer, "expected the CRM template to have a Customer entity");
  const status = customer!.fields.find((f) => f.name === "status");
  assert.ok(status, "expected the Customer entity to have a status field");
  assert.equal(status!.type, "enum");
  assert.equal(status!.required, true);
  assert.ok(status!.enumValues && status!.enumValues.length >= 2, "expected the status field to have at least 2 enum values");
  const source = customer!.fields.find((f) => f.name === "source");
  assert.ok(source, "expected the Customer entity to have a source field");
  assert.equal(source!.type, "text");

  const customerEn = crmTemplate!.specEn.entities.find((e) => e.name === "Customer");
  assert.ok(customerEn, "expected the CRM specEn to have a Customer entity");
  const statusEn = customerEn!.fields.find((f) => f.name === "status");
  assert.ok(statusEn, "expected the CRM specEn Customer entity to have a status field");
  assert.equal(statusEn!.type, "enum");
  assert.equal(statusEn!.required, true);
  const sourceEn = customerEn!.fields.find((f) => f.name === "source");
  assert.ok(sourceEn, "expected the CRM specEn Customer entity to have a source field");
  assert.equal(sourceEn!.type, "text");
});

/**
 * Round 1898: the same gap round 1304 found and fixed for the CRM
 * template's Customer entity, independently re-confirmed for two more
 * templates round 1304 never touched -- Restaurant and Appointments.
 * Both templates' own Customer entities (pre-fix: name/phone/email/notes
 * only) are missing the same status/source fields domainEntities.ts's
 * generic Customer domain rule has, and both templates' own built-in
 * descriptions mention "customers" -- so refining either template (via
 * generateSpec's own domain-rule matching, apps/api/src/routes/
 * projects.ts's /refine route) re-merges the generic rule's full field set
 * into the curated Customer entity on virtually any refine at all,
 * regardless of what the refine instruction actually asked for, exactly
 * as round 1304's own writeup describes for CRM.
 */
test("the Restaurant and Appointments templates' Customer entities have a status enum and a source field, matching domainEntities.ts's own Customer domain rule", () => {
  for (const templateId of ["restaurant", "appointments"]) {
    const template = TEMPLATES.find((t) => t.id === templateId);
    assert.ok(template, `expected a "${templateId}" template to exist`);

    const customer = template!.spec.entities.find((e) => e.name === "Customer");
    assert.ok(customer, `expected the ${templateId} template to have a Customer entity`);
    const status = customer!.fields.find((f) => f.name === "status");
    assert.ok(status, `expected the ${templateId} Customer entity to have a status field`);
    assert.equal(status!.type, "enum");
    assert.equal(status!.required, true);
    assert.ok(status!.enumValues && status!.enumValues.length >= 2, "expected the status field to have at least 2 enum values");
    const source = customer!.fields.find((f) => f.name === "source");
    assert.ok(source, `expected the ${templateId} Customer entity to have a source field`);
    assert.equal(source!.type, "text");

    const customerEn = template!.specEn.entities.find((e) => e.name === "Customer");
    assert.ok(customerEn, `expected the ${templateId} specEn to have a Customer entity`);
    const statusEn = customerEn!.fields.find((f) => f.name === "status");
    assert.ok(statusEn, `expected the ${templateId} specEn Customer entity to have a status field`);
    assert.equal(statusEn!.type, "enum");
    assert.equal(statusEn!.required, true);
    const sourceEn = customerEn!.fields.find((f) => f.name === "source");
    assert.ok(sourceEn, `expected the ${templateId} specEn Customer entity to have a source field`);
    assert.equal(sourceEn!.type, "text");
  }
});

/**
 * Round 1899: the same bug class as round 1304/1898's own Customer fixes,
 * found this time on the CRM template's Deal entity -- its field set
 * (title/customer/stage/value/closeDeadline) has no `owner` field, unlike
 * domainEntities.ts's own matching Deal domain rule (title/value/stage/
 * owner, `owner` a plain optional text field, fieldLabelsHe.owner =
 * "אחראי/ת"). The CRM template's own Hebrew summary text contains "עסקאות"
 * (one of the Deal rule's own matched keywords), so any refine instruction
 * that re-triggers this rule (e.g. one mentioning "deal"/"עסקה"/
 * "negotiation"/"opportunity") silently bolts an unrequested `owner` field
 * onto every Deal record via mergeRefinedSpec's "add any field the
 * regenerated generic entity has that the current one lacks" merge logic
 * -- regardless of what the refine instruction actually asked to change.
 */
test("the CRM template's Deal entity has an owner field, matching domainEntities.ts's own Deal domain rule", () => {
  const crmTemplate = TEMPLATES.find((t) => t.id === "crm");
  assert.ok(crmTemplate, "expected a \"crm\" template to exist");

  const deal = crmTemplate!.spec.entities.find((e) => e.name === "Deal");
  assert.ok(deal, "expected the CRM template to have a Deal entity");
  const owner = deal!.fields.find((f) => f.name === "owner");
  assert.ok(owner, "expected the Deal entity to have an owner field");
  assert.equal(owner!.type, "text");

  const dealEn = crmTemplate!.specEn.entities.find((e) => e.name === "Deal");
  assert.ok(dealEn, "expected the CRM specEn to have a Deal entity");
  const ownerEn = dealEn!.fields.find((f) => f.name === "owner");
  assert.ok(ownerEn, "expected the CRM specEn Deal entity to have an owner field");
  assert.equal(ownerEn!.type, "text");
});

/**
 * Round 1999: the identical "curated template entity field-set is a strict
 * subset of its own matching domainEntities.ts rule" bug class as the
 * Customer (rounds 1304/1898) and Deal (round 1899) fixes above -- but
 * reachable only via round 1911's own entityMergeKey/ENTITY_ALIAS_GROUPS
 * alias ("employee"/"teammember"/"staff" all fold into one merge key), so
 * neither of those rounds' exact-entity-name surveys would ever have
 * matched it. The Project & Team Tracker template's own stored description
 * ("Projects, milestones, tasks and team members.") contains the bare
 * substring "team member", one of the Employee domain rule's own keywords
 * -- so /refine's combinedDescription re-triggers it on every refine of a
 * project built from this template, and mergeRefinedSpec's alias-aware
 * entity match (round 1911) folds the regenerated "Employee" candidate's
 * fields into this template's own "TeamMember" entity, silently adding
 * `role`/`active` regardless of what the refine instruction actually
 * asked for. Confirmed live via a direct HeuristicSpecProvider.generate +
 * mergeRefinedSpec repro against this exact template before the fix: an
 * unrelated refine instruction ("Add a Notes field to Milestone") added
 * both fields to every TeamMember record.
 */
test("the Project Tracker template's TeamMember entity has role/active fields, matching domainEntities.ts's own Employee domain rule (the entity round 1911's TeamMember/Employee alias merges it with)", () => {
  const projectTrackerTemplate = TEMPLATES.find((t) => t.id === "project-tracker");
  assert.ok(projectTrackerTemplate, 'expected a "project-tracker" template to exist');

  const teamMember = projectTrackerTemplate!.spec.entities.find((e) => e.name === "TeamMember");
  assert.ok(teamMember, "expected the Project Tracker template to have a TeamMember entity");
  const role = teamMember!.fields.find((f) => f.name === "role");
  assert.ok(role, "expected the TeamMember entity to have a role field");
  assert.equal(role!.type, "text");
  const active = teamMember!.fields.find((f) => f.name === "active");
  assert.ok(active, "expected the TeamMember entity to have an active field");
  assert.equal(active!.type, "boolean");

  const teamMemberEn = projectTrackerTemplate!.specEn.entities.find((e) => e.name === "TeamMember");
  assert.ok(teamMemberEn, "expected the Project Tracker specEn to have a TeamMember entity");
  const roleEn = teamMemberEn!.fields.find((f) => f.name === "role");
  assert.ok(roleEn, "expected the Project Tracker specEn TeamMember entity to have a role field");
  assert.equal(roleEn!.type, "text");
  const activeEn = teamMemberEn!.fields.find((f) => f.name === "active");
  assert.ok(activeEn, "expected the Project Tracker specEn TeamMember entity to have an active field");
  assert.equal(activeEn!.type, "boolean");
});

/**
 * Round 1999: the identical gap one entity over -- the Appointments &
 * Clients template's own Staff entity is the SECOND alias round 1911's own
 * write-up names (`/\bstaff\b/` is also one of the Employee domain rule's
 * own keywords, and this template's own description, "Clients, staff,
 * services and scheduled appointments.", contains it). Unlike TeamMember,
 * Staff has no existing field that already covers "role" at all, so this
 * is a clean addition with no near-duplicate field to consider.
 */
test("the Appointments template's Staff entity has role/active fields, matching domainEntities.ts's own Employee domain rule (the entity round 1911's Staff/Employee alias merges it with)", () => {
  const appointmentsTemplate = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointmentsTemplate, 'expected an "appointments" template to exist');

  const staff = appointmentsTemplate!.spec.entities.find((e) => e.name === "Staff");
  assert.ok(staff, "expected the Appointments template to have a Staff entity");
  const role = staff!.fields.find((f) => f.name === "role");
  assert.ok(role, "expected the Staff entity to have a role field");
  assert.equal(role!.type, "text");
  const active = staff!.fields.find((f) => f.name === "active");
  assert.ok(active, "expected the Staff entity to have an active field");
  assert.equal(active!.type, "boolean");

  const staffEn = appointmentsTemplate!.specEn.entities.find((e) => e.name === "Staff");
  assert.ok(staffEn, "expected the Appointments specEn to have a Staff entity");
  const roleEn = staffEn!.fields.find((f) => f.name === "role");
  assert.ok(roleEn, "expected the Appointments specEn Staff entity to have a role field");
  assert.equal(roleEn!.type, "text");
  const activeEn = staffEn!.fields.find((f) => f.name === "active");
  assert.ok(activeEn, "expected the Appointments specEn Staff entity to have an active field");
  assert.equal(activeEn!.type, "boolean");
});

/**
 * Round 1999: the mechanism itself, proven directly against mergeRefinedSpec
 * and the real heuristic generator rather than just pinning the template's
 * own field list -- without this, a future change to either the template or
 * the Employee domain rule could silently reopen the exact live bug this
 * round fixed (an unrelated refine bolting unrequested fields onto every
 * TeamMember/Staff record) with no test catching it, the same "field-list
 * assertion alone doesn't prove the merge gap is closed" gap this family's
 * other tests don't need to worry about (they fix a field that was purely
 * missing, never reachable via an alias merge in the first place).
 */
test("refining a Project/Team Tracker or Appointments project with an unrelated instruction adds no new fields to TeamMember/Staff, now that the template already has everything the aliased Employee domain rule would add", async () => {
  const { HeuristicSpecProvider } = await import("./heuristic.js");
  const { mergeRefinedSpec } = await import("./index.js");
  const provider = new HeuristicSpecProvider();

  const projectTracker = TEMPLATES.find((t) => t.id === "project-tracker")!;
  const combinedDescription1 = `${projectTracker.description}\nAdd a "Notes" long text field to Milestone.`;
  const candidate1 = await provider.generate(combinedDescription1, false);
  const merged1 = mergeRefinedSpec(projectTracker.specEn, candidate1);
  const teamMemberBefore = new Set(projectTracker.specEn.entities.find((e) => e.name === "TeamMember")!.fields.map((f) => f.name));
  const teamMemberAfter = merged1.entities.find((e) => e.name === "TeamMember")!.fields.map((f) => f.name);
  for (const name of teamMemberAfter) {
    assert.ok(teamMemberBefore.has(name), `refining Project Tracker with an unrelated instruction must not add a new TeamMember field, but added "${name}"`);
  }

  const appointments = TEMPLATES.find((t) => t.id === "appointments")!;
  const combinedDescription2 = `${appointments.description}\nAdd a "notes" field to Service.`;
  const candidate2 = await provider.generate(combinedDescription2, false);
  const merged2 = mergeRefinedSpec(appointments.specEn, candidate2);
  const staffBefore = new Set(appointments.specEn.entities.find((e) => e.name === "Staff")!.fields.map((f) => f.name));
  const staffAfter = merged2.entities.find((e) => e.name === "Staff")!.fields.map((f) => f.name);
  for (const name of staffAfter) {
    assert.ok(staffBefore.has(name), `refining Appointments with an unrelated instruction must not add a new Staff field, but added "${name}"`);
  }
});

/**
 * Round 1305: the Project Tracker template's own Project entity (name/
 * description/status/deadline/budget/owner) is missing a `client` field,
 * unlike domainEntities.ts's matching Project domain rule -- whose own
 * description text literally says "Defined work the business performs for
 * a client" and whose fieldLabelsHe explicitly carries `client: "לקוח"`.
 * A user who free-text-describes a project-tracking business for clients
 * gets a client field on every Project record; a user who instead picks
 * this one-click template has no way to record which client a project is
 * even for -- not even a plain text field, for the one field type (a
 * project-tracking tool's own purpose) this template exists to serve.
 */
test("the Project Tracker template's Project entity has a client field, matching domainEntities.ts's own Project domain rule", () => {
  const projectTrackerTemplate = TEMPLATES.find((t) => t.id === "project-tracker");
  assert.ok(projectTrackerTemplate, "expected a \"project-tracker\" template to exist");

  const project = projectTrackerTemplate!.spec.entities.find((e) => e.name === "Project");
  assert.ok(project, "expected the Project Tracker template to have a Project entity");
  const client = project!.fields.find((f) => f.name === "client");
  assert.ok(client, "expected the Project entity to have a client field");
  assert.equal(client!.type, "text");

  const projectEn = projectTrackerTemplate!.specEn.entities.find((e) => e.name === "Project");
  assert.ok(projectEn, "expected the Project Tracker specEn to have a Project entity");
  const clientEn = projectEn!.fields.find((f) => f.name === "client");
  assert.ok(clientEn, "expected the Project specEn entity to have a client field");
  assert.equal(clientEn!.type, "text");
});

/**
 * Round 1308: the CRM template's own Task entity (title/dueDate/status/
 * deal) is missing an `assignee` field, unlike domainEntities.ts's
 * matching Task domain rule (title/assignee/status/dueDate). Round 1273
 * already quoted this domain rule's full shape, including `assignee`,
 * when fixing this same Task entity's status field -- but assignee was
 * never added. CRM's own stated purpose names "follow-up tasks" for a
 * multi-person sales team, so a task with no way to record who it's
 * assigned to loses real workflow fidelity, the same gap round 1273's own
 * analysis already flagged for status.
 */
test("the CRM template's Task entity has an assignee field, matching domainEntities.ts's own Task domain rule", () => {
  const crmTemplate = TEMPLATES.find((t) => t.id === "crm");
  assert.ok(crmTemplate, "expected a \"crm\" template to exist");

  const task = crmTemplate!.spec.entities.find((e) => e.name === "Task");
  assert.ok(task, "expected the CRM template to have a Task entity");
  const assignee = task!.fields.find((f) => f.name === "assignee");
  assert.ok(assignee, "expected the Task entity to have an assignee field");
  assert.equal(assignee!.type, "text");

  const taskEn = crmTemplate!.specEn.entities.find((e) => e.name === "Task");
  assert.ok(taskEn, "expected the CRM specEn to have a Task entity");
  const assigneeEn = taskEn!.fields.find((f) => f.name === "assignee");
  assert.ok(assigneeEn, "expected the CRM specEn Task entity to have an assignee field");
  assert.equal(assigneeEn!.type, "text");
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
 * Round 1975: the Appointments & Clients template is a textbook paid
 * business (its own Service entity has a required-in-spirit `price`
 * field), but none of its entities (Customer/Staff/Service/Appointment)
 * is in BILLING_ENTITY_NAMES -- unlike the Restaurant template above,
 * which gets its correct "Stripe" recommendation purely from the
 * MenuItem/Order entity-name match. This is the exact gap 7 separate
 * heuristic.ts rounds (1819/1831/1841/1872/1879/1928/1934) fixed for the
 * free-text path, never ported to this curated template -- confirmed by
 * round 1345's own text, which deliberately kept "Appointment" OUT of
 * BILLING_ENTITY_NAMES for free-text matching (too ambiguous there, e.g.
 * a school's parent-teacher scheduler), an ambiguity concern that
 * doesn't apply to a template's own fixed, curated entity shape.
 */
test("the Appointments & Clients template (a priced Service entity, but no literal billing-entity name) still surfaces a Stripe recommendation via forcePaymentsQuestion, in both languages", () => {
  const appointments = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointments, "expected an \"appointments\" template to exist");
  assert.equal(appointments!.spec.openQuestions.length, 1, "expected exactly one open question for the Hebrew spec");
  assert.equal(appointments!.spec.openQuestions[0].question, "באיזה ספק תשלומים כדאי להשתמש?");
  assert.deepEqual(appointments!.spec.openQuestions[0].options, ["Stripe", "PayPal", "בלי תשלומים", "תחליטו בשבילי"]);
  assert.equal(appointments!.spec.openQuestions[0].recommendation, "Stripe");

  assert.equal(appointments!.specEn.openQuestions.length, 1, "expected exactly one open question for the English specEn");
  assert.equal(appointments!.specEn.openQuestions[0].question, "Which payment provider should this use?");
  assert.deepEqual(appointments!.specEn.openQuestions[0].options, ["Stripe", "PayPal", "No payments", "Decide for me"]);
  assert.equal(appointments!.specEn.openQuestions[0].recommendation, "Stripe");
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
test("a template with no billing entity (e.g. the CRM/Project Tracker/Volunteer/Inventory templates) still gets the same always-present payment open question heuristic.ts generates for an identical business shape, in both languages", () => {
  for (const template of TEMPLATES) {
    // Round 1975: "appointments" is no longer in this group -- see the
    // dedicated test just below. Excluded here the same way "restaurant"
    // already was, for the identical reason: it now gets a "Stripe"
    // recommendation instead of "No payments".
    if (template.id === "restaurant" || template.id === "appointments") continue;
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
 * Round 1540's finding: this file's own BILLING_ENTITY_NAMES (declared
 * right above, its doc comment claiming it "mirrors heuristic.ts's own
 * BILLING_ENTITY_NAMES exactly") had silently drifted out of sync --
 * heuristic.ts gained "WorkOrder" (round 1345) and "InsuranceClaim"
 * (round 1346), but this file's own copy was never updated, so a future
 * template built around either entity would silently get the wrong
 * ("No payments") default for its own payment-provider open question.
 * Neither Set is exported (this file's own established "duplicate the
 * small pure helper per module, don't cross-import" convention), so this
 * reads both files' own source text directly, the same regex-extraction
 * convention this codebase's own App.test.ts already uses, to assert the
 * two Sets' contents stay equal regardless of which file next changes.
 */
test("templates.ts's own BILLING_ENTITY_NAMES stays in sync with heuristic.ts's, so this file's own \"mirrors ... exactly\" doc comment stays true", () => {
  const heuristicSrc = readFileSync(new URL("./heuristic.ts", import.meta.url), "utf8");
  const templatesSrc = readFileSync(new URL("./templates.ts", import.meta.url), "utf8");

  const heuristicMatch = heuristicSrc.match(/const BILLING_ENTITY_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  const templatesMatch = templatesSrc.match(/const BILLING_ENTITY_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(heuristicMatch, "expected to find heuristic.ts's own BILLING_ENTITY_NAMES declaration");
  assert.ok(templatesMatch, "expected to find templates.ts's own BILLING_ENTITY_NAMES declaration");

  const extractNames = (body: string) => Array.from(body.matchAll(/"([A-Za-z]+)"/g), (m) => m[1]).sort();
  const heuristicNames = extractNames(heuristicMatch![1]);
  const templatesNames = extractNames(templatesMatch![1]);

  assert.deepEqual(
    templatesNames,
    heuristicNames,
    "templates.ts's BILLING_ENTITY_NAMES must contain exactly the same entity names as heuristic.ts's, or its own doc comment claiming an exact mirror is false",
  );
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

/**
 * Round 1439's finding: the Sales CRM template's Deal entity had a date
 * field named "closeDate" -- a name that matches neither "due" nor
 * "deadline", the two substrings entityFormatting.ts's/twin.ts's/
 * codegen.ts's own isDeadlineFieldName heuristic (independently
 * duplicated in each) uses to decide whether a date field can be
 * "overdue"/"due soon". That silently excluded the single most
 * sales-actionable field a CRM template has from every overdue/due-soon
 * highlight, toolbar filter, and Business Twin insight in the app --
 * live preview and every exported app alike. Renamed to "closeDeadline"
 * (label unchanged) so it's picked up by the existing heuristic with no
 * change to shared code.
 */
test("the Sales CRM template's Deal entity has a date field whose NAME matches the app-wide isDeadlineFieldName heuristic (\"due\"/\"deadline\"), so overdue/due-soon highlighting actually applies to it", () => {
  const isDeadlineFieldName = (fieldName: string) => {
    const lower = fieldName.toLowerCase();
    return lower.includes("due") || lower.includes("deadline");
  };
  for (const [template, spec] of TEMPLATES.flatMap((t) => [
    [t, t.spec] as const,
    [t, t.specEn] as const,
  ])) {
    if (template.id !== "crm") continue;
    const deal = spec.entities.find((e) => e.name === "Deal");
    if (!deal) continue;
    const closeField = deal.fields.find((f) => f.type === "date" && f.name !== "createdDate");
    assert.ok(closeField, `template "${template.id}"'s Deal entity must have its own close/expected-close date field`);
    assert.ok(
      isDeadlineFieldName(closeField!.name),
      `template "${template.id}"'s Deal entity's "${closeField!.name}" field name must match isDeadlineFieldName so overdue/due-soon highlighting applies to it`,
    );
  }
});

/**
 * Round 1440's finding: the Appointments template's Appointment entity had
 * a status enum VALUE "noshow" (no hyphen) -- but entityFormatting.ts's/
 * codegen.ts's own badgeTone NEGATIVE_WORDS list only contains "no-show"
 * (hyphenated), the exact spelling the built-in domain library (see
 * domainEntities.ts) already uses for its own canonical Appointment
 * entity. badgeTone runs on the raw stored enum VALUE, not the
 * translated enumLabels display text, so "noshow" matched neither
 * NEGATIVE_WORDS nor POSITIVE_WORDS and silently rendered as a neutral
 * (gray) badge -- identical to "scheduled" -- instead of negative (red)
 * like "cancelled", the other negative outcome in the same enum. Same
 * underlying class of bug as round 1439's closeDate->closeDeadline fix
 * (a template hardcodes a raw value that must match an app-wide naming
 * convention another heuristic relies on), just on an enum value instead
 * of a field name.
 */
test("the Appointments template's Appointment entity's \"no-show\" status enum VALUE matches badgeTone's NEGATIVE_WORDS convention, so it renders as a negative (red) badge like \"cancelled\" does, not a neutral one", () => {
  const NEGATIVE_WORDS = ["lost", "cancelled", "canceled", "inactive", "overdue", "no-show", "failed", "rejected", "declined", "denied"];
  const badgeTone = (rawValue: string) => {
    const lower = rawValue.toLowerCase();
    return NEGATIVE_WORDS.some((w) => lower.includes(w)) ? "negative" : "neutral";
  };
  for (const [template, spec] of TEMPLATES.flatMap((t) => [
    [t, t.spec] as const,
    [t, t.specEn] as const,
  ])) {
    if (template.id !== "appointments") continue;
    const appointment = spec.entities.find((e) => e.name === "Appointment");
    assert.ok(appointment, `template "${template.id}" must have an Appointment entity`);
    const statusField = appointment!.fields.find((f) => f.name === "status" && f.type === "enum") as { enumValues: string[] } | undefined;
    assert.ok(statusField, `template "${template.id}"'s Appointment entity must have a status enum field`);
    const noShowValue = statusField!.enumValues.find((v) => v.toLowerCase().replace(/[^a-z]/g, "") === "noshow");
    assert.ok(noShowValue, `template "${template.id}"'s Appointment status enum must have a no-show value`);
    assert.equal(
      badgeTone(noShowValue!),
      "negative",
      `template "${template.id}"'s Appointment status enum's no-show VALUE ("${noShowValue}") must match badgeTone's NEGATIVE_WORDS convention so it renders as a negative badge`,
    );
  }
});

/**
 * Round 1706: follow-up sweep after rounds 1704/1705 found via live browser
 * testing that the Restaurant Order entity's and Appointments Appointment
 * entity's relation fields weren't marked `required`, so seed.ts's
 * seedValueFor left them blank even though real related rows existed. This
 * is the same shape across three more templates: the CRM template's Contact
 * and Deal entities each have a `customer` relation that isn't required --
 * a contact or a deal with no linked customer isn't a meaningful CRM
 * record, unlike this file's Task.deal/Project.owner/Task.assignee
 * (deliberately left optional elsewhere in this sweep: an unassigned task
 * or an unowned project are normal states).
 */
test("the Sales CRM template's Contact and Deal entities mark their customer relation required, so seed.ts seeds a real id instead of leaving it blank", () => {
  const crmTemplate = TEMPLATES.find((t) => t.id === "crm");
  assert.ok(crmTemplate, "expected a \"crm\" template to exist");

  for (const spec of [crmTemplate!.spec, crmTemplate!.specEn]) {
    const contact = spec.entities.find((e) => e.name === "Contact");
    assert.ok(contact, "expected the CRM template to have a Contact entity");
    const contactCustomer = contact!.fields.find((f) => f.name === "customer");
    assert.ok(contactCustomer, "expected the Contact entity to have a customer field");
    assert.equal(contactCustomer!.required, true, "a contact with no linked customer isn't a meaningful CRM record");

    const deal = spec.entities.find((e) => e.name === "Deal");
    assert.ok(deal, "expected the CRM template to have a Deal entity");
    const dealCustomer = deal!.fields.find((f) => f.name === "customer");
    assert.ok(dealCustomer, "expected the Deal entity to have a customer field");
    assert.equal(dealCustomer!.required, true, "a deal with no linked customer isn't a meaningful CRM record");
  }
});

/**
 * Round 1706: same sweep as above -- the Project & Team Tracker template's
 * Milestone and Task entities each have a `project` relation that isn't
 * required, even though a milestone or task with no linked project isn't
 * a meaningful record. Task.assignee and Project.owner are deliberately
 * left optional: an unassigned task or an unowned project are normal,
 * legitimate states, unlike "which project is this even for".
 */
test("the Project & Team Tracker template's Milestone and Task entities mark their project relation required, so seed.ts seeds a real id instead of leaving it blank", () => {
  const projectTrackerTemplate = TEMPLATES.find((t) => t.id === "project-tracker");
  assert.ok(projectTrackerTemplate, "expected a \"project-tracker\" template to exist");

  for (const spec of [projectTrackerTemplate!.spec, projectTrackerTemplate!.specEn]) {
    const milestone = spec.entities.find((e) => e.name === "Milestone");
    assert.ok(milestone, "expected the Project Tracker template to have a Milestone entity");
    const milestoneProject = milestone!.fields.find((f) => f.name === "project");
    assert.ok(milestoneProject, "expected the Milestone entity to have a project field");
    assert.equal(milestoneProject!.required, true, "a milestone with no linked project isn't a meaningful record");

    const task = spec.entities.find((e) => e.name === "Task");
    assert.ok(task, "expected the Project Tracker template to have a Task entity");
    const taskProject = task!.fields.find((f) => f.name === "project");
    assert.ok(taskProject, "expected the Task entity to have a project field");
    assert.equal(taskProject!.required, true, "a task with no linked project isn't a meaningful record");

    const taskAssignee = task!.fields.find((f) => f.name === "assignee");
    assert.ok(taskAssignee, "expected the Task entity to have an assignee field");
    assert.equal(taskAssignee!.required, false, "an unassigned task is a normal, legitimate state -- deliberately left optional");
  }
});

/**
 * Round 1706: same sweep -- the Volunteer & Shift Management template's
 * Shift entity has BOTH its `event` and `volunteer` relations non-required,
 * the most severe instance in this sweep (same shape as round 1705's
 * Appointment fix): a shift with no linked event and no linked volunteer
 * isn't a meaningful record at all.
 */
test("the Volunteer & Shift Management template's Shift entity marks its event and volunteer relations required, so seed.ts seeds real ids instead of leaving them blank", () => {
  const volunteersTemplate = TEMPLATES.find((t) => t.id === "volunteers");
  assert.ok(volunteersTemplate, "expected a \"volunteers\" template to exist");

  for (const spec of [volunteersTemplate!.spec, volunteersTemplate!.specEn]) {
    const shift = spec.entities.find((e) => e.name === "Shift");
    assert.ok(shift, "expected the Volunteer template to have a Shift entity");
    const shiftEvent = shift!.fields.find((f) => f.name === "event");
    const shiftVolunteer = shift!.fields.find((f) => f.name === "volunteer");
    assert.ok(shiftEvent, "expected the Shift entity to have an event field");
    assert.ok(shiftVolunteer, "expected the Shift entity to have a volunteer field");
    assert.equal(shiftEvent!.required, true, "a shift with no linked event isn't a meaningful record");
    assert.equal(shiftVolunteer!.required, true, "a shift with no linked volunteer isn't a meaningful record");
  }
});

/**
 * Round 1706: same sweep -- the Inventory & Products template's
 * PurchaseOrder and StockMovement entities each have a relation
 * (supplier/product respectively) that isn't required, even though a
 * purchase order with no supplier, or a stock movement with no product,
 * isn't a meaningful record. Product.supplier is deliberately left
 * optional: a product can legitimately exist with no tracked supplier yet
 * (e.g. in-house manufactured goods).
 */
test("the Inventory & Products template's PurchaseOrder and StockMovement entities mark their supplier/product relations required, so seed.ts seeds real ids instead of leaving them blank", () => {
  const inventoryTemplate = TEMPLATES.find((t) => t.id === "inventory");
  assert.ok(inventoryTemplate, "expected an \"inventory\" template to exist");

  for (const spec of [inventoryTemplate!.spec, inventoryTemplate!.specEn]) {
    const purchaseOrder = spec.entities.find((e) => e.name === "PurchaseOrder");
    assert.ok(purchaseOrder, "expected the Inventory template to have a PurchaseOrder entity");
    const poSupplier = purchaseOrder!.fields.find((f) => f.name === "supplier");
    assert.ok(poSupplier, "expected the PurchaseOrder entity to have a supplier field");
    assert.equal(poSupplier!.required, true, "a purchase order with no supplier isn't a meaningful record");

    const stockMovement = spec.entities.find((e) => e.name === "StockMovement");
    assert.ok(stockMovement, "expected the Inventory template to have a StockMovement entity");
    const smProduct = stockMovement!.fields.find((f) => f.name === "product");
    assert.ok(smProduct, "expected the StockMovement entity to have a product field");
    assert.equal(smProduct!.required, true, "a stock movement with no product isn't a meaningful record");

    const product = spec.entities.find((e) => e.name === "Product");
    assert.ok(product, "expected the Inventory template to have a Product entity");
    const productSupplier = product!.fields.find((f) => f.name === "supplier");
    assert.ok(productSupplier, "expected the Product entity to have a supplier field");
    assert.equal(productSupplier!.required, false, "a product with no tracked supplier yet is a normal, legitimate state -- deliberately left optional");
  }
});

/**
 * Round 2008: the identical "curated template entity field-set is a strict
 * subset of its own matching domainEntities.ts rule" bug class as the
 * Customer (rounds 1304/1898), Deal (round 1899), and TeamMember/Staff
 * (round 1999) fixes above -- found via a live Playwright session (a real
 * signup, a real "Appointments & Clients" build, then two real refines
 * against the real heuristic provider). This template's own Appointment
 * entity ("customer"/"staff"/"service"/"date"/"status"/"notes") is an
 * exact-name match (no alias needed) for domainEntities.ts's own
 * Appointment domain rule, whose own `customerName` (text) field was
 * missing here by name -- so any refine instruction merely containing the
 * word "appointment" (trivially likely, since the entity itself is named
 * that) re-triggers the domain rule via /refine's combinedDescription and
 * mergeRefinedSpec silently bolts `customerName` onto every Appointment
 * record, regardless of what the instruction actually asked for. Live-
 * reproduced: refining a real "Appointments & Clients" project with "Add a
 * reminderSent boolean field to Appointment" added `customerName` (not
 * `reminderSent`) to the Appointment entity. Unlike TeamMember/role, this
 * field is deliberately left optional rather than mirroring the domain
 * rule's `required: true` -- see templates.ts's own comment on this field
 * for why (it would otherwise force retyping the same customer's name
 * already captured by this entity's own `customer` relation, on every
 * single record).
 */
test("the Appointments template's Appointment entity has a customerName field, matching domainEntities.ts's own Appointment domain rule", () => {
  const appointmentsTemplate = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointmentsTemplate, 'expected an "appointments" template to exist');

  const appointment = appointmentsTemplate!.spec.entities.find((e) => e.name === "Appointment");
  assert.ok(appointment, "expected the Appointments template to have an Appointment entity");
  const customerName = appointment!.fields.find((f) => f.name === "customerName");
  assert.ok(customerName, "expected the Appointment entity to have a customerName field");
  assert.equal(customerName!.type, "text");
  assert.equal(customerName!.required, false, "deliberately optional -- see templates.ts's own comment on this field");

  const appointmentEn = appointmentsTemplate!.specEn.entities.find((e) => e.name === "Appointment");
  assert.ok(appointmentEn, "expected the Appointments specEn to have an Appointment entity");
  const customerNameEn = appointmentEn!.fields.find((f) => f.name === "customerName");
  assert.ok(customerNameEn, "expected the Appointments specEn Appointment entity to have a customerName field");
  assert.equal(customerNameEn!.type, "text");
  assert.equal(customerNameEn!.required, false, "deliberately optional -- see templates.ts's own comment on this field");
});

/**
 * Round 2008: the mechanism itself, proven directly against mergeRefinedSpec
 * and the real heuristic generator rather than just pinning the template's
 * own field list -- mirrors round 1999's own identical mechanism test for
 * TeamMember/Staff. Without this, a future change to either the template or
 * the Appointment domain rule could silently reopen the exact live bug this
 * round fixed (an unrelated refine bolting an unrequested field onto every
 * Appointment record) with no test catching it.
 */
test("refining an Appointments & Clients project with an unrelated instruction mentioning \"appointment\" adds no new fields to Appointment, now that the template already has everything the domain rule would add", async () => {
  const { HeuristicSpecProvider } = await import("./heuristic.js");
  const { mergeRefinedSpec } = await import("./index.js");
  const provider = new HeuristicSpecProvider();

  const appointments = TEMPLATES.find((t) => t.id === "appointments")!;
  const combinedDescription = `${appointments.description}\n\nAdditional requirement: Add a reminderSent boolean field to Appointment.`;
  const candidate = await provider.generate(combinedDescription, false);
  const merged = mergeRefinedSpec(appointments.specEn, candidate);
  const appointmentBefore = new Set(appointments.specEn.entities.find((e) => e.name === "Appointment")!.fields.map((f) => f.name));
  const appointmentAfter = merged.entities.find((e) => e.name === "Appointment")!.fields.map((f) => f.name);
  for (const name of appointmentAfter) {
    assert.ok(appointmentBefore.has(name), `refining Appointments with an unrelated instruction must not add a new Appointment field, but added "${name}"`);
  }
});
