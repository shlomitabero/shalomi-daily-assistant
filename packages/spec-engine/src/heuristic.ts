import type { Entity, OpenQuestion, ProductSpec, Screen } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { SpecProvider } from "./provider.js";
import {
  DEFAULT_ENTITY,
  DEFAULT_ENTITY_LABEL_HE,
  DEFAULT_ENTITY_DESCRIPTION_HE,
  DEFAULT_ENTITY_FIELD_LABELS_HE,
  DEFAULT_ENTITY_ENUM_LABELS_HE,
  DOMAIN_ENTITY_RULES,
  ROLE_RULES,
  isHebrewText,
} from "./domainEntities.js";

const PAYMENT_KEYWORDS: (string | RegExp)[] = [
  "payment", "invoice", "billing", "subscription",
  // Bare "checkout" (round 550) is as genuinely ambiguous here as it is in
  // domainEntities.ts's own Order keywords (see that file's own comment) --
  // a library's book checkout or a hotel's checkout time has nothing to do
  // with payments, so this list needs the same specific-phrase requirement.
  "checkout page", "checkout flow", "online checkout",
  // Plain "stripe" would also match "striped"/"pinstripe" as a plain
  // substring (same collision class fixed elsewhere in this codebase, e.g.
  // domainEntities.ts's keyword matching) -- a clothing-store description
  // mentioning "striped shirts" has nothing to do with the Stripe payment
  // provider. "Stripe" the company is never referred to in the plural, so
  // a \b-bounded regex (rather than allowing an "s" suffix) also correctly
  // keeps rejecting "stripes" (the fabric pattern, plural).
  /\bstripe\b/,
  "תשלום", "תשלומים", "חשבונית",
  // Bare "חיוב" ("charge") is a substring of the ordinary, unrelated
  // adjective/noun "חיובי"/"חיובית"/"חיוביות" ("positive"/"positivity") --
  // extremely natural phrasing for a feedback/review/survey app ("משוב
  // חיובי", "ביקורת חיובית"), which has nothing to do with billing. JS's
  // \b doesn't bound Hebrew (round 518's own fix for "מלאי" hit the same
  // issue), so this excludes "חיוב" immediately followed by "י" unless
  // that "י" is itself followed by "ם" -- which still matches the real
  // plural "חיובים" ("charges") while rejecting the "positive" forms.
  /חיוב(?!י(?!ם))/,
  // Bare "מנוי" (round 563) is a substring of the ordinary plural
  // "אומנויות"/"אמנויות" ("arts"/"crafts", as in "אומנויות לחימה" --
  // martial arts) -- same collision class and fix as domainEntities.ts's
  // own Subscription keyword (see that file's comment).
  /מנוי(?!ות)/,
  // Round 893: an ordinary online-store/retail description ("An online
  // store where customers buy products from our catalog") matches only
  // Customer/Product -- neither BILLING_ENTITY_NAMES below (Product was
  // never added there, deliberately -- see that Set's own comment) nor
  // any existing PAYMENT_KEYWORDS phrase, so it got recommended "No
  // payments" despite being the single most common real-world paid
  // business shape this provider is used for. Adding bare "store" or
  // "sell"/"selling" here instead of these specific e-commerce phrases
  // would have been too broad: the round-460 test just above
  // ("An inventory tracker for a clothing store selling striped shirts...")
  // deliberately expects "No payments" for a plain inventory tracker that
  // also happens to use "store"/"selling" in its own wording, matching
  // the same over-broad-signal problem this file's own BILLING_ENTITY_
  // NAMES comment already documents rejecting for Service. These phrases
  // are specific enough to the customer-facing storefront concept itself
  // that they don't fire for an internal inventory-tracking description.
  "online store", "storefront", "shopping cart", "add to cart", "e-commerce", "ecommerce",
  "חנות מקוונת", "חנות אונליין", "עגלת קניות",
  // Round 1007: a tutoring/course-booking description ("parents pay a
  // monthly fee for their kids' swimming courses") matches only the Course
  // entity, which is deliberately NOT in BILLING_ENTITY_NAMES below -- a
  // course can genuinely be free (a volunteer training, a community
  // class), so adding Course there would wrongly flip every free-course
  // description to "Stripe" too (the exact "too broad a signal" problem
  // this file's own BILLING_ENTITY_NAMES comment already documents
  // rejecting for Service). The right fix is the same shape as round 893's
  // e-commerce phrases: specific, low-ambiguity fee-charging wording that
  // doesn't fire for an ordinary free-course description. Hebrew already
  // handles this correctly -- natural fee phrasing ("גובה תשלום חודשי")
  // already contains the literal "תשלום" substring -- so this is an
  // English-only gap.
  "monthly fee", "tuition", "charges parents", "charges customers",
  // Round 1523: the exact same drift this file's own PAYMENT_KEYWORDS
  // comments above (round 893's e-commerce phrases, round 1007's
  // "monthly fee"/"tuition") already document for other entities, this
  // time for Vehicle. A car-dealership or vehicle-rental description
  // ("A CRM for a car dealership to manage vehicles.") matches only
  // Vehicle and got recommended "No payments", even though selling or
  // renting out vehicles for money is definitionally a paid transaction
  // -- the same Rental/Property/MenuItem/WorkOrder/InsuranceClaim shape
  // BILLING_ENTITY_NAMES below already covers, just not reachable that
  // way here: Vehicle's own bare keywords ("vehicle", "fleet management",
  // "garage", "mechanic") are genuinely ambiguous (an internal company
  // fleet-tracking tool with no customer payment at all also matches
  // them), so simply adding "Vehicle" to BILLING_ENTITY_NAMES would
  // regress the same way that Set's own comment already documents
  // rejecting for Service/Course. "car dealership" is already one of
  // Vehicle's own keywords and always implies a sale, so it's safe here
  // too. "ניהול צי רכבים להשכרה" ("managing a fleet of vehicles for
  // rental") is already a real test fixture for Vehicle's own entity
  // match (heuristic.test.ts's realVehicles case) -- this word order
  // doesn't contain Rental's own narrower keywords ("השכרת רכב"), so it
  // needs its own specific phrase rather than relying on Rental firing.
  "car dealership", "car rental", "vehicle rental", "rent out vehicles",
  "רכב להשכרה", "רכבים להשכרה", "מכירת רכבים",
  // Round 1979: the identical drift once more, for the repair-shop half
  // of this same Vehicle gap -- "An app for my auto repair shop to track
  // customers and vehicles" matches Vehicle via its own bare keywords
  // (genuinely ambiguous, as this comment's own reasoning above already
  // explains) and still got "No payments", even when Vehicle is matched
  // through an unambiguous commercial route like "garage"/"mechanic"/
  // "מוסך". An auto-repair/car-repair/body shop is a textbook paid trade
  // business, the exact same class this comment's own round-1523 fix
  // already covers for a sale/rental. "מוסך" is already one of Vehicle's
  // own exact keywords and, like "car dealership" above, always implies
  // a commercial repair business (never an internal company fleet tool),
  // so it's safe to reuse directly here.
  "auto repair", "car repair", "auto body shop", "auto body",
  "מוסך", "תיקון רכבים",
  // Round 1700: the same drift once more, this time for Course via
  // "sell"/"paid" wording rather than round 1007's "fee"/"tuition"
  // wording. "A platform for creators to sell online courses" matches
  // only Course (deliberately not in BILLING_ENTITY_NAMES -- a course can
  // genuinely be free, see round 1007's own comment) and hits none of
  // round 1007's fee-specific phrases, so it got recommended "No
  // payments" despite "selling" a course being definitionally a paid
  // transaction -- the same reasoning round 893 already used for
  // "store"/"selling" in the e-commerce case. Bare "sell"/"selling" was
  // deliberately rejected there (the round-460 inventory-tracker test
  // just above requires "selling striped shirts" to stay "No payments"),
  // so this is scoped narrowly to "sell/paid + (optional online) +
  // course(s)" rather than a bare keyword, mirroring round 1007's own
  // "specific, low-ambiguity phrase" shape. Verified the existing
  // round-1007 free-course regression test ("free weekly yoga courses")
  // still correctly stays "No payments" -- neither new pattern fires on
  // it.
  //
  // Round 1989: this round-1700 pair only ever covered the word "course(s)"
  // itself -- but domainEntities.ts's own Course keyword list (round 1727's
  // comment there) explicitly treats "class"/"classes" as the exact same
  // concept as "course"/"courses" for ENTITY matching purposes ("A course
  // or class the business teaches"). That equivalence was never carried
  // over here: "A yoga studio offering paid classes and workshops." and "A
  // platform for creators to sell online classes." both match Course (via
  // its own bare /\bclasses?\b/-shaped keywords) exactly like their
  // "course(s)" counterparts already do, but hit neither new pattern below
  // and got "No payments" -- the identical drift round 1700 itself fixed,
  // just one word short of covering the entity's own documented synonym.
  // Verified live that a plain "free weekly yoga classes" description
  // still correctly stays "No payments" (bare "classes" alone is
  // untouched, same as bare "courses" already was).
  /\bsell(?:ing)?\s+(?:online\s+)?(?:courses?|classes?)\b/,
  /\bpaid\s+(?:online\s+)?(?:courses?|classes?)\b/,
  "למכור קורסים", "מכירת קורסים", "קורסים בתשלום", "קורס בתשלום",
  // Round 1989: same "course"/"class" synonym gap as the two regexes just
  // above, for Hebrew -- "שיעור"/"שיעורים" ("lesson"/"lessons") is already
  // one of Course's own bare Hebrew keywords (domainEntities.ts), the exact
  // Hebrew-language counterpart to English "class(es)" in this same
  // tutoring/lesson-selling context, but only the "קורס"/"קורסים" wording
  // had its own fee-charging phrases here.
  "למכור שיעורים", "מכירת שיעורים", "שיעורים בתשלום", "שיעור בתשלום",
  // Round 1819: a hair salon/barbershop/spa/massage business matches only
  // Appointment (rounds 1799/1800's own keywords), which isn't in
  // BILLING_ENTITY_NAMES below and hits none of this array's other
  // phrases, so it got recommended "No payments" despite being a
  // textbook paid small-business vertical. Rounds 1345/1346 explicitly
  // considered and deferred adding "Appointment" to BILLING_ENTITY_NAMES
  // itself for this exact reason -- plenty of real appointment apps are
  // genuinely non-commercial (school/government/volunteer bookings), the
  // same bare-word ambiguity already documented above for why Service was
  // excluded; confirmed live that doing so would wrongly recommend Stripe
  // for e.g. a school's parent-teacher-conference scheduler. Instead,
  // mirroring the exact same specific, low-ambiguity phrases
  // Appointment's own keyword list already uses (domainEntities.ts) --
  // these phrases only ever describe an actual commercial salon/spa
  // business, never a free/government/school/volunteer booking.
  "hair salon", "beauty salon", "nail salon", "barbershop", "barber shop", "hairdresser", "hair stylist",
  /\bspa\b/, "massage", "massage therapy",
  // Round 1983: bare "ספא" here is the identical mirrored copy of
  // domainEntities.ts's own Appointment keyword (see that file's own
  // round-1983 comment) -- it's a literal 3-letter prefix of "ספארי"
  // (safari) and "ספאם" (spam), so an unrelated safari-tour or spam-
  // filter app description spuriously hit this array too, wrongly
  // recommending Stripe on top of the entity-match false positive. Kept
  // in sync with the same `(?!רי|ם)` lookahead guard.
  "מספרה", "סלון יופי", /ספא(?!רי|ם)/, "עיסוי",
  // Round 1831: the exact same drift round 1819 fixed for salons/spas,
  // this time for pet care. A dog/cat grooming, pet sitting/boarding/
  // walking, or veterinary business matches only Pet (rounds 1752/1817's
  // own keywords in domainEntities.ts), which isn't in BILLING_ENTITY_
  // NAMES below and hits none of this array's other phrases, so it got
  // recommended "No payments" despite dog/cat grooming, pet sitting/
  // boarding/walking, and veterinary care all being textbook paid small-
  // business services. "Pet" itself was deliberately NOT added to
  // BILLING_ENTITY_NAMES below -- same bare-word-ambiguity reasoning that
  // Set's own comment already documents for Service/Appointment: a public
  // animal shelter's intake tracker also matches Pet with zero commercial
  // intent. These specific phrases, already proven unambiguous as Pet's
  // own entity-matching keywords, are commercial-only the same way
  // round 1819's salon/spa/massage phrases are.
  "pet grooming", "dog grooming", "cat grooming", "dog groomer", "cat groomer", "pet groomer",
  "dog walking", "dog walker", "pet sitting", "pet sitter", "pet boarding", "dog daycare",
  "veterinary", "vet clinic", "animal clinic",
  "טיפוח כלבים", "טיפוח חתולים", "טיול כלבים", "פנסיון לכלבים", "וטרינר", "וטרינרית",
  // Round 1841: the exact same drift rounds 1819/1831 already fixed for
  // salons/spas and pet care, this time for human medical/dental care. A
  // dental/medical clinic or private practice matches only Patient
  // (domainEntities.ts), which was deliberately NOT added to
  // BILLING_ENTITY_NAMES below -- a public hospital or free/community
  // clinic's patient tracker also matches Patient with zero commercial
  // intent, the same bare-word ambiguity Service/Appointment/Pet were
  // excluded for (see that Set's own doc comment). Bare "clinic" stays
  // excluded for the identical reason -- a government or non-profit
  // clinic is exactly as real as a private one. These phrases are
  // specific to an explicitly PRIVATE/commercial practice, never a public
  // or charity one, confirmed live: "a public health clinic tracking
  // patients" and "a non-profit free clinic" both still correctly stay
  // "No payments".
  "dental clinic", "medical clinic", "dental practice", "medical practice", "private practice",
  "doctor's office", "physical therapy clinic", "chiropractic clinic", "private clinic",
  "מרפאת שיניים", "קליניקה פרטית", "מרפאה פרטית",
  // Round 1872: the exact same drift rounds 1819/1831/1841 already fixed
  // for salons/spas, pet care, and private medical/dental clinics, this
  // time for photography studios, tattoo studios, and catering companies.
  // A photography-studio description ("A photography studio to manage
  // client sessions and wedding packages.") matches only Customer/Event;
  // a tattoo-studio description matches only Appointment; a catering
  // description matches only Customer/Appointment (or, in Hebrew phrasing
  // that happens to contain "הזמנות", also Order) -- none of these
  // entities are in BILLING_ENTITY_NAMES below (Appointment/Customer are
  // excluded for the same bare-word ambiguity Service/Pet/Patient were,
  // and Event/Order aren't reliable standalone signals either), and none
  // of this array's existing phrases fire for them, so all three got
  // recommended "No payments" despite being textbook paid small-business
  // verticals charging per session/tattoo/event. Confirmed live that
  // "photography studio"/"tattoo studio"/"catering company" each fixed
  // their own English case, and the Hebrew equivalents fixed both the
  // literal reported cases and a second Hebrew catering phrasing that
  // doesn't happen to contain "הזמנות" (so wasn't already covered via
  // Order). Bare "photographer"/"tattoo"/"catering" are deliberately
  // excluded -- a hobbyist photography club or a non-commercial tattoo-
  // design app has zero commercial intent, the same reasoning this file
  // already applies to bare "clinic"/"appointment"/"service".
  "photography studio", "wedding photographer", "freelance photographer", "photo package", "photography package",
  "tattoo studio", "tattoo shop", "tattoo parlor", "tattoo artist",
  "catering company", "catering service", "catering business",
  "סטודיו צילום", "צילום חתונות", "חבילת צילום",
  "סטודיו קעקועים",
  "חברת קייטרינג", "שירותי קייטרינג",
  // Round 1879: the exact same drift rounds 1819/1831/1841/1872 already
  // fixed for salons/spas, pet care, medical/dental clinics, and
  // photography/tattoo/catering, this time for law firms, bookkeeping/
  // accounting, personal training, and insurance agencies. A law-firm
  // description matches only Customer/Case; a bookkeeping-service
  // description matches only Customer/Service; a personal-training-studio
  // or insurance-agency description matches only Customer -- none of
  // these entities are in BILLING_ENTITY_NAMES below (Customer/Case/
  // Service are excluded for the same bare-word ambiguity Service/
  // Appointment/Pet/Patient were, see that Set's own comment), and none of
  // this array's existing phrases fire for them, so all four got
  // recommended "No payments" despite being textbook paid small-business/
  // professional-services verticals. Confirmed live that each phrase fixes
  // its own case, and that the non-commercial counter-examples ("a free
  // legal aid clinic helping low-income clients with their cases", "a
  // volunteer-run community fitness program", "a public legal assistance
  // hotline tracking cases for volunteers") still correctly stay "No
  // payments" -- none of them contain "law firm"/"personal training
  // studio"/"bookkeeping service"/"insurance agency". Bare "lawyer"/
  // "trainer"/"accountant"/"insurance" are deliberately excluded -- a
  // public defender's office, a volunteer fitness coach, a non-profit's
  // bookkeeper, or a government insurance program has zero commercial
  // intent, the same reasoning this file already applies to bare
  // "clinic"/"appointment"/"service".
  "law firm", "legal services", "legal practice",
  "personal training studio", "personal trainer", "personal training business",
  "bookkeeping service", "bookkeeping business", "accounting firm",
  "insurance agency", "insurance agent",
  "משרד עורכי דין", "שירותים משפטיים",
  "סטודיו לאימונים אישיים", "מאמן/ת אישי/ת",
  "שירותי הנהלת חשבונות",
  "סוכנות ביטוח",
  // Round 1928: the exact same drift rounds 1819/1831/1841/1872/1879
  // already fixed for salons/spas, pet care, medical/dental clinics,
  // photography/tattoo/catering, and law/bookkeeping/personal-training/
  // insurance, this time for climbing gyms, trampoline parks, and pilates
  // studios. A description like "A climbing gym managing day passes and
  // member bookings." matches only Appointment, and "A pilates studio for
  // scheduling classes and clients." matches only Customer/Course -- none
  // of which are in BILLING_ENTITY_NAMES below (same bare-word ambiguity
  // documented there for Service/Appointment/Pet/Patient/Customer/Case/
  // Course), and none of this array's existing phrases fire for them, so
  // both got recommended "No payments" despite being textbook paid small-
  // business/entertainment verticals. Unlike those three phrases, bare
  // "gym" and "fitness center"/"fitness centre" are deliberately NOT added
  // here: a YMCA, corporate wellness room, hotel gym, or apartment-complex
  // fitness amenity is a genuinely common free/non-commercial case (the
  // same ambiguity this file already excludes bare "clinic"/"service" for)
  // -- "A gym managing member check-ins and class schedules" stays "No
  // payments" by this same discipline, same as bare "appointment"/"clinic"
  // do. "climbing gym", "trampoline park", and "pilates studio" are
  // themselves specific enough that a free/non-commercial counterpart
  // realistically never uses that exact phrasing. Confirmed live that
  // round 1879's own "A volunteer-run community fitness program for
  // seniors" non-regression fixture, and a new "A free community gym for
  // seniors run by the city" check, both still correctly stay "No
  // payments" -- neither contains any of these three new phrases.
  "climbing gym", "trampoline park", "pilates studio",
  "קיר טיפוס", "פארק טרמפולינות", "סטודיו פילאטיס",
  // Round 1934: the exact same drift rounds 1819/1831/1841/1872/1879/1928
  // already fixed for salons/spas, pet care, medical/dental clinics,
  // photography/tattoo/catering, law/bookkeeping/personal-training/
  // insurance, and climbing-gym/trampoline/pilates, this time for dry
  // cleaners, car washes, laundromats, notaries, auto detailers, and
  // driving schools. None of these match a WorkOrder keyword either (they
  // aren't "scheduled technician visits a customer's property" trades),
  // so each matches only the generic Customer entity (driving school also
  // matches Student/Course) -- none of which are in BILLING_ENTITY_NAMES
  // below -- and hits none of this array's existing phrases, so all six
  // got recommended "No payments" despite being textbook paid small-
  // business verticals with no common free/non-commercial counterpart
  // (unlike "clinic"/"service"/"appointment", which this file deliberately
  // keeps out of BILLING_ENTITY_NAMES for exactly that reason). Confirmed
  // live via the real HeuristicSpecProvider that all six phrasings below
  // reproduce "No payments" before this fix and "Stripe" after.
  "dry cleaning", "dry cleaner", "dry cleaners", "car wash", "laundromat",
  "notary public", "auto detailing", "driving school",
  "ניקוי יבש", "מכבסה אוטומטית", "נוטריון", "בית ספר לנהיגה",
];

