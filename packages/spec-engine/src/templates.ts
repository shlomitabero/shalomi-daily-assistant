import { type OpenQuestion, type ProductSpec, ProductSpecSchema } from "@forge/shared";

/**
 * A curated "Templates Gallery" (the long-standing "Template/agent
 * marketplace" backlog bullet in docs/roadmap.md, and
 * docs/product-vision.md's "reusable templates" line) -- a hand-authored,
 * ready-to-build ProductSpec per common business type, so a user can start
 * a real project with one click instead of describing it from scratch.
 * Unlike a heuristic- or AI-generated spec, these are fixed data, validated
 * once here at module load against the exact same ProductSpecSchema every
 * other spec has to satisfy (see templates.test.ts for the "every template
 * parses" regression test) -- a typo in one of these can never reach a user
 * picking a template, because the whole module would fail to import first.
 */
export interface AppTemplate {
  id: string;
  icon: string;
  name: string;
  nameHe: string;
  description: string;
  descriptionHe: string;
  /** The Hebrew-labeled spec (this app is Hebrew-first; see /projects/from-template). */
  spec: ProductSpec;
  /**
   * The same entities/fields as `spec`, with every entity/field label and
   * enum label in English instead of Hebrew, so a user who picks English
   * UI gets a fully English generated app, not Hebrew content under
   * English chrome. Entity names, field names, types, and relationTo must
   * stay byte-identical to `spec`'s -- only display text differs (see
   * templates.test.ts's "spec and specEn describe the same shape" test).
   */
  specEn: ProductSpec;
}

type EntitySpec = ProductSpec["entities"][number];

// Round 1028: used to emit Dashboard + one "list" screen per entity
// (screens.length === entities.length + 1) -- heuristic.ts's own
// buildScreens emits Dashboard + a List+Form PAIR per entity
// (screens.length === 2*entities.length + 1) for the exact same real app
// shape (every generated app, template or heuristic, gets the identical
// List+Form UI per entity -- `grep -n "screens" apps/api/src/pipeline.ts
// apps/api/src/codegen.ts` returns zero matches, confirming `screens` is
// purely Time Machine/History display metadata with no effect on what's
// actually built). HistoryPanel.tsx/checkpointDiff.ts both display this
// count under the explicit, now-templates-violated assumption that every
// generator emits "Dashboard plus a List/Form pair per entity" -- a
// project built from a template showed roughly half the "N screens" count
// of an otherwise-identical heuristic-built project. Mirrors
// buildScreens's own List+Form-pair convention exactly.
function screensFor(entityNames: string[]): ProductSpec["screens"] {
  const screens: ProductSpec["screens"] = [{ name: "Dashboard", type: "dashboard" }];
  for (const name of entityNames) {
    screens.push({ name: `${name} List`, type: "list", entity: name });
    screens.push({ name: `${name} Form`, type: "form", entity: name });
  }
  return screens;
}

/**
 * Round 1248: mirrors heuristic.ts's own BILLING_ENTITY_NAMES exactly --
 * an entity whose whole purpose is receiving money, so its presence alone
 * means a generated spec should surface the payment-provider open
 * question. Kept as its own small copy here rather than importing
 * heuristic.ts's module-private Set, matching this codebase's established
 * "duplicate the small pure helper per module" convention (backup.ts/
 * twin.ts/checkpointDiff.ts each keep their own small copies of shared
 * pure logic rather than cross-importing between spec-engine modules).
 */
// Round 1540: this copy had drifted out of sync with heuristic.ts's own
// BILLING_ENTITY_NAMES -- WorkOrder and InsuranceClaim were added there
// in rounds 1345/1346 but never ported here, making this file's own
// "mirrors heuristic.ts's own BILLING_ENTITY_NAMES exactly" doc comment
// above false. No existing curated template declares either entity
// today, so this was latent, not yet reachable -- but the next template
// built around a field-service or insurance-claims business would
// otherwise silently get the wrong ("No payments") default.
const BILLING_ENTITY_NAMES = new Set(["Invoice", "Order", "Donation", "Subscription", "Rental", "Property", "MenuItem", "WorkOrder", "InsuranceClaim"]);

/**
 * Round 1248: mirrors heuristic.ts's own buildOpenQuestions exactly for
 * the one question it always asks (payment provider) -- a template's
 * entities are fixed data known at module-load time, so there's no
 * description text to scan for PAYMENT_KEYWORDS the way heuristic.ts's own
 * provider does; only the entity-name check applies here.
 *
 * Round 1271: the original round-1248 version early-returned `[]` when
 * `needsPayments` was false, which this comment's own "exactly" claim
 * never actually matched -- heuristic.ts's real buildOpenQuestions has no
 * such early return; it unconditionally returns a 1-element array always,
 * only varying the question text/recommendation by needsPayments. Since
 * App.tsx gates the whole Open Questions section on `.length > 0`, that
 * early return meant 5 of the 6 templates (every one but Restaurant)
 * permanently lost the payment decision point -- now fixed to genuinely
 * mirror buildOpenQuestions's always-one-question shape.
 *
 * Round 1975: `force` lets a specific template override the plain
 * BILLING_ENTITY_NAMES check when its own curated entity shape makes a
 * payment recommendation unambiguous even though none of its entity
 * names happen to be in that set -- see the Appointments & Clients
 * template's own `spec()`/`specEn()` call sites below for the one
 * template that currently uses this (a priced `Service` entity with no
 * literal "Invoice"/"Order"-named entity). Round 1345 deliberately kept
 * "Appointment" OUT of BILLING_ENTITY_NAMES itself because that set also
 * drives heuristic.ts's own free-text matching, where "appointment" is
 * genuinely ambiguous (a school's parent-teacher-conference scheduler
 * has appointments too, with no payment concept at all) -- but a
 * template's entity set is fixed, curated data, not free text, so that
 * ambiguity simply doesn't apply here.
 */
