import type { Entity, Field } from "@forge/shared";

const HEBREW_PATTERN = /[֐-׿]/;

// Mirrors apps/web/src/entityFormatting.ts's own END_DATE_FIELD_NAME_HINTS --
// the live app's calendar view and ICS export already recognize all five of
// these as a genuine "end of range" field, so seeding must agree with that
// list rather than its own narrower literal-"end" substring check.
const END_DATE_FIELD_NAME_HINTS = ["enddate", "returndate", "checkoutdate", "untildate", "todate"];

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
const RENTAL_ITEM_NAMES_HE = ["מקדחה חשמלית", "מקרן נייד", "אוהל קמפינג", "אופני הרים"];
const RENTAL_ITEM_NAMES_EN = ["Power Drill", "Portable Projector", "Camping Tent", "Mountain Bike"];
// Round 1244: the exact same shape as RENTAL_ITEM_NAMES above -- Product
// (domainEntities.ts: "An item the business sells or tracks", with its own
// sku/quantity fields) is a physical, countable inventory good, not a
// service plan, so it needs its own pool instead of ITEM_NAMES_HE/EN's
// service-plan phrasing ("Monthly Plan" with a SKU and a stock quantity
// attached reads as broken placeholder data).
const PRODUCT_NAMES_HE = ["עכבר אלחוטי", "כיסא משרדי", "מחצלת יוגה", "כיסוי לטלפון"];
const PRODUCT_NAMES_EN = ["Wireless Mouse", "Office Chair", "Yoga Mat", "Phone Case"];
const EMAIL_LOCAL_PARTS = ["dana.levi", "yossi.cohen", "michal.abraham", "ron.peretz", "noa.sharon", "alon.mizrahi"];
const PHONES_HE = ["050-123-4567", "052-987-6543", "054-222-1188", "058-765-4321"];
const PHONES_EN = ["(555) 123-4567", "(555) 987-6543", "(555) 222-1188", "(555) 765-4321"];
// Round 1707: Courier (domainEntities.ts, "The person who delivers an order
// to a customer") has its own name/email/phone fields, same as Customer, but
// had no entity-aware branch of its own in any of the "name"/"email"/"phone"
// cases below -- so it fell through to the exact same generic PERSON_NAMES/
// EMAIL_LOCAL_PARTS/PHONES pools, index-aligned, as Customer. In an app whose
// whole premise is "the customer who ordered" vs. "the courier who delivers"
// being different people, a freshly seeded Order showed the identical name,
// email, and phone for both roles on the same row -- own pools instead.
const COURIER_NAMES_HE = ["אבי שגיא", "תמר גולן", "עידן ברק", "שירה נחום"];
const COURIER_NAMES_EN = ["Avi Sagi", "Tamar Golan", "Idan Barak", "Shira Nahum"];
const COURIER_EMAIL_LOCAL_PARTS = ["avi.sagi", "tamar.golan", "idan.barak", "shira.nahum"];
const COURIER_PHONES_HE = ["053-444-7788", "057-111-2299", "050-888-3344", "052-666-5511"];
const COURIER_PHONES_EN = ["(555) 444-7788", "(555) 111-2299", "(555) 888-3344", "(555) 666-5511"];
// Round 1736: the exact same gap round 1707 fixed for Courier vs. Customer
// exists for every OTHER person-shaped entity in domainEntities.ts/
// templates.ts that also has name/email/phone text fields -- Employee,
// Staff (the Appointments & Clients template's own entity), Student,
// Patient, Volunteer, and JobApplicant all fell through to the exact same
// generic PERSON_NAMES_HE/EN, EMAIL_LOCAL_PARTS, and PHONES_HE/EN pools,
// index-aligned with Customer. Several of these entities routinely
// co-occur with Customer in the app's own built-in examples/templates
// (the home screen's "Salon"/"Fitness studio" examples both produce
// Customer+Employee; the Appointments & Clients template has Customer+
// Staff) -- a freshly seeded app showed the customer and the employee/
// staff member who served them as the literal same name/email/phone on
// row 1. Own pools per entity, same shape as Courier's.
const EMPLOYEE_NAMES_HE = ["ליאור בן-דוד", "קרן אזולאי", "עומר וקנין", "שני פלג"];
const EMPLOYEE_NAMES_EN = ["Lior Ben-David", "Keren Azoulay", "Omer Vaknin", "Shani Peleg"];
const EMPLOYEE_EMAIL_LOCAL_PARTS = ["lior.bendavid", "keren.azoulay", "omer.vaknin", "shani.peleg"];
const EMPLOYEE_PHONES_HE = ["050-333-2211", "052-444-3322", "054-555-4433", "058-666-5544"];
const EMPLOYEE_PHONES_EN = ["(555) 333-2211", "(555) 444-3322", "(555) 555-4433", "(555) 666-5544"];
const STAFF_NAMES_HE = ["נדב כספי", "אורטל חדד", "אסף רוזן", "מאיה גבאי"];
const STAFF_NAMES_EN = ["Nadav Kaspi", "Ortal Hadad", "Asaf Rozen", "Maya Gabay"];
const STAFF_EMAIL_LOCAL_PARTS = ["nadav.kaspi", "ortal.hadad", "asaf.rozen", "maya.gabay"];
const STAFF_PHONES_HE = ["053-111-9922", "057-222-8833", "050-333-7744", "052-444-6655"];
const STAFF_PHONES_EN = ["(555) 111-9922", "(555) 222-8833", "(555) 333-7744", "(555) 444-6655"];
const STUDENT_NAMES_HE = ["טל אוחנה", "רותם שפירא", "דניאל מלכה", "הילה צרפתי"];
const STUDENT_NAMES_EN = ["Tal Ohana", "Rotem Shapira", "Daniel Malka", "Hila Tsarfati"];
const STUDENT_EMAIL_LOCAL_PARTS = ["tal.ohana", "rotem.shapira", "daniel.malka", "hila.tsarfati"];
const STUDENT_PHONES_HE = ["054-777-1122", "058-888-2233", "050-999-3344", "052-111-4455"];
const STUDENT_PHONES_EN = ["(555) 777-1122", "(555) 888-2233", "(555) 999-3344", "(555) 111-4455"];
const PATIENT_NAMES_HE = ["יעל ברוך", "איתי סגל", "נטע פרידמן", "בן עמרם"];
const PATIENT_NAMES_EN = ["Yael Baruch", "Itai Segal", "Neta Friedman", "Ben Amram"];
const PATIENT_EMAIL_LOCAL_PARTS = ["yael.baruch", "itai.segal", "neta.friedman", "ben.amram"];
const PATIENT_PHONES_HE = ["053-222-5566", "057-333-6677", "050-444-7788", "052-555-8899"];
const PATIENT_PHONES_EN = ["(555) 222-5566", "(555) 333-6677", "(555) 444-7788", "(555) 555-8899"];
const VOLUNTEER_NAMES_HE = ["אביגיל נוי", "יונתן אשכנזי", "שירן דגן", "רועי קורן"];
const VOLUNTEER_NAMES_EN = ["Avigail Noy", "Yonatan Ashkenazi", "Shiran Dagan", "Roi Koren"];
const VOLUNTEER_EMAIL_LOCAL_PARTS = ["avigail.noy", "yonatan.ashkenazi", "shiran.dagan", "roi.koren"];
const VOLUNTEER_PHONES_HE = ["054-666-9911", "058-777-1022", "050-888-2133", "052-999-3244"];
const VOLUNTEER_PHONES_EN = ["(555) 666-9911", "(555) 777-1022", "(555) 888-2133", "(555) 999-3244"];
const JOB_APPLICANT_NAMES_HE = ["גלית שלו", "אוראל בכר", "נויה אדרי", "שחר לביא"];
const JOB_APPLICANT_NAMES_EN = ["Galit Shalev", "Orel Bachar", "Noya Edri", "Shahar Lavi"];
const JOB_APPLICANT_EMAIL_LOCAL_PARTS = ["galit.shalev", "orel.bachar", "noya.edri", "shahar.lavi"];
const JOB_APPLICANT_PHONES_HE = ["053-444-5511", "057-555-6622", "050-666-7733", "052-777-8844"];
const JOB_APPLICANT_PHONES_EN = ["(555) 444-5511", "(555) 555-6622", "(555) 666-7733", "(555) 777-8844"];
// Round 1740: same gap as rounds 1707/1736, missed for Contact (Sales CRM
// template, "a contact person at a customer's company") -- worse here than
// for Courier/Employee/etc., since Contact.customer is a REQUIRED relation
// to Customer in the same template, so a freshly seeded CRM project showed
// a "contact person at the customer's company" who IS, by name/email/phone,
// the literal same person as the customer they're a contact for, on every
// single project built from this template.
const CONTACT_NAMES_HE = ["אלינור וייס", "גיא שושן", "סיוון עמית", "ברק הראל"];
const CONTACT_NAMES_EN = ["Elinor Weiss", "Guy Sosson", "Sivan Amit", "Barak Harel"];
const CONTACT_EMAIL_LOCAL_PARTS = ["elinor.weiss", "guy.sosson", "sivan.amit", "barak.harel"];
const CONTACT_PHONES_HE = ["054-888-1133", "058-999-2244", "050-111-3355", "052-222-4466"];
const CONTACT_PHONES_EN = ["(555) 888-1133", "(555) 999-2244", "(555) 111-3355", "(555) 222-4466"];
// Round 1742: Vendor (domainEntities.ts) and Supplier (templates.ts's
// Inventory & Products template) both have the same "name" field pool gap
// rounds 1107/1244 already fixed (VENDOR_NAMES_HE/EN, further down this
// file) -- but their OWN contactPerson/email/phone fields, a person at the
// vendor/supplier's company, never got the same treatment and fell
// through to the exact same generic PERSON_NAMES_HE/EN/EMAIL_LOCAL_PARTS/
// PHONES_HE/EN pools Customer uses. A spec combining Customer with Vendor
// or Supplier (an ordinary, reachable shape -- "track customers and the
// vendors I buy from") seeded the vendor's own contact person as the
// literal same name/email/phone as an unrelated customer.
const VENDOR_CONTACT_NAMES_HE = ["אפרת גולדשטיין", "נדב אבירם", "שירה בן-חיים", "איתן פרידמן"];
const VENDOR_CONTACT_NAMES_EN = ["Efrat Goldstein", "Nadav Aviram", "Shira Ben-Haim", "Eitan Friedman"];
const VENDOR_EMAIL_LOCAL_PARTS = ["efrat.goldstein", "nadav.aviram", "shira.benhaim", "eitan.friedman"];
const VENDOR_PHONES_HE = ["053-333-9988", "057-444-8877", "050-555-7766", "052-666-6655"];
const VENDOR_PHONES_EN = ["(555) 333-9988", "(555) 444-8877", "(555) 555-7766", "(555) 666-6655"];
// Round 1743: same gap as rounds 1707/1736/1740/1742, missed for
// TeamMember (templates.ts's Project & Team Tracker template, "name" +
// "email" + "phone" + "jobTitle" -- the identical person shape as
// Customer). A project tracker that also tracks clients (an ordinary,
// reachable shape) seeded a team member as the literal same name/email/
// phone as an unrelated customer.
const TEAM_MEMBER_NAMES_HE = ["רונית אבוטבול", "דורון שחר", "לירון מלכה", "עומרי ששון"];
const TEAM_MEMBER_NAMES_EN = ["Ronit Abutbul", "Doron Shahar", "Liron Malka", "Omri Sasson"];
const TEAM_MEMBER_EMAIL_LOCAL_PARTS = ["ronit.abutbul", "doron.shahar", "liron.malka", "omri.sasson"];
const TEAM_MEMBER_PHONES_HE = ["054-222-7733", "058-333-8844", "050-444-9955", "052-555-1166"];
const TEAM_MEMBER_PHONES_EN = ["(555) 222-7733", "(555) 333-8844", "(555) 444-9955", "(555) 555-1166"];
// Round 1830: the "customerName"/"owner"/"assignee"/"instructor"/
// "technician" case below is the one switch case among "name"'s siblings
// with no entity-aware branching at all (aside from "instructor", which
// applies regardless of entity name) -- so WorkOrder.technician,
// Deal.owner, Task.assignee, and Ticket.assignee all fell through to the
// exact same generic PERSON_NAMES_HE/EN pool that is Customer.name's own
// fallback. Each of these can plausibly co-occur with Customer in the same
// generated spec (a field-service app has WorkOrder+Customer; a CRM has
// Deal+Task+Customer; a support desk has Ticket+Customer) -- and Deal and
// Task can also co-occur with EACH OTHER (a CRM has both) -- so a shared
// pool, index-aligned, risked showing the technician/deal-owner/assignee as
// the literal same person as the customer, or as each other, on the same
// row. Own pools per entity, same shape as rounds 1707/1736/1740/1742/1743.
const TECHNICIAN_NAMES_HE = ["משה אדרי", "אלה טל", "יואב נגר", "רותי שדה"];
const TECHNICIAN_NAMES_EN = ["Moshe Edri", "Ella Tal", "Yoav Nagar", "Ruti Sadeh"];
const DEAL_OWNER_NAMES_HE = ["אוריה בן-שושן", "דקלה קרני", "איתמר זוהר", "שירלי אבגי"];
const DEAL_OWNER_NAMES_EN = ["Uriah Ben-Shushan", "Dikla Karni", "Itamar Zohar", "Shirly Avgi"];
const TASK_ASSIGNEE_NAMES_HE = ["גיל אלמוג", "נטלי בר-און", "עידו רגב", "הדר מור"];
const TASK_ASSIGNEE_NAMES_EN = ["Gil Almog", "Natalie Bar-On", "Ido Regev", "Hadar Mor"];
const TICKET_ASSIGNEE_NAMES_HE = ["נועם גפן", "אור בכרי", "שני וייס", "דור חן"];
const TICKET_ASSIGNEE_NAMES_EN = ["Noam Gefen", "Or Bachri", "Shani Weiss", "Dor Chen"];
// Round 1832: the exact same gap round 1830 fixed one case block above,
// missed for the very next case block -- "ownerName"/"renterName"/
// "donorName"/"claimant"/"reviewerName" (Pet, Rental, Donation,
// InsuranceClaim, and Review respectively) all had zero entity-aware
// branching and fell through to the same generic PERSON_NAMES_HE/EN pool
// that is Customer.name's own fallback. Review in particular is almost
// guaranteed to co-occur with Customer: its own keywords ("customer
// review", "customer feedback") contain the literal substring "customer",
// so a description that matches Review almost always also matches
// Customer via its own bare "customer" keyword -- showing the reviewer as
// the literal same person as an unrelated customer on the same row. Own
// pools per entity, same shape as round 1830's.
const PET_OWNER_NAMES_HE = ["רעות בן-צבי", "עמית שגב", "נויה פלד", "תומר אשד"];
const PET_OWNER_NAMES_EN = ["Reut Ben-Zvi", "Amit Segev", "Noya Peled", "Tomer Eshed"];
const RENTER_NAMES_HE = ["יעל כרמי", "דביר אוסטרובסקי", "רוני אפרתי", "מורן זיו"];
const RENTER_NAMES_EN = ["Yael Carmi", "Dvir Ostrovsky", "Roni Efrati", "Moran Ziv"];
const DONOR_NAMES_HE = ["אברהם ויינשטיין", "חן יוגב", "שלי אלקיים", "בועז נתיב"];
const DONOR_NAMES_EN = ["Avraham Weinstein", "Chen Yogev", "Shelly Elkayam", "Boaz Nativ"];
const CLAIMANT_NAMES_HE = ["מירב שחם", "יובל אברג'יל", "אסנת ברעם", "גדי פורת"];
const CLAIMANT_NAMES_EN = ["Merav Shaham", "Yuval Abargil", "Osnat Bar-Am", "Gadi Porat"];
const REVIEWER_NAMES_HE = ["נדין חביב", "שון מויאל", "קארין דהן", "אלעד צדוק"];
const REVIEWER_NAMES_EN = ["Nadine Habib", "Shawn Moyal", "Karin Dahan", "Elad Tzadok"];
const SOURCES_HE = ["אתר האינטרנט", "המלצה מלקוח", "פייסבוק", "חיפוש בגוגל"];
const SOURCES_EN = ["Website", "Customer referral", "Facebook Ads", "Google Search"];
const ROLES_HE = ["מוכר/ת", "טכנאי/ת", "מנהל/ת משמרת", "רכז/ת שירות"];
const ROLES_EN = ["Sales Associate", "Technician", "Shift Manager", "Service Coordinator"];
// Round 1591: Volunteer (domainEntities.ts, "A person who donates time to
// the organization", and the identically-shaped Volunteer & Shift
// Management template's own Volunteer entity, templates.ts) shares the
// "role" field name with Employee ("A person who works for the business"),
// but ROLES_HE/EN above was written for Employee's own paid-staff job
// titles -- round 1115 already gave this exact entity's sibling "skills"
// field its own volunteer-flavored pool (SKILLS_HE/EN below), but never
// revisited "role" sitting right next to it, so a seeded Volunteer record
// read role: "Shift Manager" beside skills: "Event setup, First aid" --
// internally inconsistent on the very same row.
const VOLUNTEER_ROLES_HE = ["רכז/ת אירוע", "נהג/ת", "דלפק רישום", "עזרה במטבח"];
const VOLUNTEER_ROLES_EN = ["Event Coordinator", "Driver", "Registration Desk", "Kitchen Help"];
const DEAL_TITLES_HE = ["שדרוג חבילת שירות", "התקנה ראשונית", "חוזה שנתי", "הרחבת מנוי"];
const DEAL_TITLES_EN = ["Service upgrade", "Initial setup", "Annual contract", "Plan expansion"];
const WORK_ORDER_TITLES_HE = ["תיקון ברז דולף", "בדיקת מזגן", "החלפת חלון שבור", "בדק שנתי"];
const WORK_ORDER_TITLES_EN = ["Fix leaking faucet", "HVAC inspection", "Replace broken window", "Annual maintenance check"];
const CASE_TITLES_HE = ["מחלוקת חוזית", "סכסוך גבולות מקרקעין", "תביעת פיטורים", "תביעת נזקי גוף"];
const CASE_TITLES_EN = ["Contract dispute", "Property boundary dispute", "Employment termination claim", "Personal injury claim"];
const CASE_TYPES_HE = ["דיני חוזים", "דיני מקרקעין", "דיני עבודה", "נזיקין"];
const CASE_TYPES_EN = ["Contract Law", "Real Estate Law", "Employment Law", "Personal Injury"];
const TASK_TITLES_HE = ["כתיבת דוח רבעוני", "תיקון באג בהתחברות", "פולו-אפ עם לקוח", "עדכון תיעוד הפרויקט"];
const TASK_TITLES_EN = ["Write quarterly report", "Fix login bug", "Follow up with client", "Update project documentation"];
const MILESTONE_TITLES_HE = ["סיום שלב התכנון", "השקת גרסת בטא", "סיום בדיקות QA", "השקה לקהל הרחב"];
const MILESTONE_TITLES_EN = ["Design phase complete", "Beta launch", "QA testing complete", "Public launch"];
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
// Round 1115: pools for Volunteer.skills and Staff.specialty (templates.ts's
// Volunteer & Shift Management and Appointments & Clients templates), the
// next two field names that round-1105/1107/1114's own cross-check of
// templates.ts's hand-authored entities against this switch never reached.
const SKILLS_HE = ["אירועים, עזרה ראשונה", "הדרכה, ארגון", "הסעות, לוגיסטיקה", "תרגום, תקשורת"];
const SKILLS_EN = ["Event setup, First aid", "Training, Organization", "Driving, Logistics", "Translation, Communication"];
const SPECIALTIES_HE = ["צביעת שיער", "עיסוי רקמות עמוק", "טיפולי פנים", "תזונה קלינית"];
const SPECIALTIES_EN = ["Hair Coloring", "Deep Tissue Massage", "Facial Treatments", "Clinical Nutrition"];
// Shift.timeRange (same template) -- a plain time-of-day range, no Hebrew/
// English distinction needed (digits and a dash read the same either way).
const TIME_RANGES = ["09:00–13:00", "14:00–18:00", "18:00–22:00"];

