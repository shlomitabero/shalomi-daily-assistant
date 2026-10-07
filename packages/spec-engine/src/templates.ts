import { type ProductSpec, ProductSpecSchema } from "@forge/shared";

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
  spec: ProductSpec;
}

type EntitySpec = ProductSpec["entities"][number];

function screensFor(entityNames: string[]): ProductSpec["screens"] {
  return [
    { name: "Dashboard", type: "dashboard" },
    ...entityNames.map((name) => ({ name, type: "list" as const, entity: name })),
  ];
}

function spec(input: {
  summary: string;
  roles: string[];
  entities: EntitySpec[];
  personas?: string[];
  assumptions?: string[];
}): ProductSpec {
  return ProductSpecSchema.parse({
    summary: input.summary,
    personas: input.personas ?? [],
    roles: input.roles,
    entities: input.entities,
    screens: screensFor(input.entities.map((e) => e.name)),
    assumptions: input.assumptions ?? [],
    openQuestions: [],
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
      { name: "date", label: "תאריך ושעה", type: "date", required: true },
      {
        name: "status",
        label: "סטטוס",
        type: "enum",
        required: true,
        enumValues: ["scheduled", "completed", "cancelled", "noshow"],
        enumLabels: { scheduled: "קבוע", completed: "הושלם", cancelled: "בוטל", noshow: "לא הגיע" },
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
      roles: ["Manager", "Staff"],
      entities: RESTAURANT_ENTITIES,
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
      roles: ["Sales Rep", "Manager"],
      entities: CRM_ENTITIES,
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
      roles: ["Project Manager", "Team Member"],
      entities: PROJECT_TRACKER_ENTITIES,
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
      roles: ["Coordinator", "Volunteer"],
      entities: VOLUNTEER_ENTITIES,
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
      roles: ["Staff", "Customer"],
      entities: APPOINTMENTS_ENTITIES,
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
      roles: ["Warehouse Manager", "Buyer"],
      entities: INVENTORY_ENTITIES,
    }),
  },
];