function paymentOpenQuestion(entities: EntitySpec[], isHebrew: boolean, force?: boolean): OpenQuestion[] {
  const needsPayments = force || entities.some((e) => BILLING_ENTITY_NAMES.has(e.name));
  return isHebrew
    ? [
        {
          question: needsPayments ? "באיזה ספק תשלומים כדאי להשתמש?" : "האם האפליקציה צריכה לקבל תשלומים?",
          options: ["Stripe", "PayPal", "בלי תשלומים", "תחליטו בשבילי"],
          recommendation: needsPayments ? "Stripe" : "בלי תשלומים",
        },
      ]
    : [
        {
          question: needsPayments ? "Which payment provider should this use?" : "Does this application need to accept payments?",
          options: ["Stripe", "PayPal", "No payments", "Decide for me"],
          recommendation: needsPayments ? "Stripe" : "No payments",
        },
      ];
}

/**
 * Round 1257: mirrors heuristic.ts's own buildAssumptions exactly -- every
 * template runs on the identical generic schema-driven engine a heuristic-
 * or AI-generated spec does (same auth/collaboration model, same real
 * WhatsApp integration, same "other integrations aren't wired up yet, see
 * open questions" caveat), so the same three assumptions apply regardless
 * of which template produced the spec. Kept as its own small copy here
 * rather than importing heuristic.ts's module-private function, the same
 * "duplicate the small pure helper per module" convention round 1248's own
 * BILLING_ENTITY_NAMES copy already established in this file.
 */
function templateAssumptions(isHebrew: boolean): string[] {
  if (isHebrew) {
    return [
      "האפליקציה בנויה כרגע על מנוע גנרי משותף עם בסיס נתונים אמיתי — לא קוד ייעודי מלא לכל פרויקט.",
      "יש כניסה אמיתית למשתמשים (הרשמה+סיסמה), ואפשר להזמין משתמשים קיימים כשותפים לאותו פרויקט עם הרשאת \"עורך/ת\" (גישה מלאה) או \"צפייה בלבד\" שנאכפת בפועל על כל שינוי — רק הבעלים יכול לנהל מי מוזמן או לשנות את ההרשאה של שותף.",
      "חיבור וואטסאפ אמיתי קיים לכל פרויקט (סריקת QR, הודעות נכנסות/יוצאות, הפעלת אוטומציות) — אך כל אינטגרציה אחרת שהוזכרה בתיאור (תשלומים וכו') עדיין לא מחוברת בפועל, ראו את השאלות הפתוחות למטה.",
    ];
  }
  return [
    "Using a generic schema-driven CRUD engine backed by SQLite for this Phase 1 slice, not a dedicated generated codebase per project yet.",
    "Real signup/login authentication exists, and the project owner can invite existing users as collaborators on the same project with either \"editor\" (full access) or \"viewer\" (read-only) permission, enforced on every change — only the owner can manage who else is invited or change their role.",
    "A real WhatsApp Web connection is available for every project (QR-code linking, inbound/outbound messages, automation triggers) — but any other integration mentioned in the description (payments, etc.) is not wired up yet, see open questions and the product roadmap.",
  ];
}

/**
 * Round 1266: mirrors heuristic.ts's own personas derivation exactly --
 * every template already declares real `roles` (e.g. Restaurant's own
 * ["Staff", "Manager"]), so a from-scratch description of the identical
 * business shape gets matching personas like "Staff user"/"Manager user"
 * via heuristic.ts's own 1:1 roles.map(...). A template used to hardcode
 * an empty array here instead, the third sibling in the same parity
 * family rounds 1248 (openQuestions) and 1257 (assumptions) already
 * closed -- App.tsx's own "Who uses this app" section (spec.personas.heading)
 * renders unconditionally, with no `.length > 0` gate, so a Templates
 * Gallery project showed a populated Roles section right above an empty
 * personas one. Kept as its own small copy here rather than importing
 * heuristic.ts's module-private logic, the same "duplicate the small pure
 * helper per module" convention this file's own BILLING_ENTITY_NAMES/
 * templateAssumptions copies already established.
 */
function templatePersonas(roles: string[], isHebrew: boolean): string[] {
  return roles.map((r) => (isHebrew ? `משתמש/ת מסוג ${r}` : `${r} user`));
}

function spec(input: {
  summary: string;
  roles: string[];
  entities: EntitySpec[];
  personas?: string[];
  assumptions?: string[];
  isHebrew?: boolean;
  forcePaymentsQuestion?: boolean;
}): ProductSpec {
  return ProductSpecSchema.parse({
    summary: input.summary,
    personas: input.personas ?? templatePersonas(input.roles, input.isHebrew ?? true),
    roles: input.roles,
    entities: input.entities,
    screens: screensFor(input.entities.map((e) => e.name)),
    assumptions: input.assumptions ?? templateAssumptions(input.isHebrew ?? true),
    // Round 1248: every template used to hardcode an empty array here,
    // unlike a heuristic- or AI-generated spec with the identical
    // business shape (e.g. the exact same MenuItem/Order entities), which
    // always gets a payment-provider open question via heuristic.ts's own
    // BILLING_ENTITY_NAMES check. Answering an open question is a real,
    // functional decision point (POST /projects/:id/answers genuinely
    // re-generates the spec with the answer appended), unlike `screens`
    // (round 1028's own comment: purely display metadata with zero build
    // effect) -- so a template user reached no way to even surface the
    // payment-provider decision the dedicated Open Questions UI exists
    // for, despite running the same billing entities as a from-scratch
    // description would.
    openQuestions: paymentOpenQuestion(input.entities, input.isHebrew ?? true, input.forcePaymentsQuestion),
  });
}

