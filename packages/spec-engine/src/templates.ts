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
      roles: ["Manager", "Staff"],
      entities: RESTAURANT_ENTITIES,
    }),
    specEn: spec({
      summary: "A restaurant management system -- menu, tables, customers and orders.",
      roles: ["Manager", "Staff"],
      entities: RESTAURANT_ENTITIES_EN,
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
    specEn: spec({
      summary: "A CRM system for managing customers, contacts, deals and follow-up tasks.",
      roles: ["Sales Rep", "Manager"],
      entities: CRM_ENTITIES_EN,
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
    specEn: spec({
      summary: "A project tracking system -- milestones, tasks and team members.",
      roles: ["Project Manager", "Team Member"],
      entities: PROJECT_TRACKER_ENTITIES_EN,
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
    specEn: spec({
      summary: "A volunteer management system -- events and shift scheduling.",
      roles: ["Coordinator", "Volunteer"],
      entities: VOLUNTEER_ENTITIES_EN,
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
    specEn: spec({
      summary: "An appointment management system -- clients, staff, services and scheduled appointments.",
      roles: ["Staff", "Customer"],
      entities: APPOINTMENTS_ENTITIES_EN,
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
    specEn: spec({
      summary: "An inventory management system -- products, suppliers, purchase orders and stock movements.",
      roles: ["Warehouse Manager", "Buyer"],
      entities: INVENTORY_ENTITIES_EN,
    }),
  },
];