function pick(pool: string[], index: number): string {
  return pool[index % pool.length];
}

// Round 1713: a lifecycle "status" enum whose first declared value means
// "hasn't happened yet" (Scheduled/Planned/Reserved -- the convention every
// one of this platform's own domain entities and curated templates that use
// this shape already follow) is seeded by the "enum" case below completely
// independently from this same record's own date field, which (see the
// "date" case) can never land on anything but today or earlier. So a freshly
// built Appointment/Event/WorkOrder, or the Appointments & Clients template,
// always opened to a row like "Scheduled" paired with a date 3 days in the
// past -- a plainly self-contradicting value, since an appointment that
// already happened can't still be "Scheduled". Deliberately narrow: only a
// field literally named "status" is checked (not any enum field), and only
// these three specific values, to avoid misreading an unrelated "Pending"/
// "Reserved"-as-table-state/"pending" (Restaurant order) enum that doesn't
// carry this same "upcoming" meaning.
const UPCOMING_STATUS_VALUES = new Set(["scheduled", "planned", "reserved"]);
function hasUpcomingStatusAt(entity: Entity, index: number): boolean {
  const statusField = entity.fields.find((f) => f.type === "enum" && f.name.toLowerCase() === "status");
  const values = statusField?.enumValues;
  if (!values || values.length === 0) return false;
  return UPCOMING_STATUS_VALUES.has(values[index % values.length].toLowerCase());
}