const RESTAURANT_ENTITIES: EntitySpec[] = [
  {
    name: "MenuItem",
    label: "מנה",
    description: "פריט בתפריט המסעדה",
    fields: [
      { name: "name", label: "שם המנה", type: "text", required: true },
      {
        name: "category",
        label: "קטגוריה",
        type: "enum",
        required: true,
        enumValues: ["appetizer", "main", "dessert", "drink"],
        enumLabels: { appetizer: "מנה ראשונה", main: "מנה עיקרית", dessert: "קינוח", drink: "שתייה" },
      },
      { name: "price", label: "מחיר", type: "number", required: true },
      { name: "available", label: "זמין בתפריט", type: "boolean" },
      { name: "description", label: "תיאור", type: "longtext" },
    ],
  },
  {
    name: "RestaurantTable",
    label: "שולחן",
    description: "שולחן פיזי במסעדה",
    fields: [
      { name: "number", label: "מספר שולחן", type: "number", required: true },
      { name: "seats", label: "מספר מקומות", type: "number" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["free", "occupied", "reserved"],
        enumLabels: { free: "פנוי", occupied: "תפוס", reserved: "מוזמן" },
      },
    ],
  },
  {
    name: "Customer",
    label: "לקוח",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "phone", label: "טלפון", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        enumLabels: { New: "חדש", Contacted: "יצרנו קשר", Qualified: "מתאים", Won: "הצליח", Lost: "לא הצליח" },
      },
      { name: "source", label: "מקור", type: "text" },
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
  {
    name: "Order",
    label: "הזמנה",
    fields: [
      // Round 1704: a restaurant order with no customer and no table isn't
      // a meaningful record -- marking both required (matching this same
      // entity's own `status` field) lets orderForSeeding (seed.ts) place
      // Customer/RestaurantTable before Order and seed real ids into both,
      // instead of seedValueFor's "relation" case returning null for an
      // optional field with nothing to point at.
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer", required: true },
      { name: "table", label: "שולחן", type: "relation", relationTo: "RestaurantTable", required: true },
      {
        name: "status",
        label: "סטטוס הזמנה",
        type: "enum",
        required: true,
        enumValues: ["pending", "preparing", "served", "paid"],
        enumLabels: { pending: "בהמתנה", preparing: "בהכנה", served: "הוגש", paid: "שולם" },
      },
      { name: "total", label: "סכום כולל", type: "number" },
      { name: "items", label: "פריטים", type: "longtext" },
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
];

const RESTAURANT_ENTITIES_EN: EntitySpec[] = [
  {
    name: "MenuItem",
    label: "Menu Item",
    description: "An item on the restaurant's menu",
    fields: [
      { name: "name", label: "Dish Name", type: "text", required: true },
      {
        name: "category",
        label: "Category",
        type: "enum",
        required: true,
        enumValues: ["appetizer", "main", "dessert", "drink"],
        enumLabels: { appetizer: "Appetizer", main: "Main Course", dessert: "Dessert", drink: "Drink" },
      },
      { name: "price", label: "Price", type: "number", required: true },
      { name: "available", label: "Available on Menu", type: "boolean" },
      { name: "description", label: "Description", type: "longtext" },
    ],
  },
  {
    name: "RestaurantTable",
    label: "Table",
    description: "A physical table in the restaurant",
    fields: [
      { name: "number", label: "Table Number", type: "number", required: true },
      { name: "seats", label: "Seats", type: "number" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["free", "occupied", "reserved"],
        enumLabels: { free: "Free", occupied: "Occupied", reserved: "Reserved" },
      },
    ],
  },
  {
    name: "Customer",
    label: "Customer",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "phone", label: "Phone", type: "text" },
      { name: "email", label: "Email", type: "text" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        enumLabels: { New: "New", Contacted: "Contacted", Qualified: "Qualified", Won: "Won", Lost: "Lost" },
      },
      { name: "source", label: "Source", type: "text" },
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
  {
    name: "Order",
    label: "Order",
    fields: [
      // Round 1704: see the Hebrew RESTAURANT_ENTITIES' own comment above --
      // same fix, same reasoning, kept in sync with its own Order entity.
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer", required: true },
      { name: "table", label: "Table", type: "relation", relationTo: "RestaurantTable", required: true },
      {
        name: "status",
        label: "Order Status",
        type: "enum",
        required: true,
        enumValues: ["pending", "preparing", "served", "paid"],
        enumLabels: { pending: "Pending", preparing: "Preparing", served: "Served", paid: "Paid" },
      },
      { name: "total", label: "Total Amount", type: "number" },
      { name: "items", label: "Items", type: "longtext" },
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
];

const CRM_ENTITIES: EntitySpec[] = [
  {
    name: "Customer",
    label: "לקוח",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "company", label: "חברה", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
      { name: "phone", label: "טלפון", type: "text" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        enumLabels: { New: "חדש", Contacted: "יצרנו קשר", Qualified: "מתאים", Won: "הצליח", Lost: "לא הצליח" },
      },
      { name: "source", label: "מקור", type: "text" },
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
  {
    name: "Contact",
    label: "איש קשר",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "jobTitle", label: "תפקיד", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
      { name: "phone", label: "טלפון", type: "text" },
      // Round 1706: same shape as rounds 1704/1705 -- a contact person with
      // no linked customer, or a deal with no linked customer, isn't a
      // meaningful CRM record (unlike Task.deal/Project.owner/Task.assignee
      // elsewhere in this file, deliberately left optional: an unassigned
      // task or an unowned project are normal, legitimate states).
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer", required: true },
    ],
  },
  {
    name: "Deal",
    label: "עסקה",
    fields: [
      { name: "title", label: "כותרת", type: "text", required: true },
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer", required: true },
      {
        name: "stage",
        label: "שלב",
        type: "enum",
        required: true,
        enumValues: ["lead", "qualified", "proposal", "won", "lost"],
        enumLabels: { lead: "ליד", qualified: "הוכשר", proposal: "הצעת מחיר", won: "נסגרה בהצלחה", lost: "אבדה" },
      },
      { name: "value", label: "שווי", type: "number" },
      { name: "closeDeadline", label: "תאריך סגירה משוער", type: "date" },
      { name: "owner", label: "אחראי/ת", type: "text" },
    ],
  },
  {
    name: "Task",
    label: "משימה",
    fields: [
      { name: "title", label: "כותרת", type: "text", required: true },
      { name: "assignee", label: "אחראי/ת", type: "text" },
      { name: "dueDate", label: "תאריך יעד", type: "date" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["todo", "inprogress", "done"],
        enumLabels: { todo: "לביצוע", inprogress: "בתהליך", done: "בוצע" },
      },
      { name: "deal", label: "עסקה", type: "relation", relationTo: "Deal" },
    ],
  },
];

const CRM_ENTITIES_EN: EntitySpec[] = [
  {
    name: "Customer",
    label: "Customer",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "company", label: "Company", type: "text" },
      { name: "email", label: "Email", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        enumLabels: { New: "New", Contacted: "Contacted", Qualified: "Qualified", Won: "Won", Lost: "Lost" },
      },
      { name: "source", label: "Source", type: "text" },
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
  {
    name: "Contact",
    label: "Contact",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "jobTitle", label: "Job Title", type: "text" },
      { name: "email", label: "Email", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
      // Round 1706: see the Hebrew CRM_ENTITIES' own comment above.
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer", required: true },
    ],
  },
  {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer", required: true },
      {
        name: "stage",
        label: "Stage",
        type: "enum",
        required: true,
        enumValues: ["lead", "qualified", "proposal", "won", "lost"],
        enumLabels: { lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" },
      },
      { name: "value", label: "Value", type: "number" },
      { name: "closeDeadline", label: "Expected Close Date", type: "date" },
      { name: "owner", label: "Owner", type: "text" },
    ],
  },
  {
    name: "Task",
    label: "Task",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "assignee", label: "Assignee", type: "text" },
      { name: "dueDate", label: "Due Date", type: "date" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["todo", "inprogress", "done"],
        enumLabels: { todo: "To Do", inprogress: "In Progress", done: "Done" },
      },
      { name: "deal", label: "Deal", type: "relation", relationTo: "Deal" },
    ],
  },
];

const PROJECT_TRACKER_ENTITIES: EntitySpec[] = [
  {
    // Round 1999: TeamMember's field set is the matching domainEntities.ts
    // Employee domain rule's own field set (name/role/email/phone/active)
    // minus `role`/`active` -- a strict subset, the exact bug class rounds
    // 1898/1899 already fixed for the Restaurant/Appointments Customer
    // entity and the CRM Deal entity. This template's own stored
    // description ("Projects, milestones, tasks and team members.") contains
    // the bare substring "team member", one of the Employee rule's own
    // keywords -- so /refine's combinedDescription re-triggers it on every
    // single refine of a project built from this template, regardless of
    // what the new instruction actually asks for. Before round 1911, that
    // regenerated "Employee" candidate was added as an unrelated, duplicate
    // entity (fixed there); round 1911's own entityMergeKey/ENTITY_ALIAS_GROUPS
    // fix made it correctly fold into this TeamMember entity instead -- but
    // that round's own doc comment explicitly treats the resulting field
    // bolt-on ("gaining any genuinely new fields like role/active") as
    // expected, normal merge behavior, never circling back to apply the
    // same preemptive-field-parity fix rounds 1898/1899 already established
    // for this exact symptom. Confirmed live via mergeRefinedSpec +
    // HeuristicSpecProvider.generate against this template's own real
    // description: an unrelated refine instruction ("Add a Notes field to
    // Milestone") silently added both `role` and `active` to every
    // TeamMember record. `active` is added here verbatim; `jobTitle`
    // already covers the same real-world concept `role` otherwise would
    // (both describe a team member's position), but merges by exact field
    // NAME, not meaning, so a bare `role` field is still added below to
    // fully close the gap -- the identical "mirror the domain rule's field
    // list" approach every round in this family uses, with no exception for
    // a near-synonymous existing field.
    name: "TeamMember",
    label: "איש צוות",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "email", label: "אימייל", type: "text" },
      { name: "phone", label: "טלפון", type: "text" },
      { name: "jobTitle", label: "תפקיד", type: "text" },
      { name: "role", label: "תפקיד", type: "text" },
      { name: "active", label: "פעיל/ה", type: "boolean" },
    ],
  },
  {
    name: "Project",
    label: "פרויקט",
    fields: [
      { name: "name", label: "שם הפרויקט", type: "text", required: true },
      { name: "description", label: "תיאור", type: "longtext" },
      { name: "client", label: "לקוח", type: "text" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["planning", "active", "onhold", "completed"],
        enumLabels: { planning: "בתכנון", active: "פעיל", onhold: "בהמתנה", completed: "הושלם" },
      },
      { name: "deadline", label: "תאריך יעד", type: "date" },
      { name: "budget", label: "תקציב", type: "number" },
      { name: "owner", label: "אחראי", type: "relation", relationTo: "TeamMember" },
    ],
  },
  {
    name: "Milestone",
    label: "אבן דרך",
    fields: [
      { name: "title", label: "כותרת", type: "text", required: true },
      { name: "dueDate", label: "תאריך יעד", type: "date" },
      { name: "done", label: "הושלם", type: "boolean" },
      // Round 1706: a milestone or task with no linked project isn't a
      // meaningful record (unlike Task.assignee/Project.owner below,
      // deliberately left optional: an unassigned task or an unowned
      // project are normal, legitimate states).
      { name: "project", label: "פרויקט", type: "relation", relationTo: "Project", required: true },
    ],
  },
  {
    name: "Task",
    label: "משימה",
    fields: [
      { name: "title", label: "כותרת", type: "text", required: true },
      { name: "assignee", label: "מבצע", type: "relation", relationTo: "TeamMember" },
      { name: "project", label: "פרויקט", type: "relation", relationTo: "Project", required: true },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["todo", "inprogress", "done"],
        enumLabels: { todo: "לביצוע", inprogress: "בתהליך", done: "בוצע" },
      },
      {
        name: "priority",
        label: "עדיפות",
        type: "enum",
        enumValues: ["low", "medium", "high"],
        enumLabels: { low: "נמוכה", medium: "בינונית", high: "גבוהה" },
      },
      { name: "dueDate", label: "תאריך יעד", type: "date" },
    ],
  },
];