/**
 * Entities whose whole purpose is receiving money, so their presence alone
 * implies "yes, this app needs to accept payments" even when the
 * description's own wording never hits PAYMENT_KEYWORDS -- e.g. "a donation
 * tracker for our nonprofit, with donor records and fundraising campaigns"
 * matches only the Donation entity and contains none of "payment"/
 * "billing"/etc., yet accepting donations plainly means accepting payments.
 * Same reasoning for Subscription ("a member management app with membership
 * plans" matches Subscription via "member management"/"membership plan",
 * neither of which contains "subscription" or "billing" as a substring).
 * Kept as an explicit entity-name list rather than only expanding
 * PAYMENT_KEYWORDS, since new payment-flavored keyword phrasing for these
 * entities will keep getting added over time (see domainEntities.ts) and a
 * keyword-only check would need updating in lockstep forever; checking the
 * entity itself is the one place this can't silently drift out of sync.
 *
 * Round 566: this list itself can still drift out of sync with
 * domainEntities.ts -- Rental (added later, see round 57's own changelog)
 * was never added here, so a rental-business description ("rent out tools
 * to customers") matched only Rental and got recommended "No payments",
 * even though renting items out for a fee is definitionally a paid
 * transaction. Added "Rental" below.
 *
 * Round 622: the exact same drift, for Property -- a real-estate
 * description ("track properties for sale and apartment listings") matches
 * only Property (whose own description/fields never hit PAYMENT_KEYWORDS)
 * and got recommended "No payments", even though selling or renting out
 * real estate is definitionally a paid transaction. Added "Property" below.
 *
 * Round 826: the exact same drift, for MenuItem -- a restaurant/cafe menu
 * dish, with a *required* price field. "a cafe menu app to track dishes
 * and prices" matched only MenuItem and got recommended "No payments",
 * even though a priced dish on a restaurant's menu is definitionally for
 * sale. Added "MenuItem" below.
 *
 * Service (same "business offers for sale" framing, and the same round-826
 * finding's original motivation) was deliberately NOT added here: unlike
 * Rental/Property/MenuItem's specifically-commercial trigger phrasing,
 * Service's own keyword list matches on the bare, generic word "service"/
 * "שירות" -- which shows up constantly in ordinary, non-commercial contexts
 * ("customer service", "the service was great", feedback/review app
 * copy). Adding it here broke an existing, unrelated test ("אפליקציה
 * לאיסוף משוב חיובי מלקוחות על השירות שלנו" -- a feedback-collection app
 * mentioning "our service" -- wrongly started recommending Stripe), proving
 * Service's entity match alone isn't a reliable "this app needs payments"
 * signal the way Rental/Property/MenuItem's narrower triggers are.
 *
 * Round 1345: the exact same drift, for WorkOrder -- a field-service/repair
 * description ("scheduling repair jobs and service calls for our plumbing
 * business") matches Service and WorkOrder, neither of which hits
 * PAYMENT_KEYWORDS, and got recommended "No payments" even though
 * WorkOrder's own description ("A scheduled repair or maintenance job
 * performed for a customer") is as definitionally a billable transaction as
 * Rental/Property/MenuItem already are -- a plumber/electrician/HVAC-tech
 * business bills the customer for the repair call. Unlike Service's own
 * bare-word ambiguity above, WorkOrder's keywords ("work order", "repair
 * job", "field service", "maintenance request") are specifically
 * commercial, the same narrow-trigger shape Rental/Property/MenuItem
 * already have. Added "WorkOrder" below.
 *
 * Round 1346: the exact same drift, for InsuranceClaim -- an insurance-
 * agency description ("insurance claims tracker... to manage policyholder
 * claims and payouts") matches only InsuranceClaim, which hits none of
 * PAYMENT_KEYWORDS, and got recommended "No payments" even though the
 * entity itself has a `claimAmount` field and a `status` enum whose values
 * include "Paid" -- a filed claim is a payout-bearing transaction, the
 * same shape as Rental/Property/MenuItem/WorkOrder. InsuranceClaim's own
 * keywords ("insurance claim", "policyholder", "claims processing") are
 * narrowly insurance-specific, not the bare-word ambiguity Service/Course
 * were excluded for. Added "InsuranceClaim" below.
 *
 * Appointment was explicitly considered for this same drift (rounds 1345
 * and 1346 both flagged it, deferring the decision) and deliberately NOT
 * added here: unlike Rental/Property/MenuItem/WorkOrder/InsuranceClaim's
 * narrowly-commercial triggers, Appointment matches on the bare, generic
 * word "appointment"/"booking"/"reservation", which shows up constantly in
 * genuinely non-commercial contexts (school parent-teacher conferences,
 * government/DMV bookings, free clinics, volunteer scheduling) -- the same
 * bare-word ambiguity Service was excluded for above. Confirmed live that
 * adding "Appointment" here would wrongly recommend Stripe for e.g. a
 * school's parent-teacher-conference scheduler. Round 1819 instead closed
 * the specific commercial-salon/spa/massage case via PAYMENT_KEYWORDS
 * phrases (see that array above), leaving this Set's Appointment omission
 * intentional.
 */
