import type { Entity, Field } from "@forge/shared";

const HEBREW_PATTERN = /[֐-׿]/;

// Believable-looking sample values for the specific field names this
// platform's own domain entity library actually generates (see
// packages/spec-engine/src/domainEntities.ts) — picked cyclically by
// record index so a freshly built app's first table doesn't read as
// "Lorem Ipsum" (e.g. "Customer - name 1"). This is still fabricated demo
// data, not real business data — it's just no longer obviously a
// placeholder formula.
const PERSON_NAMES_HE = ["דנה לוי", "יוסי כהן", "מיכל אברהם", "רון פרץ", "נועה שרון", "אלון מזרחי"];
const PERSON_NAMES_EN = ["Dana Levi", "Yossi Cohen", "Michal Abraham", "Ron Peretz", "Noa Sharon", "Alon Mizrahi"];
const ITEM_NAMES_HE = ["חבילת בסיס", "שדרוג פרימיום", "טיפול סטנדרטי", "מנוי חודשי"];
const ITEM_NAMES_EN = ["Basic Package", "Premium Upgrade", "Standard Treatment", "Monthly Plan"];
const EMAIL_LOCAL_PARTS = ["dana.levi", "yossi.cohen", "michal.abraham", "ron.peretz", "noa.sharon", "alon.mizrahi"];
const PHONES_HE = ["050-123-4567", "052-987-6543", "054-222-1188", "058-765-4321"];
const PHONES_EN = ["(555) 123-4567", "(555) 987-6543", "(555) 222-1188", "(555) 765-4321"];
const SOURCES_HE = ["אתר האינטרנט", "המלצה מלקוח", "פייסבוק", "חיפוש בגוגל"];
const SOURCES_EN = ["Website", "Customer referral", "Facebook Ads", "Google Search"];
const ROLES_HE = ["מוכר/ת", "טכנאי/ת", "מנהל/ת משמרת", "רכז/ת שירות"];
const ROLES_EN = ["Sales Associate", "Technician", "Shift Manager", "Service Coordinator"];
const DEAL_TITLES_HE = ["שדרוג חבילת שירות", "התקנה ראשונית", "חוזה שנתי", "הרחבת מנוי"];
const DEAL_TITLES_EN = ["Service upgrade", "Initial setup", "Annual contract", "Plan expansion"];
// Pools for the domain entities added later (MenuItem, Property, Course,
// Project, Event, Pet, Vehicle, Rental) -- see packages/spec-engine/src/
// domainEntities.ts. Same principle: believable, field-appropriate values
// instead of a generic "<Entity> - <field> 1" placeholder.
const DISH_NAMES_HE = ["פיצה מרגריטה", "סלט קיסר", "פסטה ברוטב שמנת", "עוגת שוקולד"];
const DISH_NAMES_EN = ["Margherita Pizza", "Caesar Salad", "Creamy Pasta", "Chocolate Cake"];
const PROJECT_NAMES_HE = ["עיצוב אתר מחדש", "קמפיין שיווקי", "מעבר מערכת", "פיתוח אפליקציה"];
const PROJECT_NAMES_EN = ["Website Redesign", "Marketing Campaign", "System Migration", "App Development"];
const EVENT_NAMES_HE = ["כנס שנתי", "חתונה", "השקת מוצר", "יום גיבוש"];
const EVENT_NAMES_EN = ["Annual Conference", "Wedding", "Product Launch", "Team Retreat"];
const COURSE_NAMES_HE = ["מבוא לתכנות", "אנגלית עסקית", "יסודות עיצוב", "ניהול פרויקטים"];
const COURSE_NAMES_EN = ["Intro to Programming", "Business English", "Design Fundamentals", "Project Management"];
const PET_NAMES_HE = ["רקס", "לונה", "מקס", "בֶּלָה"];
const PET_NAMES_EN = ["Rex", "Luna", "Max", "Bella"];
const SPECIES_HE = ["כלב", "חתול", "ארנב", "תוכי"];
const SPECIES_EN = ["Dog", "Cat", "Rabbit", "Parrot"];
const VEHICLE_MAKES = ["Toyota", "Hyundai", "Kia", "Mazda"];
const VEHICLE_MODELS = ["Corolla", "Tucson", "Sportage", "3"];
const LICENSE_PLATES = ["12-345-67", "23-456-78", "34-567-89", "45-678-90"];
const ADDRESSES_HE = ["הרצל 12, תל אביב", "ויצמן 5, רעננה", "בן גוריון 30, חיפה", "רוטשילד 8, תל אביב"];
const ADDRESSES_EN = ["12 Herzl St, Tel Aviv", "5 Weizmann St, Raanana", "30 Ben Gurion Blvd, Haifa", "8 Rothschild Blvd, Tel Aviv"];
const VENUES_HE = ["אולמי הגן", "מלון דן", "בית התרבות", "גני האירועים"];
const VENUES_EN = ["Garden Hall", "Dan Hotel", "Community Center", "Event Gardens"];
const INSTRUCTORS_HE = ["ד\"ר רותם כץ", "המורה עדי בר", "פרופ' יעל אבני", "המדריך גיל שגיא"];
const INSTRUCTORS_EN = ["Dr. Rotem Katz", "Adi Bar", "Prof. Yael Avni", "Gil Sagi"];
// Pools for Ticket, Subscription, JobApplicant.
const TICKET_SUBJECTS_HE = ["לא מצליח/ה להתחבר לחשבון", "חיוב כפול בכרטיס האשראי", "בקשה לשדרוג תוכנית", "שאלה לגבי החשבונית"];
const TICKET_SUBJECTS_EN = ["Can't log into my account", "Charged twice on my card", "Request to upgrade my plan", "Question about my invoice"];
const PLAN_NAMES_HE = ["תוכנית בסיסית", "תוכנית פרו", "תוכנית עסקית", "תוכנית שנתית"];
const PLAN_NAMES_EN = ["Basic Plan", "Pro Plan", "Business Plan", "Annual Plan"];
const JOB_TITLES_HE = ["מפתח/ת תוכנה", "מנהל/ת מכירות", "רכז/ת שיווק", "מעצב/ת UX"];
const JOB_TITLES_EN = ["Software Engineer", "Sales Manager", "Marketing Coordinator", "UX Designer"];
// Pools for Donation, Shipment, InsuranceClaim.
const CAMPAIGN_NAMES_HE = ["מגבית שנתית", "קמפיין חירום", "בניית מרכז קהילתי", "מלגות לתלמידים"];
const CAMPAIGN_NAMES_EN = ["Annual Appeal", "Emergency Relief Fund", "Community Center Build", "Student Scholarships"];
const CARRIERS_HE = ["דואר ישראל", "צים", "UPS", "דלוור"];
const CARRIERS_EN = ["FedEx", "UPS", "DHL", "USPS"];
// Pools for Vendor, Expense, Review.
const VENDOR_NAMES_HE = ["חברת ציוד המשרד", "ספקי חומרי גלם בע\"מ", "פתרונות ענן ישראל", "שירותי ניקיון מקצועיים"];
const VENDOR_NAMES_EN = ["Office Supplies Co.", "Raw Materials Ltd.", "CloudTech Solutions", "Professional Cleaning Services"];
const EXPENSE_DESCRIPTIONS_HE = ["שכירות חודש", "רכישת ציוד משרדי", "כרטיסי טיסה לכנס", "חשבון חשמל"];
const EXPENSE_DESCRIPTIONS_EN = ["Monthly office rent", "Office supplies purchase", "Conference flight tickets", "Electricity bill"];