const PROJECT_TRACKER_ENTITIES_EN: EntitySpec[] = [
  {
    // Round 1999: see the Hebrew PROJECT_TRACKER_ENTITIES' own comment above.
    name: "TeamMember",
    label: "Team Member",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "email", label: "Email", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
      { name: "jobTitle", label: "Job Title", type: "text" },
      { name: "role", label: "Role", type: "text" },
      { name: "active", label: "Active", type: "boolean" },
    ],
  },
  {
    name: "Project",
    label: "Project",
    fields: [
      { name: "name", label: "Project Name", type: "text", required: true },
      { name: "description", label: "Description", type: "longtext" },
      { name: "client", label: "Client", type: "text" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["planning", "active", "onhold", "completed"],
        enumLabels: { planning: "Planning", active: "Active", onhold: "On Hold", completed: "Completed" },
      },
      { name: "deadline", label: "Deadline", type: "date" },
      { name: "budget", label: "Budget", type: "number" },
      { name: "owner", label: "Owner", type: "relation", relationTo: "TeamMember" },
    ],
  },
  {
    name: "Milestone",
    label: "Milestone",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "dueDate", label: "Due Date", type: "date" },
      { name: "done", label: "Completed", type: "boolean" },
      // Round 1706: see the Hebrew PROJECT_TRACKER_ENTITIES' own comment above.
      { name: "project", label: "Project", type: "relation", relationTo: "Project", required: true },
    ],
  },
  {
    name: "Task",
    label: "Task",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "assignee", label: "Assignee", type: "relation", relationTo: "TeamMember" },
      { name: "project", label: "Project", type: "relation", relationTo: "Project", required: true },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["todo", "inprogress", "done"],
        enumLabels: { todo: "To Do", inprogress: "In Progress", done: "Done" },
      },
      {
        name: "priority",
        label: "Priority",
        type: "enum",
        enumValues: ["low", "medium", "high"],
        enumLabels: { low: "Low", medium: "Medium", high: "High" },
      },
      { name: "dueDate", label: "Due Date", type: "date" },
    ],
  },
];