function seedValueFor(field: Field, entity: Entity, index: number): unknown {
  const entityName = entity.label ?? entity.name;
  const fieldLabel = field.label ?? field.name;
  const isHebrew = HEBREW_PATTERN.test(entityName) || HEBREW_PATTERN.test(fieldLabel);

  switch (field.type) {
    case "number": {
      // A 1-5 star rating shouldn't seed as 10/20/30 like every other
      // numeric field (amount, capacity, price, ...) -- it has a real,
      // narrow domain range, and a value outside it would look broken the
      // moment a real UI renders it as stars.
      if (field.name === "rating") return (index % 5) + 1;
      // Round 1624: the Real Estate Listings template's Property entity
      // (domainEntities.ts) has a "rooms" field -- without this, the same
      // generic formula seeds "10 rooms"/"20 rooms" for an Apartment/
      // House/Office, an obviously broken value no real listing would ever
      // have. A 1-6 range covers everything from a studio to a large house.
      if (field.name === "rooms") return (index % 6) + 1;
      // Round 1625: the Restaurant & Table Management template's
      // RestaurantTable entity (templates.ts) has a "seats" field -- same
      // gap as "rooms" above, a table seated for 10/20 guests looks
      // obviously broken. 2/4/6/8 covers a 2-top through a large booth.
      if (field.name === "seats") return ((index % 4) * 2) + 2;
      // Round 1674: the Restaurant & Table Management template's own
      // RestaurantTable entity (templates.ts) also has a "number" field
      // (table number) -- the same gap as "rooms"/"seats" above, right next
      // to "seats" on this exact entity. A table numbered 10/20 looks just
      // as obviously broken; a plain sequential counter starting at 1 is
      // the real-world convention for table numbers.
      if (field.name === "number") return index + 1;
      // Round 1709: the same collapse the "date" case below already fixed
      // (see dateFieldOrdinal's own comment) also applies here, unfixed
      // until now -- two ordinary number fields on one entity (e.g. the
      // Appointments & Clients template's Service.durationMinutes and
      // Service.price, templates.ts) both fell through to this same
      // index-only formula, seeding byte-identical values for two fields
      // the template authors clearly intended to be independent (the
      // Business Twin dashboard renders a separate chart for each). This
      // mirrors dateFieldOrdinal exactly: a field's position among the
      // entity's OTHER generic (non-special-cased) number fields offsets
      // it by a few units, so the first such field is unaffected (ordinal
      // 0 adds nothing, preserving every existing single-number-field
      // entity's seeded values) while a second/third gets a distinct one.
      const numberFieldOrdinal = entity.fields
        .filter((f) => f.type === "number" && !["rating", "rooms", "seats", "number"].includes(f.name))
        .findIndex((f) => f.name === field.name);
      return (index + 1) * 10 + numberFieldOrdinal * 5;
    }
    case "boolean":
      return index % 2 === 0;
    case "date": {
      // An end-of-range field (endDate, but also checkoutDate/returnDate/
      // untilDate/toDate -- the same conventions entityFormatting.ts's
      // findEndDateField already recognizes) needs to land after its
      // record's other date field(s), not collapse to the same day -- e.g.
      // Rental's startDate/endDate would otherwise both seed to the exact
      // same value for a given index, making every seeded rental a visibly
      // wrong 0-day rental. baseOffset always leaves a 3-day margin for an
      // end-like field to land 3 days closer to today (chronologically
      // after) without ever colliding, even at index 0.
      //
      // isEndLike only distinguishes a *recognized* end-of-range field from
      // everything else -- it says nothing about two date fields that are
      // both unrecognized (e.g. an AI-generated Employee's hireDate and
      // birthDate, neither an end-of-range pair at all). Without further
      // help, every non-end-like date field got the exact same baseOffset,
      // so any two such fields on one entity collapsed to the same seeded
      // value too. dateFieldOrdinal -- this field's position among the
      // entity's own date fields -- gives each one a distinct day, with no
      // effect on the existing end-like pair behavior above (the ordinal of
      // a pair's start field is always 0, adding nothing).
      //
      // The same collapse can happen between two RECOGNIZED end-of-range
      // fields too (e.g. a rental entity with both checkoutDate and
      // returnDate) -- isEndLike alone can't tell them apart, since every
      // end-like field used baseOffset - 3 with no further distinction.
      // endLikeOrdinal mirrors dateFieldOrdinal's own fix, scoped to only
      // the end-like fields, so a pair of them lands on distinct days too
      // (a single end-like field keeps ordinal 0, unchanged from before).
      const isEndLike = END_DATE_FIELD_NAME_HINTS.includes(field.name.toLowerCase());
      const dateFieldOrdinal = entity.fields.filter((f) => f.type === "date").findIndex((f) => f.name === field.name);
      const endLikeOrdinal = entity.fields
        .filter((f) => f.type === "date" && END_DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase()))
        .findIndex((f) => f.name === field.name);
      const baseOffset = (index + 1) * 3;
      // Round 1713 handled an entity with exactly ONE date field. Round
      // 1728 extended the same "upcoming status -> future date" idea to
      // exactly TWO date fields where exactly one is a recognized
      // end-of-range field (Rental's startDate/endDate), but explicitly
      // scoped itself to never touch any OTHER shape (3+ date fields, or
      // 2 fields with 0 or 2 end-like ones) -- round 1728's own comment
      // said so outright. That left the exact same self-contradiction
      // (a "Scheduled"/"Planned"/"Reserved" record whose date fields are
      // all still in the past) reachable for any such shape, which an
      // AI-generated spec can easily produce (e.g. a Workshop entity with
      // registrationDeadline/startDate/endDate) even though no entity in
      // this platform's own curated template library currently has it.
      // Round 1738 generalizes: the future-oriented offset below reduces
      // to byte-identical values for both already-fixed shapes (verified
      // against rounds 1713's and 1728's own tests), so dropping the
      // cardinality gate entirely is safe and now covers every shape.
      const intoFuture = hasUpcomingStatusAt(entity, index);
      const dayOffset = intoFuture
        ? isEndLike
          ? baseOffset + dateFieldOrdinal + 3
          : baseOffset + dateFieldOrdinal
        : isEndLike
          ? baseOffset - 3 + endLikeOrdinal
          : baseOffset + dateFieldOrdinal;
      const d = new Date(Date.now() + (intoFuture ? dayOffset : -dayOffset) * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    case "enum":
      return field.enumValues?.[index % (field.enumValues?.length ?? 1)] ?? null;
    case "relation":
      // Best-effort guess (row 1) when the field is required. orderForSeeding
      // below arranges the batch so the target entity is seeded first
      // whenever it's being seeded in the same batch, making this guess
      // correct for the ordinary case -- but it's still just a guess:
      // a relation to an entity that already has rows from an earlier,
      // unrelated build keeps whatever row 1 happens to be there, and a
      // same-entity (self) relation, or a genuine cycle between two
      // required relations, is left exactly as unaddressed as before.
      return field.required ? 1 : null;
    case "longtext":
      return isHebrew
        ? `${fieldLabel} לדוגמה עבור ${entityName} מספר ${index + 1}.`
        : `Sample ${field.name} for ${entityName} #${index + 1}.`;
    case "file":
      // There's no real uploaded file to point a seeded record at, unlike
      // every other type here which can synthesize a plausible-looking
      // value -- left empty rather than a fake descriptor that would 404
      // the moment someone clicked it.
      return null;
    case "text":
    default:
      return textSeedValueFor(field.name, entity.name, isHebrew, index);
  }
}

// Entities whose "name" field names a generic catalog item/thing, not a
// person. MenuItem/Project/Event/Course/Pet get their own dedicated pools
// below instead, since "a generic package" reads oddly as a dish or a
// project name. Round 1244: Product doesn't belong here either, for the
// same reason Rental was already carved out of the sibling "itemName"
// case below -- see its own dedicated branch in textSeedValueFor's "name"
// case.
const CATALOG_NAME_ENTITIES = new Set(["Service", "Item"]);

function textSeedValueFor(fieldName: string, entityName: string, isHebrew: boolean, index: number): string {
  switch (fieldName) {
    case "email":
      if (entityName === "Courier") return `${pick(COURIER_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "Employee") return `${pick(EMPLOYEE_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "Staff") return `${pick(STAFF_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "Student") return `${pick(STUDENT_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "Patient") return `${pick(PATIENT_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "Volunteer") return `${pick(VOLUNTEER_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "JobApplicant") return `${pick(JOB_APPLICANT_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "Contact") return `${pick(CONTACT_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "Vendor" || entityName === "Supplier") return `${pick(VENDOR_EMAIL_LOCAL_PARTS, index)}@example.com`;
      if (entityName === "TeamMember") return `${pick(TEAM_MEMBER_EMAIL_LOCAL_PARTS, index)}@example.com`;
      return `${pick(EMAIL_LOCAL_PARTS, index)}@example.com`;
    case "phone":
      if (entityName === "Courier") return pick(isHebrew ? COURIER_PHONES_HE : COURIER_PHONES_EN, index);
      if (entityName === "Employee") return pick(isHebrew ? EMPLOYEE_PHONES_HE : EMPLOYEE_PHONES_EN, index);
      if (entityName === "Staff") return pick(isHebrew ? STAFF_PHONES_HE : STAFF_PHONES_EN, index);
      if (entityName === "Student") return pick(isHebrew ? STUDENT_PHONES_HE : STUDENT_PHONES_EN, index);
      if (entityName === "Patient") return pick(isHebrew ? PATIENT_PHONES_HE : PATIENT_PHONES_EN, index);
      if (entityName === "Volunteer") return pick(isHebrew ? VOLUNTEER_PHONES_HE : VOLUNTEER_PHONES_EN, index);
      if (entityName === "JobApplicant") return pick(isHebrew ? JOB_APPLICANT_PHONES_HE : JOB_APPLICANT_PHONES_EN, index);
      if (entityName === "Contact") return pick(isHebrew ? CONTACT_PHONES_HE : CONTACT_PHONES_EN, index);
      if (entityName === "Vendor" || entityName === "Supplier") return pick(isHebrew ? VENDOR_PHONES_HE : VENDOR_PHONES_EN, index);
      if (entityName === "TeamMember") return pick(isHebrew ? TEAM_MEMBER_PHONES_HE : TEAM_MEMBER_PHONES_EN, index);
      return pick(isHebrew ? PHONES_HE : PHONES_EN, index);
    case "source":
      return pick(isHebrew ? SOURCES_HE : SOURCES_EN, index);
    case "role":
      if (entityName === "Volunteer") return pick(isHebrew ? VOLUNTEER_ROLES_HE : VOLUNTEER_ROLES_EN, index);
      return pick(isHebrew ? ROLES_HE : ROLES_EN, index);
    case "sku":
      return `SKU-${1000 + index * 42}`;
    case "title":
      // Same "field name reused across unrelated entity shapes" principle
      // as the "name" case below -- a Deal's title is a sales pitch, but a
      // WorkOrder's title is a repair job description, a Case's title is a
      // legal matter's subject, and a Task's title is a plain to-do, not a
      // sales phrase. Without this, WorkOrder/Case/Task seed records all
      // showed Deal's own sample titles ("Annual contract", "Service
      // upgrade") -- nonsensical as a repair job or legal case.
      if (entityName === "WorkOrder") return pick(isHebrew ? WORK_ORDER_TITLES_HE : WORK_ORDER_TITLES_EN, index);
      if (entityName === "Case") return pick(isHebrew ? CASE_TITLES_HE : CASE_TITLES_EN, index);
      if (entityName === "Task") return pick(isHebrew ? TASK_TITLES_HE : TASK_TITLES_EN, index);
      // Round 1107: Milestone is the Project Tracker template's own
      // entity (packages/spec-engine/src/templates.ts), not part of
      // domainEntities.ts's library -- a separate, hand-authored catalog
      // the previous entity-aware "title" branches above were never
      // cross-checked against, so it silently fell all the way through
      // to Deal's own sales-pitch titles below, the exact "nonsensical
      // for this entity shape" bug this whole switch exists to prevent.
      if (entityName === "Milestone") return pick(isHebrew ? MILESTONE_TITLES_HE : MILESTONE_TITLES_EN, index);
      return pick(isHebrew ? DEAL_TITLES_HE : DEAL_TITLES_EN, index);
    case "caseType":
      // Case's own optional "practice area" field -- distinct from its
      // "title" case just above (a specific matter, e.g. "Contract
      // dispute"), this is the broader legal category it falls under
      // (e.g. "Contract Law"). Added in the same commit as "title"'s own
      // Case branch but missed there, so this fell through to the
      // generic default placeholder ("Case caseType 1") with zero
      // entity-aware handling at all.
      return pick(isHebrew ? CASE_TYPES_HE : CASE_TYPES_EN, index);
    case "customerName":
    case "owner":
    case "assignee":
    case "instructor":
    case "technician":
      // Round 1830: see this pool group's own comment above -- technician/
      // owner/assignee each need their own entity-aware branch here, the
      // same precedence pattern "name" uses below, instead of all sharing
      // Customer's own PERSON_NAMES_HE/EN fallback. "customerName" is left
      // alone: it's a free-text field literally naming a customer (no
      // Customer relation implied), so sharing that pool is correct, not a
      // bug.
      if (fieldName === "instructor") return pick(isHebrew ? INSTRUCTORS_HE : INSTRUCTORS_EN, index);
      if (fieldName === "technician") return pick(isHebrew ? TECHNICIAN_NAMES_HE : TECHNICIAN_NAMES_EN, index);
      if (fieldName === "owner" && entityName === "Deal") return pick(isHebrew ? DEAL_OWNER_NAMES_HE : DEAL_OWNER_NAMES_EN, index);
      if (fieldName === "assignee" && entityName === "Task") return pick(isHebrew ? TASK_ASSIGNEE_NAMES_HE : TASK_ASSIGNEE_NAMES_EN, index);
      if (fieldName === "assignee" && entityName === "Ticket") return pick(isHebrew ? TICKET_ASSIGNEE_NAMES_HE : TICKET_ASSIGNEE_NAMES_EN, index);
      return pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    case "ownerName":
      return pick(isHebrew ? PET_OWNER_NAMES_HE : PET_OWNER_NAMES_EN, index);
    case "renterName":
      return pick(isHebrew ? RENTER_NAMES_HE : RENTER_NAMES_EN, index);
    case "donorName":
      return pick(isHebrew ? DONOR_NAMES_HE : DONOR_NAMES_EN, index);
    case "claimant":
      return pick(isHebrew ? CLAIMANT_NAMES_HE : CLAIMANT_NAMES_EN, index);
    case "reviewerName":
      return pick(isHebrew ? REVIEWER_NAMES_HE : REVIEWER_NAMES_EN, index);
    case "contactPerson":
      // Round 1742: Vendor (domainEntities.ts) and Supplier (templates.ts)
      // both have their own "name" field pool already (VENDOR_NAMES_HE/EN,
      // rounds 1107/1244), but this field -- the person AT that vendor's
      // own company -- still fell through to the same generic
      // PERSON_NAMES_HE/EN pool Customer uses, same gap as this field's
      // sibling email/phone cases above.
      if (entityName === "Vendor" || entityName === "Supplier") return pick(isHebrew ? VENDOR_CONTACT_NAMES_HE : VENDOR_CONTACT_NAMES_EN, index);
      return pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    case "service":
    case "itemName":
      // "itemName" (Rental's own required field, "an item rented out to a
      // customer for a defined period") names a physical piece of
      // equipment -- a drill, a projector, a tent -- not a service plan.
      // ITEM_NAMES_HE/EN was written for the "service" case's own owner,
      // Appointment ("Standard Treatment"/"Monthly Plan" fit a scheduled
      // service), and this case had no entity-aware branching at all
      // (unlike its "name"/"title"/"description" siblings), so Rental
      // silently inherited Appointment's service-plan phrasing instead.
      if (entityName === "Rental") return pick(isHebrew ? RENTAL_ITEM_NAMES_HE : RENTAL_ITEM_NAMES_EN, index);
      return pick(isHebrew ? ITEM_NAMES_HE : ITEM_NAMES_EN, index);
    case "address":
    case "destination":
      return pick(isHebrew ? ADDRESSES_HE : ADDRESSES_EN, index);
    // Round 1115: "location" (the Volunteer & Shift Management template's
    // own VolunteerEvent entity, templates.ts) is conceptually the same
    // "where is it happening" concept "venue" already covers for Event --
    // reuses that pool rather than inventing a near-duplicate one.
    case "venue":
    case "location":
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
    // Round 1114: "jobTitle" (the CRM template's Contact entity and the
    // Project Tracker template's TeamMember entity -- both templates.ts's
    // own hand-authored entities, not domainEntities.ts) is conceptually
    // the same concept as "appliedFor" (a person's job title) -- reuses
    // that pool rather than inventing a near-duplicate one, mirroring
    // round 1107's own Vendor/Supplier fix just below.
    case "appliedFor":
    case "jobTitle":
      return pick(isHebrew ? JOB_TITLES_HE : JOB_TITLES_EN, index);
    case "campaign":
      return pick(isHebrew ? CAMPAIGN_NAMES_HE : CAMPAIGN_NAMES_EN, index);
    case "carrier":
      return pick(isHebrew ? CARRIERS_HE : CARRIERS_EN, index);
    case "trackingNumber":
      return `TRK-${100000 + index * 37}`;
    case "policyNumber":
      return `POL-${500000 + index * 111}`;
    // Round 1115: "company" (the Sales CRM template's own Customer entity,
    // templates.ts) is conceptually the same "business, not a person"
    // shape as Vendor -- the business a contact works at, not an actual
    // vendor relationship, but the same realistic-company-name pool fits
    // either equally well.
    case "vendor":
    case "company":
    // Round 1590: "client" (domainEntities.ts's own Project entity, "Defined
    // work the business performs for a client", plus the Project Tracker
    // template's identically-shaped Project.client, templates.ts) is the
    // same B2B "business, not a person" concept company/vendor already
    // cover above -- it previously shared the generic person-name case with
    // ownerName/renterName/donorName/claimant/contactPerson/reviewerName
    // (all genuinely individual people), seeding a freshly built Project
    // Tracker app with rows like "Website Redesign -- Client: Dana Levi"
    // instead of a company name.
    case "client":
      return pick(isHebrew ? VENDOR_NAMES_HE : VENDOR_NAMES_EN, index);
    // Round 1115: the Volunteer & Shift Management template's own
    // Volunteer.skills and Shift.timeRange, and the Appointments & Clients
    // template's own Staff.specialty (all templates.ts, not
    // domainEntities.ts) -- three more field names round 1105/1107/1114's
    // own cross-check never reached. timeRange is a plain time-of-day
    // range with no Hebrew/English distinction needed.
    case "skills":
      return pick(isHebrew ? SKILLS_HE : SKILLS_EN, index);
    case "specialty":
      return pick(isHebrew ? SPECIALTIES_HE : SPECIALTIES_EN, index);
    case "timeRange":
      return pick(TIME_RANGES, index);
    case "description":
      if (entityName === "Expense") return pick(isHebrew ? EXPENSE_DESCRIPTIONS_HE : EXPENSE_DESCRIPTIONS_EN, index);
      return isHebrew ? `${entityName} - ${fieldName} ${index + 1}` : `${entityName} ${fieldName} ${index + 1}`;
    case "name":
      // "name" means different things for different entity shapes -- a
      // person for people-shaped entities, a thing for catalog-shaped
      // ones, and its own dedicated pool for a few entities where neither
      // fits well (a project isn't a "product", a pet isn't a "customer").
      // Round 1244: Product (its own sku/quantity fields -- a physical,
      // countable inventory good) is checked before the generic
      // CATALOG_NAME_ENTITIES fallback below, the same "entity-specific
      // branch wins over the shared pool" precedence the service/itemName
      // case already established for Rental.
      if (entityName === "Product") return pick(isHebrew ? PRODUCT_NAMES_HE : PRODUCT_NAMES_EN, index);
      if (CATALOG_NAME_ENTITIES.has(entityName)) return pick(isHebrew ? ITEM_NAMES_HE : ITEM_NAMES_EN, index);
      if (entityName === "MenuItem") return pick(isHebrew ? DISH_NAMES_HE : DISH_NAMES_EN, index);
      if (entityName === "Project") return pick(isHebrew ? PROJECT_NAMES_HE : PROJECT_NAMES_EN, index);
      if (entityName === "Event") return pick(isHebrew ? EVENT_NAMES_HE : EVENT_NAMES_EN, index);
      // Round 1148: VolunteerEvent (the Volunteer & Shift Management
      // template's own entity, templates.ts -- round 1115 already found
      // three of this same template's other field names, but never
      // cross-checked "name" itself) is conceptually the same "an event,
      // not a person" shape as domainEntities.ts's own Event -- reuses
      // that pool rather than inventing a near-duplicate one.
      if (entityName === "VolunteerEvent") return pick(isHebrew ? EVENT_NAMES_HE : EVENT_NAMES_EN, index);
      if (entityName === "Course") return pick(isHebrew ? COURSE_NAMES_HE : COURSE_NAMES_EN, index);
      if (entityName === "Pet") return pick(isHebrew ? PET_NAMES_HE : PET_NAMES_EN, index);
      // Round 1107: Supplier (the Inventory template's own entity,
      // templates.ts, not domainEntities.ts) is conceptually the same
      // shape as Vendor -- a business, not a person -- but had no branch
      // of its own and fell through to the generic person-name default
      // below, seeding a supplier with a random person's name instead of
      // a company name. Reuses Vendor's own pool rather than inventing a
      // near-duplicate one.
      if (entityName === "Vendor" || entityName === "Supplier") return pick(isHebrew ? VENDOR_NAMES_HE : VENDOR_NAMES_EN, index);
      // Round 1707: Courier (domainEntities.ts, "the person who delivers an
      // order to a customer") is a real person like Customer, but must not
      // share Customer's own name pool -- an order's customer and its
      // courier reading as the literal same name/email/phone on the same
      // row defeats the whole point of the two being separate roles.
      if (entityName === "Courier") return pick(isHebrew ? COURIER_NAMES_HE : COURIER_NAMES_EN, index);
      if (entityName === "Employee") return pick(isHebrew ? EMPLOYEE_NAMES_HE : EMPLOYEE_NAMES_EN, index);
      if (entityName === "Staff") return pick(isHebrew ? STAFF_NAMES_HE : STAFF_NAMES_EN, index);
      if (entityName === "Student") return pick(isHebrew ? STUDENT_NAMES_HE : STUDENT_NAMES_EN, index);
      if (entityName === "Patient") return pick(isHebrew ? PATIENT_NAMES_HE : PATIENT_NAMES_EN, index);
      if (entityName === "Volunteer") return pick(isHebrew ? VOLUNTEER_NAMES_HE : VOLUNTEER_NAMES_EN, index);
      if (entityName === "JobApplicant") return pick(isHebrew ? JOB_APPLICANT_NAMES_HE : JOB_APPLICANT_NAMES_EN, index);
      if (entityName === "Contact") return pick(isHebrew ? CONTACT_NAMES_HE : CONTACT_NAMES_EN, index);
      if (entityName === "TeamMember") return pick(isHebrew ? TEAM_MEMBER_NAMES_HE : TEAM_MEMBER_NAMES_EN, index);
      return pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    default:
      // No specific pool for this field name (a custom entity from an
      // AI-generated or refined spec, not the built-in domain library) —
      // fall back to a labeled placeholder rather than guessing wrong.
      return isHebrew ? `${entityName} - ${fieldName} ${index + 1}` : `${entityName} ${fieldName} ${index + 1}`;
  }
}

/**
 * Orders a batch of entities being seeded together so a relation field's
 * best-effort target (seedValueFor above's `id=1` guess for a *required*
 * relation, or pipeline.ts's own "overwrite with whichever real row the
 * target actually has right now" pass for an *optional* one) actually lands
 * on a real row instead of staying a dangling FK or a needlessly null
 * optional link -- e.g. an AI-generated or refined spec listing entities as
 * [Invoice, Customer] with Invoice.customerId a required relation to
 * Customer (an entirely ordinary, correct data model the built-in domain
 * library just never happens to produce, per that guess's own doc-comment).
 * Without this, seeding Invoice first throws a real FK-constraint violation
 * on every attempt (Customer has zero rows yet) -- and the pipeline's own
 * seed step doesn't stop the build on that failure, so by the time QA's
 * required-field smoke test runs, Customer has since been seeded by its own
 * later turn in the loop, making the SAME guessed id=1 succeed there and
 * mask that Invoice's table is left with zero demo rows, the one thing
 * seeding exists to prevent. A plain topological sort by relation target,
 * falling back to the given order for anything left in a cycle (including a
 * self-relation, e.g. Employee.managerId -> Employee, which this
 * deliberately leaves exactly as fragile as it already was rather than
 * attempting a same-entity ordering this guess-based generator can't
 * actually satisfy anyway).
 *
 * Round 2000: this used to build its dependency edges from *required*
 * relations only (`!field.required` excluded an optional one outright),
 * reasoning (per this function's own pre-round-2000 doc comment and a
 * dedicated regression test) that "only a required one actually needs a
 * real row to point at." That was true for seedValueFor's own static guess
 * (an optional relation is left `null`, never a dangling guessed id), but
 * round 1995's own fix to pipeline.ts's seeding loop made it false for
 * ORDERING: that loop now upgrades an optional relation to a real target row
 * too, whenever the target genuinely has rows "right here, right now, in
 * this same batch" -- but whether it does at the exact moment a given
 * entity is processed depends entirely on this function's own ordering.
 * The built-in domain library's own Order.courierId (optional, ->Courier)
 * is declared BEFORE Courier in domainEntities.ts's own rule array, and
 * matchEntities() preserves that declaration order verbatim in the
 * generated spec regardless of how the description phrases things -- so a
 * description matching both ("delivery orders and the couriers who deliver
 * them") seeds Order before Courier under the old required-only ordering,
 * and round 1995's own "existing.length > 0" check sees zero Courier rows
 * yet for every one of them: every seeded Order's courierId stayed `null`
 * even though 2 real Courier rows exist two lines later in the exact same
 * build. Independently reproduced against the real `generateSpec`/
 * `runBuildPipeline` before fixing: that description seeded 2 real Courier
 * rows, yet both seeded Order rows had `courierId: null`. Dropping the
 * `!field.required` exclusion here -- so an optional relation's target gets
 * the identical ordering priority a required one already has -- closes this
 * without touching pipeline.ts's own linking pass at all: it already does
 * the right thing the moment the target it's checking has actually been
 * seeded first.
 */
export function orderForSeeding(entities: Entity[]): Entity[] {
  // Round 1209: resolved through a LOWERCASE-keyed lookup to the target's
  // real declared name, not a raw case-sensitive Set.has/string-equality
  // check against relationTo itself -- the same AI-regeneration casing
  // drift rounds 1159-1188/1196/1208 already fixed in every other
  // consumer of relationTo (migrate.ts's own resolveRelationTarget
  // convention this mirrors) can leave a relation field's relationTo
  // differently cased from its target's real name with nothing else
  // about the spec changed. Before this, that dependency edge was
  // silently dropped (names.has(field.relationTo) failed, so the target
  // was never added to this entity's own seedTargets), with no
  // guarantee the target got seeded first -- resolving against the
  // target's real name here means `targets` always holds the same
  // canonical casing `placed` is populated with below, so the ordering
  // comparison stays meaningful regardless of relationTo's own casing.
  const namesByLowerName = new Map(entities.map((e) => [e.name.toLowerCase(), e.name]));
  // Round 2000: no longer filtered to `field.required` only -- see this
  // function's own doc comment above for why an optional relation needs
  // the identical ordering priority.
  const seedTargets = new Map<string, Set<string>>();
  for (const entity of entities) {
    const targets = new Set<string>();
    for (const field of entity.fields) {
      if (field.type !== "relation" || !field.relationTo) continue;
      const resolvedTarget = namesByLowerName.get(field.relationTo.toLowerCase());
      if (resolvedTarget && resolvedTarget !== entity.name) {
        targets.add(resolvedTarget);
      }
    }
    seedTargets.set(entity.name, targets);
  }

  const ordered: Entity[] = [];
  const placed = new Set<string>();
  const remaining = [...entities];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((e) => [...seedTargets.get(e.name)!].every((target) => placed.has(target)));
    if (readyIndex === -1) {
      // A cycle (or a relation to an entity outside this batch that will
      // never show up as "placed") -- append what's left in its original
      // relative order rather than looping forever.
      ordered.push(...remaining);
      break;
    }
    const [entity] = remaining.splice(readyIndex, 1);
    placed.add(entity.name);
    ordered.push(entity);
  }
  return ordered;
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