const BILLING_ENTITY_NAMES = new Set([
  "Invoice",
  "Order",
  "Donation",
  "Subscription",
  "Rental",
  "Property",
  "MenuItem",
  "WorkOrder",
  "InsuranceClaim",
]);

interface HebrewLabels {
  labelHe: string;
  descriptionHe: string;
  fieldLabelsHe: Record<string, string>;
  enumLabelsHe?: Record<string, Record<string, string>>;
}

function withLabels(entity: Entity, labels: HebrewLabels): Entity {
  return {
    ...entity,
    label: labels.labelHe,
    description: labels.descriptionHe,
    fields: entity.fields.map((f) => ({
      ...f,
      label: labels.fieldLabelsHe[f.name] ?? f.name,
      ...(f.type === "enum" && labels.enumLabelsHe?.[f.name] ? { enumLabels: labels.enumLabelsHe[f.name] } : {}),
    })),
  };
}

function matchesKeyword(lower: string, kw: string | RegExp): boolean {
  return typeof kw === "string" ? lower.includes(kw) : kw.test(lower);
}

export function matchEntities(text: string, isHebrew: boolean): Entity[] {
  const lower = text.toLowerCase();
  const matched: Entity[] = [];
  for (const rule of DOMAIN_ENTITY_RULES) {
    if (rule.keywords.some((kw) => matchesKeyword(lower, kw))) {
      matched.push(isHebrew ? withLabels(rule.entity, rule) : rule.entity);
    }
  }
  if (matched.length > 0) return matched;
  return [
    isHebrew
      ? withLabels(DEFAULT_ENTITY, {
          labelHe: DEFAULT_ENTITY_LABEL_HE,
          descriptionHe: DEFAULT_ENTITY_DESCRIPTION_HE,
          fieldLabelsHe: DEFAULT_ENTITY_FIELD_LABELS_HE,
          enumLabelsHe: DEFAULT_ENTITY_ENUM_LABELS_HE,
        })
      : DEFAULT_ENTITY,
  ];
}