const VOLUNTEER_ENTITIES: EntitySpec[] = [
  {
    name: "Volunteer",
    label: "מתנדב/ת",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "phone", label: "טלפון", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
      { name: "role", label: "תפקיד", type: "text" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["active", "inactive"],
        enumLabels: { active: "פעיל/ה", inactive: "לא פעיל/ה" },
      },
      { name: "joinedDate", label: "תאריך הצטרפות", type: "date" },
      { name: "skills", label: "כישורים", type: "text" },
    ],
  },
  {
    name: "VolunteerEvent",
    label: "אירוע",
    fields: [
      { name: "name", label: "שם האירוע", type: "text", required: true },
      { name: "date", label: "תאריך", type: "date" },
      { name: "location", label: "מיקום", type: "text" },
      { name: "description", label: "תיאור", type: "longtext" },
    ],
  },
  {
    name: "Shift",
    label: "משמרת",
    fields: [
      // Round 1706: a shift with no linked event and no linked volunteer
      // isn't a meaningful record at all -- same severity as round 1705's
      // Appointment fix (both relations are core to what a Shift even is).
      { name: "event", label: "אירוע", type: "relation", relationTo: "VolunteerEvent", required: true },
      { name: "volunteer", label: "מתנדב/ת", type: "relation", relationTo: "Volunteer", required: true },
      { name: "timeRange", label: "טווח שעות", type: "text" },
      { name: "confirmed", label: "מאושרת", type: "boolean" },
    ],
  },
];

