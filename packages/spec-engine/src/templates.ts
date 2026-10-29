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
const BILLING_ENTITY_NAMES = new Set(["Invoice", "Order", "Donation", "Subscription", "Rental", "Property", "MenuItem"]);

/**
 * Round 1248: mirrors heuristic.ts's own buildOpenQuestions exactly for
 * the one question it always asks (payment provider) -- a template's
 * entities are fixed data known at module-load time, so there's no
 * description text to scan for PAYMENT_KEYWORDS the way heuristic.ts's own
 * provider does; only the entity-name check applies here.
 */
function paymentOpenQuestion(entities: EntitySpec[], isHebrew: boolean): OpenQuestion[] {
  const needsPayments = entities.some((e) => BILLING_ENTITY_NAMES.has(e.name));
  if (!needsPayments) return [];
  return isHebrew
    ? [{ question: "באיזה ספק תשלומים כדאי להשתמש?", options: ["Stripe", "PayPal", "בלי תשלומים", "תחליטו בשבילי"], recommendation: "Stripe" }]
    : [{ question: "Which payment provider should this use?", options: ["Stripe", "PayPal", "No payments", "Decide for me"], recommendation: "Stripe" }];
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

function spec(input: {
  summary: string;
  roles: string[];
  entities: EntitySpec[];
  personas?: string[];
  assumptions?: string[];
  isHebrew?: boolean;
}): ProductSpec {
  return ProductSpecSchema.parse({
    summary: input.summary,
    personas: input.personas ?? [],
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
    openQuestions: paymentOpenQuestion(input.entities, input.isHebrew ?? true),
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
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
  {
    name: "Order",
    label: "הזמנה",
    fields: [
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer" },
      { name: "table", label: "שולחן", type: "relation", relationTo: "RestaurantTable" },
      {
        name: "status",
        label: "סטטוס הזמנה",
        type: "enum",
        required: true,
        enumValues: ["pending", "preparing", "served", "paid"],
        enumLabels: { pending: "בהמתנה", preparing: "בהכנה", served: "הוגש", paid: "שולם" },
      },
      { name: "total", label: "סכום כולל", type: "number" },
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
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
  {
    name: "Order",
    label: "Order",
    fields: [
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer" },
      { name: "table", label: "Table", type: "relation", relationTo: "RestaurantTable" },
      {
        name: "status",
        label: "Order Status",
        type: "enum",
        required: true,
        enumValues: ["pending", "preparing", "served", "paid"],
        enumLabels: { pending: "Pending", preparing: "Preparing", served: "Served", paid: "Paid" },
      },
      { name: "total", label: "Total Amount", type: "number" },
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
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer" },
    ],
  },
  {
    name: "Deal",
    label: "עסקה",
    fields: [
      { name: "title", label: "כותרת", type: "text", required: true },
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer" },
      {
        name: "stage",
        label: "שלב",
        type: "enum",
        required: true,
        enumValues: ["lead", "qualified", "proposal", "won", "lost"],
        enumLabels: { lead: "ליד", qualified: "הוכשר", proposal: "הצעת מחיר", won: "נסגרה בהצלחה", lost: "אבדה" },
      },
      { name: "value", label: "שווי", type: "number" },
      { name: "closeDate", label: "תאריך סגירה משוער", type: "date" },
    ],
  },
  {
    name: "Task",
    label: "משימה",
    fields: [
      { name: "title", label: "כותרת", type: "text", required: true },
      { name: "dueDate", label: "תאריך יעד", type: "date" },
      { name: "done", label: "בוצע", type: "boolean" },
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
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer" },
    ],
  },
  {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer" },
      {
        name: "stage",
        label: "Stage",
        type: "enum",
        required: true,
        enumValues: ["lead", "qualified", "proposal", "won", "lost"],
        enumLabels: { lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" },
      },
      { name: "value", label: "Value", type: "number" },
      { name: "closeDate", label: "Expected Close Date", type: "date" },
    ],
  },
  {
    name: "Task",
    label: "Task",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "dueDate", label: "Due Date", type: "date" },
      { name: "done", label: "Done", type: "boolean" },
      { name: "deal", label: "Deal", type: "relation", relationTo: "Deal" },
    ],
  },
];

const PROJECT_TRACKER_ENTITIES: EntitySpec[] = [
  {
    name: "TeamMember",
    label: "איש צוות",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "email", label: "אימייל", type: "text" },
      { name: "jobTitle", label: "תפקיד", type: "text" },
    ],
  },
  {
    name: "Project",
    label: "פרויקט",
    fields: [
      { name: "name", label: "שם הפרויקט", type: "text", required: true },
      { name: "description", label: "תיאור", type: "longtext" },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["planning", "active", "onhold", "completed"],
        enumLabels: { planning: "בתכנון", active: "פעיל", onhold: "בהמתנה", completed: "הושלם" },
      },
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
      { name: "project", label: "פרויקט", type: "relation", relationTo: "Project" },
    ],
  },
  {
    name: "Task",
    label: "משימה",
    fields: [
      { name: "title", label: "כותרת", type: "text", required: true },
      { name: "assignee", label: "מבצע", type: "relation", relationTo: "TeamMember" },
      { name: "project", label: "פרויקט", type: "relation", relationTo: "Project" },
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
    ],
  },
];