/**
 * Admin is added unconditionally, whatever the description says: every
 * project has exactly one owner account (see the "single demo workspace"
 * assumption in buildAssumptions), and that owner is always an admin of
 * their own app, so there's no real description this should ever be
 * absent for. Member is added only as a generic second role when nothing
 * else was detected, so a description with no role language at all still
 * gets a role-based-access story worth mentioning rather than a
 * single-role spec that reads as an oversight.
 */
export function matchRoles(text: string, isHebrew: boolean): string[] {
  const lower = text.toLowerCase();
  const roles = new Set<string>();
  for (const [role, rule] of Object.entries(ROLE_RULES)) {
    if (rule.keywords.some((kw) => matchesKeyword(lower, kw))) {
      roles.add(isHebrew ? rule.labelHe : role);
    }
  }
  const adminLabel = isHebrew ? ROLE_RULES.Admin.labelHe : "Admin";
  const memberLabel = isHebrew ? "חבר/ת צוות" : "Member";
  roles.add(adminLabel);
  if (roles.size === 1) {
    roles.add(memberLabel);
  }
  return Array.from(roles);
}

function buildScreens(entities: Entity[]): Screen[] {
  // Every generated app gets a Dashboard: matchRoles always adds an
  // Admin/owner role (see its own comment), since every project has a
  // single owner even when the description never mentions roles at all --
  // there's no description for which a real "elevated role" gate would
  // ever come out false, so this used to carry a hasElevatedRole
  // parameter that always evaluated true and was removed as dead weight.
  const screens: Screen[] = [{ name: "Dashboard", type: "dashboard" }];
  for (const entity of entities) {
    screens.push({ name: `${entity.name} List`, type: "list", entity: entity.name });
    screens.push({ name: `${entity.name} Form`, type: "form", entity: entity.name });
  }
  return screens;
}