const VOLUNTEER_ENTITIES_EN: EntitySpec[] = [
  {
    name: "Volunteer",
    label: "Volunteer",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "phone", label: "Phone", type: "text" },
      { name: "email", label: "Email", type: "text" },
      { name: "role", label: "Role", type: "text" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["active", "inactive"],
        enumLabels: { active: "Active", inactive: "Inactive" },
      },
      { name: "joinedDate", label: "Joined Date", type: "date" },
      { name: "skills", label: "Skills", type: "text" },
    ],
  },
  {
    name: "VolunteerEvent",
    label: "Event",
    fields: [
      { name: "name", label: "Event Name", type: "text", required: true },
      { name: "date", label: "Date", type: "date" },
      { name: "location", label: "Location", type: "text" },
      { name: "description", label: "Description", type: "longtext" },
    ],
  },
  {
    name: "Shift",
    label: "Shift",
    fields: [
      // Round 1706: see the Hebrew VOLUNTEER_ENTITIES' own comment above.
      { name: "event", label: "Event", type: "relation", relationTo: "VolunteerEvent", required: true },
      { name: "volunteer", label: "Volunteer", type: "relation", relationTo: "Volunteer", required: true },
      { name: "timeRange", label: "Time Range", type: "text" },
      { name: "confirmed", label: "Confirmed", type: "boolean" },
    ],
  },
];

const APPOINTMENTS_ENTITIES: EntitySpec[] = [
  {
    name: "Customer",
    label: "לקוח",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "phone", label: "טלפון", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        enumLabels: { New: "חדש", Contacted: "יצרנו קשר", Qualified: "מתאים", Won: "הצליח", Lost: "לא הצליח" },
      },
      { name: "source", label: "מקור", type: "text" },
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
  {
    // Round 1999: see PROJECT_TRACKER_ENTITIES's own TeamMember comment --
    // this template's own description ("Clients, staff, services and
    // scheduled appointments.") contains the bare word "staff", one of the
    // same Employee domain rule's own keywords (round 1911's own write-up
    // already names this exact second alias), so this entity has the
    // identical gap. Unlike TeamMember, Staff has no existing field that
    // already covers "role" (no jobTitle-style field at all), so both
    // fields are added here with zero redundancy.
    name: "Staff",
    label: "צוות",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "specialty", label: "תחום התמחות", type: "text" },
      { name: "phone", label: "טלפון", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
      { name: "role", label: "תפקיד", type: "text" },
      { name: "active", label: "פעיל/ה", type: "boolean" },
    ],
  },
  {
    name: "Service",
    label: "שירות",
    fields: [
      { name: "name", label: "שם השירות", type: "text", required: true },
      { name: "durationMinutes", label: "משך בדקות", type: "number" },
      { name: "price", label: "מחיר", type: "number" },
      { name: "description", label: "תיאור", type: "longtext" },
    ],
  },
  {
    name: "Appointment",
    label: "תור",
    fields: [
      // Round 1705: same shape as round 1704's Restaurant Order fix -- an
      // appointment with no customer, no staff member, and no service
      // isn't a meaningful record, but none of these three relations were
      // required, so seed.ts's seedValueFor left all three null instead of
      // linking to the real Customer/Staff/Service rows that do exist.
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer", required: true },
      { name: "staff", label: "איש צוות", type: "relation", relationTo: "Staff", required: true },
      { name: "service", label: "שירות", type: "relation", relationTo: "Service", required: true },
      { name: "date", label: "תאריך", type: "date", required: true },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["scheduled", "completed", "cancelled", "no-show"],
        enumLabels: { scheduled: "מתוכנן", completed: "הושלם", cancelled: "בוטל", "no-show": "לא הגיע" },
      },
      { name: "notes", label: "הערות", type: "longtext" },
      // Round 2008: this entity's own description ("פגישה מתוזמנת עם לקוח.")
      // and this template's own stored description ("לקוחות, צוות, שירותים
      // ותורים מתוזמנים.") both contain the bare word "תור"/"appointment",
      // one of domainEntities.ts's own Appointment domain rule's keywords --
      // so /refine's combinedDescription re-triggers that rule on literally
      // any future refine of a project built from this template, and
      // mergeRefinedSpec's exact-name entity match (no alias needed, both
      // are named "Appointment") folds the regenerated candidate's fields
      // into this template's own Appointment entity, same mechanism as
      // round 1999's TeamMember/Staff fix. The domain rule's own `customerName`
      // (text, required) field was missing here by name -- unlike TeamMember/
      // role, it can't just be mirrored verbatim as `required: true`: this
      // entity already has a real `customer` relation (richer than the
      // domain rule's denormalized shape, which has no Customer entity to
      // link to at all), and making a second, required, free-text "who is
      // this appointment for" field would force retyping the same customer's
      // name on every single record already identified by the relation
      // picker just above. Added here anyway, but deliberately left
      // optional, to close the real, live-reproduced bug (confirmed via a
      // direct HeuristicSpecProvider.generate + mergeRefinedSpec repro: an
      // unrelated refine instruction silently added a required `customerName`
      // text field to every Appointment record) without the required-field
      // UX regression a strict mirror would add.
      { name: "customerName", label: "שם לקוח", type: "text" },
    ],
  },
];

const APPOINTMENTS_ENTITIES_EN: EntitySpec[] = [
  {
    name: "Customer",
    label: "Customer",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "phone", label: "Phone", type: "text" },
      { name: "email", label: "Email", type: "text" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        enumLabels: { New: "New", Contacted: "Contacted", Qualified: "Qualified", Won: "Won", Lost: "Lost" },
      },
      { name: "source", label: "Source", type: "text" },
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
  {
    // Round 1999: see the Hebrew APPOINTMENTS_ENTITIES' own Staff comment above.
    name: "Staff",
    label: "Staff",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "specialty", label: "Specialty", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
      { name: "email", label: "Email", type: "text" },
      { name: "role", label: "Role", type: "text" },
      { name: "active", label: "Active", type: "boolean" },
    ],
  },
  {
    name: "Service",
    label: "Service",
    fields: [
      { name: "name", label: "Service Name", type: "text", required: true },
      { name: "durationMinutes", label: "Duration (minutes)", type: "number" },
      { name: "price", label: "Price", type: "number" },
      { name: "description", label: "Description", type: "longtext" },
    ],
  },
  {
    name: "Appointment",
    label: "Appointment",
    fields: [
      // Round 1705: see the Hebrew APPOINTMENTS_ENTITIES' own comment above
      // -- same fix, same reasoning, kept in sync with its own Appointment entity.
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer", required: true },
      { name: "staff", label: "Staff Member", type: "relation", relationTo: "Staff", required: true },
      { name: "service", label: "Service", type: "relation", relationTo: "Service", required: true },
      { name: "date", label: "Date", type: "date", required: true },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["scheduled", "completed", "cancelled", "no-show"],
        enumLabels: { scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", "no-show": "No-show" },
      },
      { name: "notes", label: "Notes", type: "longtext" },
      // Round 2008: see the Hebrew APPOINTMENTS_ENTITIES' own comment above --
      // same fix, same reasoning (deliberately optional, not a strict mirror
      // of the domain rule's `required: true`), kept in sync with its own
      // Appointment entity.
      { name: "customerName", label: "Customer Name", type: "text" },
    ],
  },
];

