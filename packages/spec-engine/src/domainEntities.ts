import type { Entity } from "@forge/shared";

/**
 * Keyword-triggered library of common business entities. This is the corpus
 * the heuristic (offline, no-LLM) provider matches against. Real accuracy
 * comes from the Anthropic provider; this exists so Forge AI works with zero
 * configuration and produces deterministic, testable output.
 *
 * Each rule carries both English and Hebrew trigger keywords, plus a Hebrew
 * label for the entity and each of its fields. `entity.name`/`field.name`
 * stay fixed, ASCII, English identifiers always — they become real SQL
 * table/column names (see packages/db) and Hebrew text can't safely be one
 * (see identifiers.ts). `labelHe`/`fieldLabelsHe` are purely UI-facing
 * display text, attached onto the entity/field as `label` when the user's
 * description is in Hebrew (see heuristic.ts).
 *
 * Two keyword pitfalls to check for before adding a new one (both caught by
 * writing a real regression test, not by inspection):
 * 1. English substring collisions with a short/common word inside an
 *    unrelated word (e.g. "events" ⊂ "prevents", "pipeline" ⊂ "hiring
 *    pipeline" colliding with Deal's own "pipeline" keyword).
 * 2. Hebrew construct-state (סמיכות) and other suffix inflection: a keyword
 *    like "תמיכה" does NOT match "תמיכת לקוחות" ("customer support") as a
 *    substring, since the word's ending changes. Prefixes (ה/ו/ב/כ/ל/מ)
 *    don't break matching (the root stays contiguous at the end), but a
 *    changed suffix does — list the inflected form as its own keyword too
 *    (e.g. both "תמיכה" and "תמיכת") rather than assuming one form covers
 *    all of them.
 */
export interface DomainEntityRule {
  keywords: string[];
  entity: Entity;
  labelHe: string;
  descriptionHe: string;
  fieldLabelsHe: Record<string, string>;
  /** field name -> { raw enumValue -> Hebrew display text }. The stored value stays the raw enumValue. */
  enumLabelsHe?: Record<string, Record<string, string>>;
}