const PROJECT_TRACKER_ENTITIES_EN: EntitySpec[] = [
  {
    name: "TeamMember",
    label: "Team Member",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "email", label: "Email", type: "text" },
      { name: "jobTitle", label: "Job Title", type: "text" },
    ],
  },
  {
    name: "Project",
    label: "Project",
    fields: [
      { name: "name", label: "Project Name", type: "text", required: true },
      { name: "description", label: "Description", type: "longtext" },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["planning", "active", "onhold", "completed"],
        enumLabels: { planning: "Planning", active: "Active", onhold: "On Hold", completed: "Completed" },
      },
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
      { name: "project", label: "Project", type: "relation", relationTo: "Project" },
    ],
  },
  {
    name: "Task",
    label: "Task",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "assignee", label: "Assignee", type: "relation", relationTo: "TeamMember" },
      { name: "project", label: "Project", type: "relation", relationTo: "Project" },
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
      { name: "event", label: "אירוע", type: "relation", relationTo: "VolunteerEvent" },
      { name: "volunteer", label: "מתנדב/ת", type: "relation", relationTo: "Volunteer" },
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
      { name: "event", label: "Event", type: "relation", relationTo: "VolunteerEvent" },
      { name: "volunteer", label: "Volunteer", type: "relation", relationTo: "Volunteer" },
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
      { name: "notes", label: "הערות", type: "longtext" },
    ],
  },
  {
    name: "Staff",
    label: "צוות",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "specialty", label: "תחום התמחות", type: "text" },
      { name: "phone", label: "טלפון", type: "text" },
    ],
  },
  {
    name: "Service",
    label: "שירות",
    fields: [
      { name: "name", label: "שם השירות", type: "text", required: true },
      { name: "durationMinutes", label: "משך בדקות", type: "number" },
      { name: "price", label: "מחיר", type: "number" },
    ],
  },
  {
    name: "Appointment",
    label: "תור",
    fields: [
      { name: "customer", label: "לקוח", type: "relation", relationTo: "Customer" },
      { name: "staff", label: "איש צוות", type: "relation", relationTo: "Staff" },
      { name: "service", label: "שירות", type: "relation", relationTo: "Service" },
      { name: "date", label: "תאריך", type: "date", required: true },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["scheduled", "completed", "cancelled", "noshow"],
        enumLabels: { scheduled: "מתוכנן", completed: "הושלם", cancelled: "בוטל", noshow: "לא הגיע" },
      },
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
      { name: "notes", label: "Notes", type: "longtext" },
    ],
  },
  {
    name: "Staff",
    label: "Staff",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "specialty", label: "Specialty", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
    ],
  },
  {
    name: "Service",
    label: "Service",
    fields: [
      { name: "name", label: "Service Name", type: "text", required: true },
      { name: "durationMinutes", label: "Duration (minutes)", type: "number" },
      { name: "price", label: "Price", type: "number" },
    ],
  },
  {
    name: "Appointment",
    label: "Appointment",
    fields: [
      { name: "customer", label: "Customer", type: "relation", relationTo: "Customer" },
      { name: "staff", label: "Staff Member", type: "relation", relationTo: "Staff" },
      { name: "service", label: "Service", type: "relation", relationTo: "Service" },
      { name: "date", label: "Date", type: "date", required: true },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["scheduled", "completed", "cancelled", "noshow"],
        enumLabels: { scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", noshow: "No-show" },
      },
    ],
  },
];

const INVENTORY_ENTITIES: EntitySpec[] = [
  {
    name: "Supplier",
    label: "ספק",
    fields: [
      { name: "name", label: "שם הספק", type: "text", required: true },
      { name: "phone", label: "טלפון", type: "text" },
      { name: "email", label: "אימייל", type: "text" },
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
      { name: "supplier", label: "ספק", type: "relation", relationTo: "Supplier" },
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
    ],
  },
  {
    name: "StockMovement",
    label: "תנועת מלאי",
    fields: [
      { name: "product", label: "מוצר", type: "relation", relationTo: "Product" },
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
      { name: "phone", label: "Phone", type: "text" },
      { name: "email", label: "Email", type: "text" },
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
      { name: "supplier", label: "Supplier", type: "relation", relationTo: "Supplier" },
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
    ],
  },
  {
    name: "StockMovement",
    label: "Stock Movement",
    fields: [
      { name: "product", label: "Product", type: "relation", relationTo: "Product" },
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
    }),
    specEn: spec({
      summary: "An appointment management system -- clients, staff, services and scheduled appointments.",
      roles: ["Staff", "Customer"],
      entities: APPOINTMENTS_ENTITIES_EN,
      isHebrew: false,
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