function buildOpenQuestions(text: string, entities: Entity[], isHebrew: boolean): OpenQuestion[] {
  const lower = text.toLowerCase();
  const mentionsPayments = PAYMENT_KEYWORDS.some((kw) => matchesKeyword(lower, kw));
  const hasBillingEntity = entities.some((e) => BILLING_ENTITY_NAMES.has(e.name));
  const needsPayments = mentionsPayments || hasBillingEntity;

  if (isHebrew) {
    return [
      {
        question: needsPayments ? "באיזה ספק תשלומים כדאי להשתמש?" : "האם האפליקציה צריכה לקבל תשלומים?",
        options: ["Stripe", "PayPal", "בלי תשלומים", "תחליטו בשבילי"],
        recommendation: needsPayments ? "Stripe" : "בלי תשלומים",
      },
    ];
  }
  return [
    {
      question: needsPayments ? "Which payment provider should this use?" : "Does this application need to accept payments?",
      options: ["Stripe", "PayPal", "No payments", "Decide for me"],
      recommendation: needsPayments ? "Stripe" : "No payments",
    },
  ];
}

function summarize(text: string, entities: Entity[], roles: string[], isHebrew: boolean): string {
  const entityNames = entities.map((e) => e.label ?? e.name).join(", ");
  if (isHebrew) {
    return `אפליקציה עסקית שמנהלת ${entityNames}, עם הרשאות גישה לפי תפקיד עבור: ${roles.join(", ")}.`;
  }
  return `A business application managing ${entityNames} with role-based access for ${roles.join(", ")}, generated from: "${text.trim()}"`;
}