export const DOMAIN_ENTITY_RULES: DomainEntityRule[] = [
  {
    keywords: ["customer", "client", "lead", "לקוח", "לקוחה", "לקוחות", "קליינט"],
    labelHe: "לקוחות",
    descriptionHe: "לקוח או חברה שהעסק משרת.",
    fieldLabelsHe: {
      name: "שם",
      email: "אימייל",
      phone: "טלפון",
      status: "סטטוס",
      source: "מקור",
      notes: "הערות",
    },
    enumLabelsHe: {
      status: { New: "חדש", Contacted: "יצרנו קשר", Qualified: "מתאים", Won: "הצליח", Lost: "לא הצליח" },
    },
    entity: {
      name: "Customer",
      description: "A person or company the business serves.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["New", "Contacted", "Qualified", "Won", "Lost"],
        },
        { name: "source", type: "text", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    // Bare "תור" (singular "turn/appointment") is deliberately left out --
    // it's a substring of "תורם"/"תורמים" ("donor"/"donors", an unrelated
    // word that happens to share its first three letters), which would
    // make any donation-app description spuriously also produce an
    // Appointment entity. "תורים" (plural) doesn't have this problem and
    // is what every real appointment-related description already uses.
    keywords: ["appointment", "booking", "reservation", "schedule", "תורים", "פגישה", "פגישות"],
    labelHe: "תורים",
    descriptionHe: "פגישה מתוזמנת עם לקוח.",
    fieldLabelsHe: {
      customerName: "שם לקוח",
      date: "תאריך",
      service: "שירות",
      status: "סטטוס",
      notes: "הערות",
    },
    enumLabelsHe: {
      status: { Scheduled: "מתוכנן", Completed: "הושלם", Cancelled: "בוטל", "No-show": "לא הגיע/ה" },
    },
    entity: {
      name: "Appointment",
      description: "A scheduled time slot with a customer.",
      fields: [
        { name: "customerName", type: "text", required: true },
        { name: "date", type: "date", required: true },
        { name: "service", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Scheduled", "Completed", "Cancelled", "No-show"],
        },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["employee", "staff", "team member", "worker", "עובד", "עובדת", "עובדים", "צוות"],
    labelHe: "עובדים",
    descriptionHe: "מישהו שעובד בעסק.",
    fieldLabelsHe: { name: "שם", role: "תפקיד", email: "אימייל", active: "פעיל/ה" },
    entity: {
      name: "Employee",
      description: "A person who works for the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "role", type: "text", required: false },
        { name: "email", type: "text", required: false },
        { name: "active", type: "boolean", required: false },
      ],
    },
  },
  {
    keywords: ["invoice", "billing", "payment", "חשבונית", "חשבוניות", "חיוב", "חיובים"],
    labelHe: "חשבוניות",
    descriptionHe: "חשבון שנשלח ללקוח.",
    fieldLabelsHe: {
      customerName: "שם לקוח",
      amount: "סכום",
      status: "סטטוס",
      dueDate: "תאריך לתשלום",
      notes: "הערות",
    },
    enumLabelsHe: {
      status: { Draft: "טיוטה", Sent: "נשלחה", Paid: "שולמה", Overdue: "באיחור" },
    },
    entity: {
      name: "Invoice",
      description: "A bill issued to a customer.",
      fields: [
        { name: "customerName", type: "text", required: true },
        { name: "amount", type: "number", required: true },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Draft", "Sent", "Paid", "Overdue"],
        },
        { name: "dueDate", type: "date", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: [
      "order", "purchase", "checkout", "delivery", "deliveries", "wolt",
      "הזמנה", "הזמנות", "רכישה", "רכישות", "משלוח", "משלוחים", "וולט",
    ],
    labelHe: "הזמנות",
    descriptionHe: "רכישה שביצע לקוח.",
    fieldLabelsHe: {
      customerName: "שם לקוח",
      total: "סכום כולל",
      status: "סטטוס",
      items: "פריטים",
      courierId: "שליח מוקצה",
    },
    enumLabelsHe: {
      status: { Pending: "ממתינה", Shipped: "נשלחה", Delivered: "נמסרה", Cancelled: "בוטלה" },
    },
    entity: {
      name: "Order",
      description: "A purchase placed by a customer.",
      fields: [
        { name: "customerName", type: "text", required: true },
        { name: "total", type: "number", required: true },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Pending", "Shipped", "Delivered", "Cancelled"],
        },
        { name: "items", type: "longtext", required: false },
        // Optional, not required: when a description only mentions "order"
        // without a courier/driver, the Courier entity (and its table) won't
        // exist in the spec at all. Required here would either force an
        // invalid reference or block the build; null is a legitimate,
        // honest value for "not assigned yet" regardless.
        { name: "courierId", type: "relation", required: false, relationTo: "Courier" },
      ],
    },
  },
  {
    keywords: ["service", "treatment", "שירות", "שירותים", "טיפול", "טיפולים"],
    labelHe: "שירותים",
    descriptionHe: "משהו שהעסק מציע למכירה.",
    fieldLabelsHe: { name: "שם", price: "מחיר", durationMinutes: "משך בדקות", description: "תיאור" },
    entity: {
      name: "Service",
      description: "Something the business offers for sale.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "price", type: "number", required: false },
        { name: "durationMinutes", type: "number", required: false },
        { name: "description", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["product", "inventory", "stock", "מוצר", "מוצרים", "מלאי"],
    labelHe: "מוצרים",
    descriptionHe: "פריט שהעסק מוכר או עוקב אחריו.",
    fieldLabelsHe: { name: "שם", sku: 'מק"ט', price: "מחיר", quantity: "כמות" },
    entity: {
      name: "Product",
      description: "An item the business sells or tracks.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "sku", type: "text", required: false },
        { name: "price", type: "number", required: false },
        { name: "quantity", type: "number", required: false },
      ],
    },
  },
  {
    keywords: ["deal", "negotiation", "pipeline", "עסקה", "עסקאות", "משא ומתן"],
    labelHe: "עסקאות",
    descriptionHe: "עסקת מכירה פוטנציאלית.",
    fieldLabelsHe: { title: "כותרת", value: "שווי", stage: "שלב", owner: "אחראי/ת" },
    enumLabelsHe: {
      stage: { Lead: "ליד", Negotiation: "משא ומתן", Won: "נסגרה בהצלחה", Lost: "לא נסגרה" },
    },
    entity: {
      name: "Deal",
      description: "A potential sale being pursued.",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "value", type: "number", required: false },
        {
          name: "stage",
          type: "enum",
          required: true,
          enumValues: ["Lead", "Negotiation", "Won", "Lost"],
        },
        { name: "owner", type: "text", required: false },
      ],
    },
  },
  {
    keywords: [
      "menu", "dish", "food item", "restaurant", "cafe", "מסעדה", "מסעדות",
      "תפריט", "מנה", "מנות", "בית קפה",
    ],
    labelHe: "פריטי תפריט",
    descriptionHe: "מנה או מוצר בתפריט של מסעדה או בית קפה.",
    fieldLabelsHe: { name: "שם המנה", description: "תיאור", price: "מחיר", category: "קטגוריה", available: "זמין" },
    enumLabelsHe: {
      category: { Starter: "מנה ראשונה", Main: "מנה עיקרית", Dessert: "קינוח", Drink: "שתייה" },
    },
    entity: {
      name: "MenuItem",
      description: "A dish or product on a restaurant or cafe's menu.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "description", type: "longtext", required: false },
        { name: "price", type: "number", required: true },
        {
          name: "category",
          type: "enum",
          required: false,
          enumValues: ["Starter", "Main", "Dessert", "Drink"],
        },
        { name: "available", type: "boolean", required: false },
      ],
    },
  },
  {
    keywords: ["courier", "driver", "delivery person", "שליח", "שליחים", "נהג", "נהגים"],
    labelHe: "שליחים",
    descriptionHe: "מי שמבצע את המשלוח ללקוח.",
    fieldLabelsHe: { name: "שם", phone: "טלפון", vehicleType: "סוג רכב", status: "סטטוס" },
    enumLabelsHe: {
      vehicleType: { Bike: "אופניים", Scooter: "קטנוע", Car: "רכב" },
      status: { Available: "זמין", OnDelivery: "במשלוח", Offline: "לא זמין" },
    },
    entity: {
      name: "Courier",
      description: "The person who delivers an order to a customer.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "phone", type: "text", required: false },
        {
          name: "vehicleType",
          type: "enum",
          required: false,
          enumValues: ["Bike", "Scooter", "Car"],
        },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Available", "OnDelivery", "Offline"],
        },
      ],
    },
  },
  {
    keywords: [
      "property", "real estate", "listing", "apartment for rent", "נכס", "נכסים",
      "נדל\"ן", "דירה למכירה", "דירה להשכרה",
    ],
    labelHe: "נכסים",
    descriptionHe: "נכס נדל\"ן למכירה או להשכרה.",
    fieldLabelsHe: { address: "כתובת", type: "סוג", price: "מחיר", rooms: "חדרים", status: "סטטוס" },
    enumLabelsHe: {
      type: { Apartment: "דירה", House: "בית", Office: "משרד", Land: "מגרש" },
      status: { Available: "זמין", UnderContract: "בתהליך", Sold: "נמכר", Rented: "מושכר" },
    },
    entity: {
      name: "Property",
      description: "A real estate property for sale or rent.",
      fields: [
        { name: "address", type: "text", required: true },
        {
          name: "type",
          type: "enum",
          required: false,
          enumValues: ["Apartment", "House", "Office", "Land"],
        },
        { name: "price", type: "number", required: false },
        { name: "rooms", type: "number", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Available", "UnderContract", "Sold", "Rented"],
        },
      ],
    },
  },
  {
    keywords: ["student", "pupil", "learner", "תלמיד", "תלמידה", "תלמידים", "סטודנט", "סטודנטית"],
    labelHe: "תלמידים",
    descriptionHe: "מי שלומד במסגרת החינוכית.",
    fieldLabelsHe: { name: "שם", email: "אימייל", phone: "טלפון", status: "סטטוס לימודים" },
    enumLabelsHe: {
      status: { Active: "פעיל", Graduated: "סיים", OnHold: "בהמתנה" },
    },
    entity: {
      name: "Student",
      description: "A person enrolled in the educational program.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Active", "Graduated", "OnHold"],
        },
      ],
    },
  },
  {
    keywords: ["courses", "curriculum", "lesson", "lessons", "קורס", "קורסים", "שיעור", "שיעורים", "כיתה"],
    labelHe: "קורסים",
    descriptionHe: "קורס או שיעור שהעסק מלמד.",
    fieldLabelsHe: { name: "שם הקורס", instructor: "מדריך/ה", startDate: "תאריך התחלה", capacity: "מקום למספר תלמידים" },
    entity: {
      name: "Course",
      description: "A course or class the business teaches.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "instructor", type: "text", required: false },
        { name: "startDate", type: "date", required: false },
        { name: "capacity", type: "number", required: false },
      ],
    },
  },
  {
    keywords: ["patient", "clinic patient", "מטופל", "מטופלת", "מטופלים"],
    labelHe: "מטופלים",
    descriptionHe: "מי שמקבל טיפול רפואי מהעסק.",
    fieldLabelsHe: { name: "שם", phone: "טלפון", dateOfBirth: "תאריך לידה", notes: "הערות רפואיות" },
    entity: {
      name: "Patient",
      description: "A person receiving medical care from the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "phone", type: "text", required: false },
        { name: "dateOfBirth", type: "date", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: ["project", "פרויקט", "פרויקטים"],
    labelHe: "פרויקטים",
    descriptionHe: "עבודה מוגדרת שהעסק מבצע עבור לקוח.",
    fieldLabelsHe: { name: "שם", client: "לקוח", status: "סטטוס", deadline: "תאריך יעד", budget: "תקציב" },
    enumLabelsHe: {
      status: { Planning: "תכנון", InProgress: "בעבודה", Completed: "הושלם", OnHold: "מוקפא" },
    },
    entity: {
      name: "Project",
      description: "Defined work the business performs for a client.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "client", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Planning", "InProgress", "Completed", "OnHold"],
        },
        { name: "deadline", type: "date", required: false },
        { name: "budget", type: "number", required: false },
      ],
    },
  },
  {
    keywords: ["task", "todo", "to-do", "action item", "משימה", "משימות"],
    labelHe: "משימות",
    descriptionHe: "פעולה קונקרטית שצריך לבצע.",
    fieldLabelsHe: { title: "כותרת", assignee: "אחראי/ת", status: "סטטוס", dueDate: "תאריך יעד" },
    enumLabelsHe: {
      status: { Todo: "לביצוע", InProgress: "בעבודה", Done: "הושלם" },
    },
    entity: {
      name: "Task",
      description: "A concrete piece of work that needs to get done.",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "assignee", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Todo", "InProgress", "Done"],
        },
        { name: "dueDate", type: "date", required: false },
      ],
    },
  },
  {
    keywords: [
      "vehicle", "vehicles", "fleet management", "garage", "mechanic", "car dealership",
      "רכב", "רכבים", "מוסך", "מכונאי", "כלי רכב",
    ],
    labelHe: "כלי רכב",
    descriptionHe: "רכב שהעסק מטפל בו, משכיר, או עוקב אחריו.",
    fieldLabelsHe: { licensePlate: "מספר רישוי", make: "יצרן", model: "דגם", status: "סטטוס" },
    enumLabelsHe: {
      status: { Available: "זמין", InService: "בטיפול", Rented: "מושכר" },
    },
    entity: {
      name: "Vehicle",
      description: "A vehicle the business services, rents out, or tracks.",
      fields: [
        { name: "licensePlate", type: "text", required: true },
        { name: "make", type: "text", required: false },
        { name: "model", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Available", "InService", "Rented"],
        },
      ],
    },
  },
  {
    keywords: [
      "event planning", "conference", "wedding", "weddings", "trade show",
      "אירוע", "אירועים", "כנס", "חתונה", "חתונות",
    ],
    labelHe: "אירועים",
    descriptionHe: "אירוע שהעסק מארגן או מנהל.",
    fieldLabelsHe: { name: "שם האירוע", date: "תאריך", venue: "מקום", capacity: "קיבולת", status: "סטטוס" },
    enumLabelsHe: {
      status: { Planned: "בתכנון", Confirmed: "מאושר", Completed: "התקיים", Cancelled: "בוטל" },
    },
    entity: {
      name: "Event",
      description: "An event the business organizes or manages.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "date", type: "date", required: true },
        { name: "venue", type: "text", required: false },
        { name: "capacity", type: "number", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Planned", "Confirmed", "Completed", "Cancelled"],
        },
      ],
    },
  },
  {
    keywords: [
      "veterinary", "vet clinic", "pet owner", "pet grooming", "animal clinic",
      "חיית מחמד", "חיות מחמד", "וטרינר", "וטרינרית", "טיפוח כלבים",
    ],
    labelHe: "חיות מחמד",
    descriptionHe: "חיית מחמד שמקבלת טיפול מהעסק.",
    fieldLabelsHe: { name: "שם", species: "סוג", ownerName: "שם הבעלים", notes: "הערות" },
    entity: {
      name: "Pet",
      description: "An animal receiving care from the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "species", type: "text", required: false },
        { name: "ownerName", type: "text", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    keywords: [
      "equipment rental", "rent out", "rental business", "tool rental", "gear rental",
      "ציוד להשכרה", "השכרת ציוד", "השכרת רכב",
    ],
    labelHe: "השכרות",
    descriptionHe: "פריט שהושכר ללקוח לתקופה מוגדרת.",
    fieldLabelsHe: { itemName: "שם הפריט", renterName: "שם השוכר", startDate: "תאריך התחלה", endDate: "תאריך סיום", status: "סטטוס" },
    enumLabelsHe: {
      status: { Reserved: "שמור", Active: "בהשכרה", Returned: "הוחזר" },
    },
    entity: {
      name: "Rental",
      description: "An item rented out to a customer for a defined period.",
      fields: [
        { name: "itemName", type: "text", required: true },
        { name: "renterName", type: "text", required: false },
        { name: "startDate", type: "date", required: false },
        { name: "endDate", type: "date", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Reserved", "Active", "Returned"],
        },
      ],
    },
  },
  {
    keywords: [
      "support ticket", "help desk", "helpdesk", "ticketing system", "customer support",
      "תמיכה", "תמיכת", "כרטיסי תמיכה", "פניות תמיכה", "מוקד תמיכה",
    ],
    labelHe: "פניות תמיכה",
    descriptionHe: "פנייה של לקוח שדורשת מענה או טיפול.",
    fieldLabelsHe: { subject: "נושא", customerId: "לקוח", priority: "עדיפות", status: "סטטוס", assignee: "אחראי/ת" },
    enumLabelsHe: {
      priority: { Low: "נמוכה", Medium: "בינונית", High: "גבוהה", Urgent: "דחופה" },
      status: { Open: "פתוחה", InProgress: "בטיפול", Resolved: "נפתרה", Closed: "סגורה" },
    },
    entity: {
      name: "Ticket",
      description: "A customer request or issue that needs a response.",
      fields: [
        { name: "subject", type: "text", required: true },
        // Optional, not required: a support-only description won't
        // necessarily also mention/match a Customer entity (see the same
        // reasoning on Order.courierId above).
        { name: "customerId", type: "relation", required: false, relationTo: "Customer" },
        {
          name: "priority",
          type: "enum",
          required: true,
          enumValues: ["Low", "Medium", "High", "Urgent"],
        },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Open", "InProgress", "Resolved", "Closed"],
        },
        { name: "assignee", type: "text", required: false },
      ],
    },
  },
  {
    keywords: [
      "subscription", "membership plan", "recurring billing", "subscription plan", "member management",
      "מנוי", "מנויים", "חברות מועדון", "דמי חבר",
    ],
    labelHe: "מנויים",
    descriptionHe: "מנוי בתשלום חוזר של לקוח.",
    fieldLabelsHe: { planName: "שם התוכנית", customerId: "לקוח", status: "סטטוס", monthlyPrice: "מחיר חודשי", startDate: "תאריך התחלה" },
    enumLabelsHe: {
      status: { Active: "פעיל", Paused: "מושהה", Cancelled: "בוטל" },
    },
    entity: {
      name: "Subscription",
      description: "A customer's recurring-payment membership or plan.",
      fields: [
        { name: "planName", type: "text", required: true },
        { name: "customerId", type: "relation", required: false, relationTo: "Customer" },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Active", "Paused", "Cancelled"],
        },
        { name: "monthlyPrice", type: "number", required: false },
        { name: "startDate", type: "date", required: false },
      ],
    },
  },
  {
    keywords: [
      "job applicant", "job application", "recruitment", "hiring", "candidate tracking",
      "מועמד", "מועמדים", "גיוס", "קורות חיים",
    ],
    labelHe: "מועמדים",
    descriptionHe: "מי שהגיש מועמדות למשרה בעסק.",
    fieldLabelsHe: { name: "שם", email: "אימייל", appliedFor: "משרה מבוקשת", stage: "שלב", appliedDate: "תאריך הגשה" },
    enumLabelsHe: {
      stage: { Applied: "הוגשה", Interviewing: "בראיונות", Offer: "הצעה נשלחה", Rejected: "נדחה", Hired: "התקבל/ה" },
    },
    entity: {
      name: "JobApplicant",
      description: "A person who applied for a role at the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: false },
        { name: "appliedFor", type: "text", required: false },
        {
          name: "stage",
          type: "enum",
          required: true,
          enumValues: ["Applied", "Interviewing", "Offer", "Rejected", "Hired"],
        },
        { name: "appliedDate", type: "date", required: false },
      ],
    },
  },
  {
    // Two deliberate Hebrew keyword omissions here, both caught by an
    // actual build, not by inspection:
    // 1. "גיוס כספים" (fundraising) is left out even though it's the
    //    obvious phrase -- "גיוס" is JobApplicant's own keyword
    //    (recruitment), and Hebrew overloads that root for both
    //    "recruiting people" and "recruiting money".
    // 2. "תורם"/"תורמים" (donor/donors) are left out even though they're
    //    the literal Hebrew word for "donor" -- both words *start with*
    //    "תור" (turn/appointment), Appointment's own keyword, so a
    //    donation description mentioning "מתורמים" (from donors) would
    //    otherwise spuriously also match Appointment. This isn't a
    //    prefix/suffix issue like the earlier סמיכות pitfall; it's a
    //    coincidental shared root between two unrelated words.
    // "תרומה"/"תרומות" (donation/donations) and "עמותה" (nonprofit) don't
    // have this problem and cover the same descriptions.
    keywords: [
      "donation", "donations", "donor", "nonprofit", "fundraising campaign",
      "תרומה", "תרומות", "עמותה",
    ],
    labelHe: "תרומות",
    descriptionHe: "תרומה שנתרמה על ידי תורם.",
    fieldLabelsHe: { donorName: "שם התורם", amount: "סכום", campaign: "קמפיין", status: "סטטוס", date: "תאריך" },
    enumLabelsHe: {
      status: { Pledged: "הובטחה", Received: "התקבלה", Refunded: "הוחזרה" },
    },
    entity: {
      name: "Donation",
      description: "A contribution made by a donor to the organization.",
      fields: [
        { name: "donorName", type: "text", required: true },
        { name: "amount", type: "number", required: true },
        { name: "campaign", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Pledged", "Received", "Refunded"],
        },
        { name: "date", type: "date", required: false },
      ],
    },
  },
  {
    // "שילוח" (dispatch/freight) is deliberately used instead of "משלוח"
    // (parcel/delivery, already Order's own keyword) -- different word,
    // no substring overlap, so a logistics/warehouse description doesn't
    // spuriously also match Order.
    keywords: [
      "shipping", "logistics", "warehouse management", "package tracking", "freight",
      "שילוח", "לוגיסטיקה", "ניהול מחסן", "מעקב חבילות",
    ],
    labelHe: "משלוחים ומעקב",
    descriptionHe: "חבילה שנשלחת ועוקבים אחריה.",
    fieldLabelsHe: { trackingNumber: "מספר מעקב", carrier: "חברת שילוח", destination: "יעד", status: "סטטוס", shipDate: "תאריך שילוח" },
    enumLabelsHe: {
      status: { Preparing: "בהכנה", InTransit: "בדרך", Delivered: "נמסרה", Delayed: "בעיכוב" },
    },
    entity: {
      name: "Shipment",
      description: "A package being shipped and tracked.",
      fields: [
        { name: "trackingNumber", type: "text", required: true },
        { name: "carrier", type: "text", required: false },
        { name: "destination", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Preparing", "InTransit", "Delivered", "Delayed"],
        },
        { name: "shipDate", type: "date", required: false },
      ],
    },
  },
  {
    keywords: [
      "insurance claim", "insurance claims", "claims processing", "policy holder", "policyholder",
      "תביעת ביטוח", "תביעות ביטוח", "פוליסת ביטוח", "תביעה",
    ],
    labelHe: "תביעות ביטוח",
    descriptionHe: "תביעה שהוגשה על ידי בעל פוליסה.",
    fieldLabelsHe: { claimant: "שם התובע", policyNumber: "מספר פוליסה", claimAmount: "סכום התביעה", status: "סטטוס", incidentDate: "תאריך האירוע" },
    enumLabelsHe: {
      status: { Submitted: "הוגשה", UnderReview: "בבדיקה", Approved: "אושרה", Denied: "נדחתה", Paid: "שולמה" },
    },
    entity: {
      name: "InsuranceClaim",
      description: "A claim filed by a policyholder.",
      fields: [
        { name: "claimant", type: "text", required: true },
        { name: "policyNumber", type: "text", required: false },
        { name: "claimAmount", type: "number", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Submitted", "UnderReview", "Approved", "Denied", "Paid"],
        },
        { name: "incidentDate", type: "date", required: false },
      ],
    },
  },
  {
    // "ספק"/"ספקים" (vendor/supplier) -- who the business buys FROM, the
    // mirror image of Customer (who it sells TO). No existing keyword
    // shares this root, and "supplier"/"vendor" don't collide with any
    // short English keyword either.
    keywords: [
      "vendor", "vendors", "supplier", "suppliers", "procurement",
      "ספק", "ספקים", "רכש",
    ],
    labelHe: "ספקים",
    descriptionHe: "גורם עסקי שהעסק קונה ממנו סחורה או שירותים.",
    fieldLabelsHe: { name: "שם", contactPerson: "איש קשר", phone: "טלפון", email: "אימייל", category: "קטגוריה" },
    enumLabelsHe: {
      category: { Goods: "סחורה", Services: "שירותים", Both: "שניהם" },
    },
    entity: {
      name: "Vendor",
      description: "A business the company buys goods or services from.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "contactPerson", type: "text", required: false },
        { name: "phone", type: "text", required: false },
        { name: "email", type: "text", required: false },
        {
          name: "category",
          type: "enum",
          required: true,
          enumValues: ["Goods", "Services", "Both"],
        },
      ],
    },
  },
  {
    // "הוצאה"/"הוצאות" (expense/expenses). Checked against every existing
    // keyword's root -- no collision.
    keywords: [
      "expense", "expenses", "expense tracking", "business expenses",
      "הוצאה", "הוצאות", "מעקב הוצאות",
    ],
    labelHe: "הוצאות",
    descriptionHe: "הוצאה עסקית שהעסק שילם.",
    fieldLabelsHe: { description: "תיאור", amount: "סכום", category: "קטגוריה", vendor: "ספק", date: "תאריך", status: "סטטוס" },
    enumLabelsHe: {
      category: { Rent: "שכירות", Supplies: "ציוד", Travel: "נסיעות", Utilities: "שירותים ציבוריים", Payroll: "שכר", Other: "אחר" },
      status: { Pending: "ממתין", Approved: "אושר", Paid: "שולם", Rejected: "נדחה" },
    },
    entity: {
      name: "Expense",
      description: "A business expense the company paid.",
      fields: [
        { name: "description", type: "text", required: true },
        { name: "amount", type: "number", required: true },
        {
          name: "category",
          type: "enum",
          required: true,
          enumValues: ["Rent", "Supplies", "Travel", "Utilities", "Payroll", "Other"],
        },
        { name: "vendor", type: "text", required: false },
        { name: "date", type: "date", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Pending", "Approved", "Paid", "Rejected"],
        },
      ],
    },
  },
  {
    // "ביקורת"/"חוות דעת"/"משוב" (review/opinion/feedback). None of these
    // roots overlap with any existing keyword ("ביקור" (visit) is a
    // different word from "ביקורת" (review) -- not a substring of it, so
    // no risk of the construct-state/suffix pitfall either). Deliberately
    // NOT using bare "review"/"reviews" or "rating" as English keywords:
    // "review" ⊂ "preview" and "rating" ⊂ "operating"/"collaborating"/
    // "generating" -- the exact "events" ⊂ "prevents" pitfall this file's
    // own header warns about (same reason Event's own keywords below use
    // "event planning"/"conference" instead of bare "event"). The
    // multi-word phrases here don't have that problem.
    keywords: [
      "customer review", "customer feedback", "product review", "testimonial",
      "ביקורת", "ביקורות", "חוות דעת", "משוב", "דירוג",
    ],
    labelHe: "ביקורות",
    descriptionHe: "ביקורת או משוב שהשאיר לקוח.",
    fieldLabelsHe: { reviewerName: "שם המבקר/ת", rating: "דירוג", comment: "תגובה", date: "תאריך", status: "סטטוס" },
    enumLabelsHe: {
      status: { Published: "פורסמה", Pending: "ממתינה לאישור", Hidden: "מוסתרת" },
    },
    entity: {
      name: "Review",
      description: "Feedback or a rating left by a customer.",
      fields: [
        { name: "reviewerName", type: "text", required: true },
        { name: "rating", type: "number", required: true },
        { name: "comment", type: "longtext", required: false },
        { name: "date", type: "date", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Published", "Pending", "Hidden"],
        },
      ],
    },
  },
  {
    // Field-service/repair jobs (plumbers, electricians, appliance/AC
    // technicians, handymen) -- a distinct concept from the Ticket entity's
    // "customer complaint that needs a response": a WorkOrder is scheduled
    // physical work with an assigned technician, not a support conversation.
    // "מוסך"/"מכונאי" are deliberately NOT reused here -- they're already
    // Vehicle's own keywords (see above), and reusing them would blur which
    // entity a garage idea actually means. "work order"/"service call" do
    // overlap the bare "service"/"order" keywords already bound to the
    // Service/Order entities; that's an intentional, harmless double-match
    // (a repair business plausibly wants a services catalog and/or a
    // generic order list too), not the false-positive substring pitfall
    // this file's header warns about.
    keywords: [
      "work order", "field service", "service call", "repair job", "maintenance request",
      "קריאת שירות", "קריאות שירות", "עבודת תחזוקה", "טכנאי", "אינסטלטור", "חשמלאי",
    ],
    labelHe: "קריאות שירות",
    descriptionHe: "עבודת תיקון או תחזוקה מתוזמנת שהעסק מבצע עבור לקוח.",
    fieldLabelsHe: {
      title: "תיאור העבודה",
      customerId: "לקוח",
      technician: "טכנאי",
      status: "סטטוס",
      scheduledDate: "תאריך מתוזמן",
      notes: "הערות",
    },
    enumLabelsHe: {
      status: { Scheduled: "מתוזמנת", InProgress: "בביצוע", Completed: "הושלמה", Cancelled: "בוטלה" },
    },
    entity: {
      name: "WorkOrder",
      description: "A scheduled repair or maintenance job performed for a customer.",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "customerId", type: "relation", required: false, relationTo: "Customer" },
        { name: "technician", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Scheduled", "InProgress", "Completed", "Cancelled"],
        },
        { name: "scheduledDate", type: "date", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
  {
    // Volunteers for a nonprofit -- a distinct person/role from a Donor
    // (see Donation's entity above): someone who gives time, not money.
    // Pairs naturally with Donation for an NGO/community-org idea, and the
    // two entities are expected to both fire together on "nonprofit"/
    // "עמותה" without conflict.
    keywords: [
      "volunteer", "volunteer management", "volunteer shift",
      "מתנדב", "מתנדבת", "מתנדבים", "התנדבות",
    ],
    labelHe: "מתנדבים",
    descriptionHe: "מי שתורם/ת זמן להתנדבות בעסק או בעמותה.",
    fieldLabelsHe: { name: "שם", phone: "טלפון", email: "אימייל", role: "תפקיד", status: "סטטוס", joinedDate: "תאריך הצטרפות" },
    enumLabelsHe: {
      status: { Active: "פעיל/ה", Inactive: "לא פעיל/ה" },
    },
    entity: {
      name: "Volunteer",
      description: "A person who donates time to the organization.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "phone", type: "text", required: false },
        { name: "email", type: "text", required: false },
        { name: "role", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Active", "Inactive"],
        },
        { name: "joinedDate", type: "date", required: false },
      ],
    },
  },
  {
    // Legal case files for a law firm or legal consultant -- the one
    // professional-services domain not yet covered (Patient covers
    // healthcare, Student covers education). "לקוח"/"client" already exist
    // as Customer's own keywords, so a legal idea naturally also gets a
    // Customer entity alongside Case, matching this file's established
    // tolerance for related entities co-firing (e.g. Ticket + Customer).
    keywords: [
      "legal case", "law firm", "case management", "legal matter",
      "תיק משפטי", "תיקים משפטיים", "עורך דין", "עורכת דין",
    ],
    labelHe: "תיקים",
    descriptionHe: "תיק משפטי שמנוהל עבור לקוח.",
    fieldLabelsHe: {
      title: "נושא התיק",
      clientId: "לקוח",
      caseType: "סוג תיק",
      status: "סטטוס",
      openedDate: "תאריך פתיחה",
      notes: "הערות",
    },
    enumLabelsHe: {
      status: { Open: "פתוח", InProgress: "בטיפול", Closed: "סגור" },
    },
    entity: {
      name: "Case",
      description: "A legal matter managed on behalf of a client.",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "clientId", type: "relation", required: false, relationTo: "Customer" },
        { name: "caseType", type: "text", required: false },
        {
          name: "status",
          type: "enum",
          required: true,
          enumValues: ["Open", "InProgress", "Closed"],
        },
        { name: "openedDate", type: "date", required: false },
        { name: "notes", type: "longtext", required: false },
      ],
    },
  },
];