const INVENTORY_ENTITIES: EntitySpec[] = [
  {
    name: "Supplier",
    label: "ספק",
    fields: [
      { name: "name", label: "שם הספק", type: "text", required: true },
      { name: "contactPerson", label: "איש קשר", type: "text" },
      { name: "phone", label: "טלפון", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
      {
        name: "category",
        label: "קטגוריה",
        type: "enum",
        required: true,
        enumValues: ["goods", "services", "both"],
        enumLabels: { goods: "סחורה", services: "שירותים", both: "שניהם" },
      },
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
  {
    name: "Product",
    label: "מוצר",
    fields: [
      { name: "name", label: "שם המוצר", type: "text", required: true },
      { name: "sku", label: "מק\"ט", type: "text" },
      { name: "price", label: "מחיר", type: "number" },
      { name: "quantity", label: "כמות במלאי", type: "number" },
      { name: "supplier", label: "ספק", type: "relation", relationTo: "Supplier" },
      {
        name: "category",
        label: "קטגוריה",
        type: "enum",
        enumValues: ["raw", "finished", "packaging"],
        enumLabels: { raw: "חומר גלם", finished: "מוצר מוגמר", packaging: "אריזה" },
      },
    ],
  },
  {
    name: "PurchaseOrder",
    label: "הזמנת רכש",
    fields: [
      // Round 1706: a purchase order with no supplier, or a stock movement
      // with no product, isn't a meaningful record (unlike Product.supplier
      // below, deliberately left optional: a product can legitimately exist
      // with no tracked supplier yet, e.g. in-house manufactured goods).
      { name: "supplier", label: "ספק", type: "relation", relationTo: "Supplier", required: true },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["draft", "ordered", "received", "cancelled"],
        enumLabels: { draft: "טיוטה", ordered: "הוזמן", received: "התקבל", cancelled: "בוטל" },
      },
      { name: "orderDate", label: "תאריך הזמנה", type: "date" },
      { name: "total", label: "סכום כולל", type: "number" },
      { name: "items", label: "פריטים", type: "longtext" },
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
  {
    name: "StockMovement",
    label: "תנועת מלאי",
    fields: [
      { name: "product", label: "מוצר", type: "relation", relationTo: "Product", required: true },
      {
        name: "movementType",
        label: "סוג תנועה",
        type: "enum",
        required: true,
        enumValues: ["in", "out", "adjustment"],
        enumLabels: { in: "כניסה", out: "יציאה", adjustment: "התאמה" },
      },
      { name: "quantity", label: "כמות", type: "number", required: true },
      { name: "date", label: "תאריך", type: "date" },
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
];

const INVENTORY_ENTITIES_EN: EntitySpec[] = [
  {
    name: "Supplier",
    label: "Supplier",
    fields: [
      { name: "name", label: "Supplier Name", type: "text", required: true },
      { name: "contactPerson", label: "Contact Person", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
      { name: "email", label: "Email", type: "text" },
      {
        name: "category",
        label: "Category",
        type: "enum",
        required: true,
        enumValues: ["goods", "services", "both"],
        enumLabels: { goods: "Goods", services: "Services", both: "Both" },
      },
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
  {
    name: "Product",
    label: "Product",
    fields: [
      { name: "name", label: "Product Name", type: "text", required: true },
      { name: "sku", label: "SKU", type: "text" },
      { name: "price", label: "Price", type: "number" },
      { name: "quantity", label: "Quantity in Stock", type: "number" },
      { name: "supplier", label: "Supplier", type: "relation", relationTo: "Supplier" },
      {
        name: "category",
        label: "Category",
        type: "enum",
        enumValues: ["raw", "finished", "packaging"],
        enumLabels: { raw: "Raw Material", finished: "Finished Product", packaging: "Packaging" },
      },
    ],
  },
  {
    name: "PurchaseOrder",
    label: "Purchase Order",
    fields: [
      // Round 1706: see the Hebrew INVENTORY_ENTITIES' own comment above.
      { name: "supplier", label: "Supplier", type: "relation", relationTo: "Supplier", required: true },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["draft", "ordered", "received", "cancelled"],
        enumLabels: { draft: "Draft", ordered: "Ordered", received: "Received", cancelled: "Cancelled" },
      },
      { name: "orderDate", label: "Order Date", type: "date" },
      { name: "total", label: "Total Amount", type: "number" },
      { name: "items", label: "Items", type: "longtext" },
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
  {
    name: "StockMovement",
    label: "Stock Movement",
    fields: [
      { name: "product", label: "Product", type: "relation", relationTo: "Product", required: true },
      {
        name: "movementType",
        label: "Movement Type",
        type: "enum",
        required: true,
        enumValues: ["in", "out", "adjustment"],
        enumLabels: { in: "In", out: "Out", adjustment: "Adjustment" },
      },
      { name: "quantity", label: "Quantity", type: "number", required: true },
      { name: "date", label: "Date", type: "date" },
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
];

export const TEMPLATES: AppTemplate[] = [
  {
    id: "restaurant",
    icon: "🍽️",
    name: "Restaurant Management",
    nameHe: "ניהול מסעדה",
    description: "Menu, tables, customers and orders, ready to run.",
    descriptionHe: "תפריט, שולחנות, לקוחות והזמנות -- מוכן להרצה.",
    spec: spec({
      summary: "מערכת לניהול מסעדה -- תפריט, שולחנות, לקוחות והזמנות.",
      roles: ["מנהל/ת", "צוות"],
      entities: RESTAURANT_ENTITIES,
    }),
    specEn: spec({
      summary: "A restaurant management system -- menu, tables, customers and orders.",
      roles: ["Manager", "Staff"],
      entities: RESTAURANT_ENTITIES_EN,
      isHebrew: false,
    }),
  },
  {
    id: "crm",
    icon: "📈",
    name: "Sales CRM",
    nameHe: "CRM לניהול לקוחות ועסקאות",
    description: "Customers, contacts, deals and follow-up tasks.",
    descriptionHe: "לקוחות, אנשי קשר, עסקאות ומשימות מעקב.",
    spec: spec({
      summary: "מערכת CRM לניהול לקוחות, אנשי קשר, עסקאות ומשימות מעקב.",
      roles: ["נציג/ת מכירות", "מנהל/ת"],
      entities: CRM_ENTITIES,
    }),
    specEn: spec({
      summary: "A CRM system for managing customers, contacts, deals and follow-up tasks.",
      roles: ["Sales Rep", "Manager"],
      entities: CRM_ENTITIES_EN,
      isHebrew: false,
    }),
  },
  {
    id: "project-tracker",
    icon: "📋",
    name: "Project & Team Tracker",
    nameHe: "מעקב פרויקטים וצוות",
    description: "Projects, milestones, tasks and team members.",
    descriptionHe: "פרויקטים, אבני דרך, משימות ואנשי צוות.",
    spec: spec({
      summary: "מערכת למעקב פרויקטים -- אבני דרך, משימות ואנשי צוות.",
      roles: ["מנהל/ת פרויקט", "חבר/ת צוות"],
      entities: PROJECT_TRACKER_ENTITIES,
    }),
    specEn: spec({
      summary: "A project tracking system -- milestones, tasks and team members.",
      roles: ["Project Manager", "Team Member"],
      entities: PROJECT_TRACKER_ENTITIES_EN,
      isHebrew: false,
    }),
  },
  {
    id: "volunteers",
    icon: "🤝",
    name: "Volunteer & Shift Management",
    nameHe: "ניהול מתנדבים ומשמרות",
    description: "Volunteers, events and shift scheduling.",
    descriptionHe: "מתנדבים, אירועים וניהול משמרות.",
    spec: spec({
      summary: "מערכת לניהול מתנדבים, אירועים ושיבוץ משמרות.",
      roles: ["רכז/ת", "מתנדב/ת"],
      entities: VOLUNTEER_ENTITIES,
    }),
    specEn: spec({
      summary: "A volunteer management system -- events and shift scheduling.",
      roles: ["Coordinator", "Volunteer"],
      entities: VOLUNTEER_ENTITIES_EN,
      isHebrew: false,
    }),
  },
  {
    id: "appointments",
    icon: "📅",
    name: "Appointments & Clients",
    nameHe: "מערכת תורים ולקוחות",
    description: "Clients, staff, services and scheduled appointments.",
    descriptionHe: "לקוחות, צוות, שירותים ותורים מתוזמנים.",
    spec: spec({
      summary: "מערכת לניהול תורים -- לקוחות, צוות, שירותים ותורים מתוזמנים.",
      roles: ["צוות", "לקוח/ה"],
      entities: APPOINTMENTS_ENTITIES,
      // Round 1975: see paymentOpenQuestion's own doc comment -- none of
      // this template's entities (Customer/Staff/Service/Appointment) is
      // in BILLING_ENTITY_NAMES, so without this every project built from
      // this template (a textbook paid salon/spa/clinic/personal-training
      // business, confirmed by its own Service.price field) always got
      // the wrong "No payments" default.
      forcePaymentsQuestion: true,
    }),
    specEn: spec({
      summary: "An appointment management system -- clients, staff, services and scheduled appointments.",
      roles: ["Staff", "Customer"],
      entities: APPOINTMENTS_ENTITIES_EN,
      isHebrew: false,
      forcePaymentsQuestion: true,
    }),
  },
  {
    id: "inventory",
    icon: "📦",
    name: "Inventory & Products",
    nameHe: "ניהול מלאי ומוצרים",
    description: "Products, suppliers, purchase orders and stock movements.",
    descriptionHe: "מוצרים, ספקים, הזמנות רכש ותנועות מלאי.",
    spec: spec({
      summary: "מערכת לניהול מלאי -- מוצרים, ספקים, הזמנות רכש ותנועות מלאי.",
      roles: ["מנהל/ת מחסן", "קניין/ית"],
      entities: INVENTORY_ENTITIES,
    }),
    specEn: spec({
      summary: "An inventory management system -- products, suppliers, purchase orders and stock movements.",
      roles: ["Warehouse Manager", "Buyer"],
      entities: INVENTORY_ENTITIES_EN,
      isHebrew: false,
    }),
  },
];