function buildAssumptions(isHebrew: boolean): string[] {
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
 * Deterministic, offline product-spec generator. Matches recognizable
 * business nouns (customers, appointments, invoices, ...) against a small
 * domain library instead of calling a model — in English or Hebrew. This is
 * Forge AI's fallback provider — always available, zero configuration,
 * fully testable — used when no LLM credentials are configured. When the
 * input is Hebrew, entities/fields/roles/summary/questions all come back in
 * Hebrew too (via `label`), while the underlying `name`s stay fixed ASCII
 * identifiers used for the real SQL schema (see packages/db/identifiers.ts).
 */
export class HeuristicSpecProvider implements SpecProvider {
  readonly name = "heuristic";

  async generate(description: string, isHebrewOverride?: boolean): Promise<ProductSpec> {
    if (!description || description.trim().length === 0) {
      throw new Error("description must not be empty");
    }
    const isHebrew = isHebrewOverride ?? isHebrewText(description);
    const entities = matchEntities(description, isHebrew);
    const roles = matchRoles(description, isHebrew);
    const screens = buildScreens(entities);
    const openQuestions = buildOpenQuestions(description, entities, isHebrew);

    const spec: ProductSpec = {
      summary: summarize(description, entities, roles, isHebrew),
      personas: roles.map((r) => (isHebrew ? `משתמש/ת מסוג ${r}` : `${r} user`)),
      roles,
      entities,
      screens,
      assumptions: buildAssumptions(isHebrew),
      openQuestions,
    };

    return ProductSpecSchema.parse(spec);
  }
}