export interface RoleRule {
  keywords: string[];
  labelHe: string;
}

export const ROLE_RULES: Record<string, RoleRule> = {
  Admin: { keywords: ["admin", "administrator", "owner", "מנהל מערכת", "אדמין", "בעלים"], labelHe: "מנהל/ת ראשי/ת" },
  Manager: { keywords: ["manager", "management", "מנהל", "מנהלת", "ניהול"], labelHe: "מנהל/ת" },
  Employee: { keywords: ["employee", "staff", "worker", "team member", "עובד", "עובדת", "עובדים", "צוות"], labelHe: "עובד/ת" },
  Customer: { keywords: ["customer portal", "client portal", "self-service", "פורטל לקוחות", "גישת לקוחות"], labelHe: "לקוח/ה" },
};

export const DEFAULT_ENTITY: Entity = {
  name: "Item",
  description: "A generic record. Refine this by naming real entities in your description.",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "description", type: "longtext", required: false },
    {
      name: "status",
      type: "enum",
      required: true,
      enumValues: ["Active", "Inactive"],
    },
  ],
};

export const DEFAULT_ENTITY_LABEL_HE = "פריטים";
export const DEFAULT_ENTITY_DESCRIPTION_HE = 'רשומה כללית. אפשר לדייק את זה ע"י תיאור ישויות אמיתיות.';
export const DEFAULT_ENTITY_FIELD_LABELS_HE: Record<string, string> = {
  name: "שם",
  description: "תיאור",
  status: "סטטוס",
};
export const DEFAULT_ENTITY_ENUM_LABELS_HE: Record<string, Record<string, string>> = {
  status: { Active: "פעיל", Inactive: "לא פעיל" },
};

export const HEBREW_PATTERN = /[֐-׿]/;

export function isHebrewText(text: string): boolean {
  return HEBREW_PATTERN.test(text);
}