function pick(pool: string[], index: number): string {
  return pool[index % pool.length];
}

function seedValueFor(field: Field, entity: Entity, index: number): unknown {
  const entityName = entity.label ?? entity.name;
  const fieldLabel = field.label ?? field.name;
  const isHebrew = HEBREW_PATTERN.test(entityName) || HEBREW_PATTERN.test(fieldLabel);

  switch (field.type) {
    case "number":
      // A 1-5 star rating shouldn't seed as 10/20/30 like every other
      // numeric field (amount, capacity, price, ...) -- it has a real,
      // narrow domain range, and a value outside it would look broken the
      // moment a real UI renders it as stars.
      if (field.name === "rating") return (index % 5) + 1;
      return (index + 1) * 10;
    case "boolean":
      return index % 2 === 0;
    case "date": {
      const d = new Date(Date.now() - index * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    case "enum":
      return field.enumValues?.[index % (field.enumValues?.length ?? 1)] ?? null;
    case "relation":
      // Best-effort guess (row 1) when the field is required; there's no
      // guaranteed insert order across entities yet, so this can be wrong
      // for a genuinely required cross-entity relation — a real limitation,
      // not hidden here.
      return field.required ? 1 : null;
    case "longtext":
      return isHebrew
        ? `${fieldLabel} לדוגמה עבור ${entityName} מספר ${index + 1}.`
        : `Sample ${field.name} for ${entityName} #${index + 1}.`;
    case "text":
    default:
      return textSeedValueFor(field.name, entity.name, isHebrew, index);
  }
}

// Entities whose "name" field names a generic catalog item/thing, not a
// person. MenuItem/Project/Event/Course/Pet get their own dedicated pools
// below instead, since "a generic package" reads oddly as a dish or a
// project name.
const CATALOG_NAME_ENTITIES = new Set(["Service", "Product"]);

function textSeedValueFor(fieldName: string, entityName: string, isHebrew: boolean, index: number): string {
  switch (fieldName) {
    case "email":
      return `${pick(EMAIL_LOCAL_PARTS, index)}@example.com`;
    case "phone":
      return pick(isHebrew ? PHONES_HE : PHONES_EN, index);
    case "source":
      return pick(isHebrew ? SOURCES_HE : SOURCES_EN, index);
    case "role":
      return pick(isHebrew ? ROLES_HE : ROLES_EN, index);
    case "sku":
      return `SKU-${1000 + index * 42}`;
    case "title":
      return pick(isHebrew ? DEAL_TITLES_HE : DEAL_TITLES_EN, index);
    case "customerName":
    case "owner":
    case "assignee":
    case "instructor":
      return fieldName === "instructor"
        ? pick(isHebrew ? INSTRUCTORS_HE : INSTRUCTORS_EN, index)
        : pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    case "client":
    case "ownerName":
    case "renterName":
    case "donorName":
    case "claimant":
    case "contactPerson":
    case "reviewerName":
      return pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    case "service":
    case "itemName":
      return pick(isHebrew ? ITEM_NAMES_HE : ITEM_NAMES_EN, index);
    case "address":
    case "destination":
      return pick(isHebrew ? ADDRESSES_HE : ADDRESSES_EN, index);
    case "venue":
      return pick(isHebrew ? VENUES_HE : VENUES_EN, index);
    case "species":
      return pick(isHebrew ? SPECIES_HE : SPECIES_EN, index);
    case "make":
      return pick(VEHICLE_MAKES, index);
    case "model":
      return pick(VEHICLE_MODELS, index);
    case "licensePlate":
      return pick(LICENSE_PLATES, index);
    case "subject":
      return pick(isHebrew ? TICKET_SUBJECTS_HE : TICKET_SUBJECTS_EN, index);
    case "planName":
      return pick(isHebrew ? PLAN_NAMES_HE : PLAN_NAMES_EN, index);
    case "appliedFor":
      return pick(isHebrew ? JOB_TITLES_HE : JOB_TITLES_EN, index);
    case "campaign":
      return pick(isHebrew ? CAMPAIGN_NAMES_HE : CAMPAIGN_NAMES_EN, index);
    case "carrier":
      return pick(isHebrew ? CARRIERS_HE : CARRIERS_EN, index);
    case "trackingNumber":
      return `TRK-${100000 + index * 37}`;
    case "policyNumber":
      return `POL-${500000 + index * 111}`;
    case "vendor":
      return pick(isHebrew ? VENDOR_NAMES_HE : VENDOR_NAMES_EN, index);
    case "description":
      if (entityName === "Expense") return pick(isHebrew ? EXPENSE_DESCRIPTIONS_HE : EXPENSE_DESCRIPTIONS_EN, index);
      return isHebrew ? `${entityName} - ${fieldName} ${index + 1}` : `${entityName} ${fieldName} ${index + 1}`;
    case "name":
      // "name" means different things for different entity shapes -- a
      // person for people-shaped entities, a thing for catalog-shaped
      // ones, and its own dedicated pool for a few entities where neither
      // fits well (a project isn't a "product", a pet isn't a "customer").
      if (CATALOG_NAME_ENTITIES.has(entityName)) return pick(isHebrew ? ITEM_NAMES_HE : ITEM_NAMES_EN, index);
      if (entityName === "MenuItem") return pick(isHebrew ? DISH_NAMES_HE : DISH_NAMES_EN, index);
      if (entityName === "Project") return pick(isHebrew ? PROJECT_NAMES_HE : PROJECT_NAMES_EN, index);
      if (entityName === "Event") return pick(isHebrew ? EVENT_NAMES_HE : EVENT_NAMES_EN, index);
      if (entityName === "Course") return pick(isHebrew ? COURSE_NAMES_HE : COURSE_NAMES_EN, index);
      if (entityName === "Pet") return pick(isHebrew ? PET_NAMES_HE : PET_NAMES_EN, index);
      if (entityName === "Vendor") return pick(isHebrew ? VENDOR_NAMES_HE : VENDOR_NAMES_EN, index);
      return pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    default:
      // No specific pool for this field name (a custom entity from an
      // AI-generated or refined spec, not the built-in domain library) —
      // fall back to a labeled placeholder rather than guessing wrong.
      return isHebrew ? `${entityName} - ${fieldName} ${index + 1}` : `${entityName} ${fieldName} ${index + 1}`;
  }
}

/**
 * Deterministic seed-data generator used by the Seed Data Agent step of the
 * build pipeline. No randomness, no LLM call — genuinely realistic-looking
 * values derived from each field's type and name, so a freshly built app
 * never opens to an empty, unconvincing table.
 */
export function generateSeedRecords(entity: Entity, count = 2): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const record: Record<string, unknown> = {};
    for (const field of entity.fields) {
      record[field.name] = seedValueFor(field, entity, index);
    }
    return record;
  });
}
