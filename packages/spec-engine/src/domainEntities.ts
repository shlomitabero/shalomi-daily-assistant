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
 * Three keyword pitfalls to check for before adding a new one (all caught by
 * writing a real regression test, not by inspection):
 * 1. English substring collisions with a short/common word inside an
 *    unrelated word (e.g. "events" ⊂ "prevents"). Usually fixed by picking a
 *    different, collision-free keyword string (see "deal" vs. "deals"
 *    below) — but when EVERY spelling of the real word is itself a
 *    substring of the colliding word(s), as with "order" (contained inside
 *    "disorder(s)", "recorder(s)", "border(s)", no matter singular/plural),
 *    no plain string keyword can win: use a `RegExp` keyword instead (see
 *    Order's own entry below), matched with `\b` word boundaries so
 *    "orders" matches but "disorders" doesn't (a letter immediately before
 *    "order" blocks the boundary).
 * 1b. A DIFFERENT shape of collision a `\b`-bounded RegExp can't fix: two
 *    entities' keywords both legitimately matching because they co-occur as
 *    two separate, real, whole words inside one idiomatic phrase -- e.g.
 *    "pipeline" (Deal's own keyword, removed below after this exact
 *    collision was found in round 371) really is a genuine standalone word
 *    in "hiring pipeline", the single most idiomatic HR/ATS phrase for a
 *    recruitment funnel, so no amount of word-boundary-matching on
 *    "pipeline" itself changes anything. Word boundaries only ever help
 *    against a keyword being a SUBSTRING of a different word (pitfall 1);
 *    they do nothing when the keyword is already its own correct word, just
 *    inside a two-word phrase that means something else entirely. The only
 *    real fix is dropping the colliding keyword outright, once the rest of
 *    the entity's keyword list still covers the ordinary case well enough
 *    on its own (see JobApplicant's own "hiring" below, deliberately not
 *    "hiring pipeline").
 * 2. Hebrew construct-state (סמיכות) and other suffix inflection: a keyword
 *    like "תמיכה" does NOT match "תמיכת לקוחות" ("customer support") as a
 *    substring, since the word's ending changes. Prefixes (ה/ו/ב/כ/ל/מ)
 *    don't break matching (the root stays contiguous at the end), but a
 *    changed suffix does — list the inflected form as its own keyword too
 *    (e.g. both "תמיכה" and "תמיכת") rather than assuming one form covers
 *    all of them.
 */
export interface DomainEntityRule {
  /** A plain string matches as a substring (`lower.includes(kw)`); a RegExp is tested directly (`kw.test(lower)`) against the same lowercased text — see pitfall 1 above for when a RegExp is required. */
  keywords: (string | RegExp)[];
  entity: Entity;
  labelHe: string;
  descriptionHe: string;
  fieldLabelsHe: Record<string, string>;
  /** field name -> { raw enumValue -> Hebrew display text }. The stored value stays the raw enumValue. */
  enumLabelsHe?: Record<string, Record<string, string>>;
}

export const DOMAIN_ENTITY_RULES: DomainEntityRule[] = [
  {
    // Bare "lead" is deliberately left out -- it's a substring of "leaders"/
    // "leadership", a common phrase in descriptions about internal team
    // structure that has nothing to do with sales leads. "sales lead" is
    // the actual business term and doesn't have that problem.
    keywords: ["customer", "client", "sales lead", "לקוח", "לקוחה", "לקוחות", "קליינט"],
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
    //
    // "schedule" was removed (round 373) -- it's a real, correctly-spelled
    // standalone word, so a `\b`-bounded RegExp can't help here (the same
    // idiom-co-occurrence shape as Deal's removed "pipeline" keyword, not
    // a substring-within-a-word collision): "payment schedule"/"project
    // schedule"/"work schedule" are all ordinary business-management
    // phrases with nothing to do with booking a customer appointment, and
    // every one of them was spuriously matching this entity. Verified no
    // existing test relied on bare "schedule" before removing it;
    // "appointment"/"booking"/"reservation" already cover the ordinary
    // case well enough on their own.
    //
    // Bare "reservation" (round 501) is a substring of the unrelated,
    // ordinary word "preservation" (p-reservation), so any historic/data/
    // wildlife-preservation description spuriously matched this entity too
    // -- the same pitfall-1 shape as order/stock/driver/patient/deals/
    // worker/courses/dish/product. \b-bounded, with the same "(s)?" plural
    // handling those fixes already use, so "reservations" still matches.
    //
    // Bare "booking" (round 557) is a substring of the unrelated, ordinary
    // word "overbooking" (airline/hotel capacity management, nothing to do
    // with scheduling a customer appointment) -- the same pitfall-1 shape
    // as reservation/preservation above. \b-bounded with the same "(s)?"
    // plural handling, so "bookings" still matches.
    keywords: ["appointment", /\bbookings?\b/, /\breservations?\b/, "תורים", "פגישה", "פגישות"],
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
    // "worker" (round 446): a bare substring match on "coworker" -- a
    // common, everyday word with nothing to do with HR/staff management
    // (e.g. "split expenses with my coworker") -- spuriously fabricated an
    // Employee entity for purely personal app descriptions. `\b`-bounded
    // here, same fix already applied to order/stock/driver/patient/deals
    // above for the identical collision shape.
    // "staff" (round 574): the same bare-substring shape, this time a
    // match on "Staffordshire" (the dog breed) -- a dog-breeding app
    // description had nothing to do with HR/staff management either.
    // `\b`-bounded the same way "worker" already is, right above.
    keywords: [
      "employee", /\bstaff\b/, "team member", /\bworkers?\b/,
      // Bare "עובד"/"עובדת"/"עובדים" (round 565) are substrings of the
      // pu'al passive-participle adjective "מעובד"/"מעובדת"/"מעובדים"/
      // "מעובדות" ("processed", as in processed food/data/materials), an
      // extremely common Hebrew word with nothing to do with staff. Hebrew
      // has no \b (same reason round 518's "מלאי" and round 564's "מוצר"
      // fixes needed lookbehind too); this excludes the specific "מ" pu'al
      // prefix while still matching every real "עובד"-based phrasing.
      /(?<!מ)עובד/, /(?<!מ)עובדת/, /(?<!מ)עובדים/,
      // Bare "צוות" (round 825) is a substring of "מצוות" ("commandments"/
      // "mitzvot" -- a religious-observance tracker or bar/bat-mitzvah
      // planning app description), the same "מ + root" collision shape
      // "עובד" just above was fixed for.
      /(?<!מ)צוות/,
    ],
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
    // Bare "חיוב" is a substring of the unrelated adjective/noun
    // "חיובי"/"חיובית"/"חיוביות" ("positive"/"positivity") -- see the
    // identical fix and its rationale in heuristic.ts's PAYMENT_KEYWORDS.
    // "חיובים" is still matched explicitly as its own keyword below.
    keywords: ["invoice", "billing", "payment", "חשבונית", "חשבוניות", /חיוב(?!י(?!ם))/, "חיובים"],
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
      // Bare "order"/"orders" as a plain substring would also match
      // "disorder(s)", "recorder(s)", "border(s)" -- real words in real
      // descriptions (e.g. a clinic tracking "sleep disorders", a rental
      // business tracking "video recorders"). Unlike the "deal"/"deals" fix
      // above, no alternate spelling avoids this: every one of those
      // colliding words itself ends in "order(s)". A `\b`-bounded regex is
      // the only fix -- it requires a non-letter immediately before "order",
      // which rejects all three colliding words (each has a letter right
      // before "order") while still matching "order"/"orders" as a real
      // standalone word, including inside a hyphenated phrase like
      // "order-management".
      // Bare "checkout" (round 550) is a whole word that's genuinely
      // ambiguous: it means an e-commerce purchase in most descriptions, but
      // "checkout" is equally the ordinary word for a library's book
      // checkout/return process or a hotel's checkout time -- neither has
      // anything to do with orders or payments. Unlike the substring pitfall
      // "order" itself needed \b for, \b alone can't fix this since
      // "checkout" word-boundary-matches correctly in "book checkout" too --
      // requiring one of the specific e-commerce phrases below (the same
      // style this file's "garage sale" disambiguation already uses) keeps
      // matching a real online-store description without matching a
      // library/hotel one that happens to use the bare word.
      /\border(s)?\b/, "purchase", "checkout page", "checkout flow", "online checkout",
      "delivery", "deliveries", "wolt",
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
    // Bare "treatment" (round 452) is a substring of "mistreatment", and
    // bare "service" (round 453) is a substring of "disservice" -- both
    // ordinary words unrelated to selling a service, so they spuriously
    // matched this entity. \b-bounded, same pitfall-1 shape as the other
    // eleven collision fixes already in this file.
    keywords: [/\bservice(s)?\b/, /\btreatment(s)?\b/, "שירות", "שירותים", "טיפול", "טיפולים"],
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
    keywords: [
      // Bare "stock" is a substring of "livestock" (a farm-management
      // description has nothing to do with retail inventory) -- same
      // collision class as Order's "order" fix above. \b-bounded so
      // "stock"/"stocks" still matches as a real standalone word. Bare
      // "product" (round 449) has the identical problem: it's a substring
      // of "production" ("a video production studio"), an ordinary word
      // with nothing to do with selling or tracking products.
      /\bproduct(s)?\b/, "inventory", /\bstock(s)?\b/,
      // Bare "מוצר" (round 564) is a substring of "מוצרט" ("Mozart"
      // transliterated into Hebrew), so a concert/music-school description
      // mentioning Mozart spuriously matched Product. Hebrew has no \b
      // (same reason round 518's "מלאי", round 562's "כנס", and round
      // 563's "מנוי" fixes needed lookahead/lookbehind too); this excludes
      // the specific "ט" that marks "Mozart" while still matching
      // "מוצר"/"מוצרים".
      /מוצר(?!ט)/, "מוצרים",
      // Bare "מלאי" ("inventory/stock") is a substring of two unrelated,
      // ordinary Hebrew words (round 518): WorkOrder's own "חשמלאי"/
      // "חשמלאים" ("electrician(s)") and the common adjective "מלאים"
      // ("full", plural) -- e.g. "ארונות מלאים" ("full cabinets") has
      // nothing to do with retail inventory. JS regex's `\b` only
      // recognizes ASCII word characters, so it can't bound a Hebrew
      // word the way it bounds "stock"/"product" above; a lookbehind for
      // the "חש" prefix plus a lookahead against the "ם" plural suffix
      // excludes exactly these two collisions while "מלאי" still matches
      // as its own word (e.g. "ניהול מלאי", "המלאי", "במלאי").
      /(?<!חש)מלאי(?!ם)/,
    ],
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
    // Bare "deal" is deliberately left out -- it's a substring of "ideal"
    // (an ordinary word in phrases like "ideal customer"/"ideal workflow")
    // and of "dealership" (Vehicle's own "car dealership" keyword), so a
    // plain car-dealership CRM description would spuriously also match
    // here.
    //
    // "pipeline" was removed (it used to be listed here) -- unlike "deal"
    // above, this isn't a substring collision a `\b`-bounded RegExp could
    // fix: "pipeline" is a genuine standalone word in "hiring pipeline",
    // the single most idiomatic HR/ATS phrase for a recruitment funnel
    // (and the exact phrase pitfall 1's own comment above uses as its
    // example), so any word-boundary-respecting match for "pipeline"
    // still fires on it. "deals"/"negotiation" already cover the ordinary
    // English phrasing for this entity well enough on their own.
    //
    // Plural "deals" (round 372): the author checked the singular pair
    // (deal/ideal) above but missed that "deals" has the exact same
    // problem one letter over -- it's a substring of "ideals" ("company
    // values and ideals"), so a plain non-sales description mentioning a
    // business's ideals spuriously matched Deal too. `\b`-bounded here
    // (unlike "pipeline" above) because this really is the
    // substring-within-a-word shape pitfall 1 describes, not the
    // idiom-co-occurrence shape pitfall 1b describes -- confirmed with a
    // real repro before fixing, per round 371's own lesson not to assume a
    // RegExp fix transfers between the two shapes.
    keywords: [/\bdeals\b/, "negotiation", "עסקה", "עסקאות", "משא ומתן"],
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
    // Bare "מנה" (mem-nun-heh, "portion/dish") is deliberately left out --
    // it's the exact 3-letter prefix of "מנהל"/"מנהלת"/"מנהלים" (manager/
    // manageress/managers, one of the most common words in Hebrew business
    // descriptions and this same file's own ROLE_RULES keyword for Admin).
    // Plural "מנות" (mem-nun-vav-tav) doesn't have this problem -- Hebrew
    // plural formation drops the ה and adds ות, so it never contains the
    // מנהל root as a substring.
    // Bare "dish" (round 448) is a substring of "dishonest" -- an ordinary
    // word in a consumer-protection/trust description ("track dishonest
    // sellers") that has nothing to do with restaurants, so it spuriously
    // matched this entity. `\b`-bounded here, same pitfall-1 shape as the
    // other seven fixes in this file (order/stock/driver/patient/deals/
    // worker/courses). "מנות" (round 660) dodges the "מנהל" collision noted
    // above, but is itself a substring of this very file's own Order
    // rule's "הזמנות" keyword a few entries up -- a description naming
    // only orders ("ניהול הזמנות") spuriously matched this entity too,
    // fabricating a restaurant menu for e.g. a clothing store's order
    // tracker. The negative lookbehind excludes only that specific root.
    keywords: [
      "menu", /\bdish(es)?\b/, "food item", "restaurant", "cafe", "מסעדה", "מסעדות",
      "תפריט", /(?<!ז)מנות/, "בית קפה",
      // "בית קפה" (café) had no plural entry (round 582). Unlike this
      // file's other missing-plural fixes (576-581, all a ה→ות swap or a
      // sofit-letter swap), "בית" (house) forms its plural with the
      // irregular construct form "בתי" (houses of) -- a letter-order
      // change (ב-י-ת -> ב-ת-י), not a suffix. "בתי קפה" (cafés) is not a
      // substring superset of "בית קפה" either way, so a plural-only
      // phrasing matched no domain entity at all.
      "בתי קפה",
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
    keywords: [
      // Bare "driver" is a substring of "screwdriver(s)" (a hardware-store
      // description) and "webdriver" (a QA/testing-tool description) --
      // same collision class as Order's "order" fix above. \b-bounded so
      // "driver"/"drivers" still matches as a real standalone word.
      // Round 813: bare "שליח" ("courier"/"messenger") is a literal
      // 4-letter prefix of the construct-state "שליחת" ("sending of ___",
      // e.g. "שליחת הודעות"/"שליחת חוזים"/"שליחת ניוזלטרים" -- ordinary,
      // frequent phrasing with nothing to do with delivery drivers) and
      // the unrelated noun "שליחות"/"שליחויות" ("errand(s)"). Excluded via
      // lookahead the same way as this file's other short-root prefix
      // collisions, narrowly scoped to just the ת/ו continuations that are
      // never a real courier reference -- deliberately not excluding the
      // ה-suffixed "שליחה" (which can legitimately mean "female courier"),
      // the same genuinely-ambiguous-word judgment call this file already
      // makes elsewhere rather than guessing at a dual-meaning word.
      "courier", /\bdriver(s)?\b/, "delivery person", /שליח(?![תו])/, "שליחים", "נהג", "נהגים",
      // "delivery person" had no plural entry (round 584). Unlike this
      // file's other missing-plural fixes (576-583, all Hebrew ה→ות or
      // sofit-letter swaps, or an irregular Hebrew construct plural),
      // this one is English: "person" has the irregular plural "people",
      // a wholly different word with zero textual overlap with
      // "person", so "delivery person" is not a substring of "delivery
      // people" either way. A description using only the plural
      // phrasing matched no Courier-specific keyword at all.
      "delivery people",
    ],
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
      // Bare "listing" (round 457) is a substring of "enlisting" -- an
      // ordinary word in a nonprofit/volunteer-outreach description that
      // has nothing to do with real estate, so it spuriously matched
      // this entity. \b-bounded, same pitfall-1 shape as the fourteen
      // other collision fixes already in this file.
      //
      // Bare "property" (round 558) is a whole, correctly-spelled word
      // that's genuinely ambiguous: it means a real-estate asset in most
      // descriptions, but "intellectual property" (patents/trademarks),
      // "lost property" (a lost-and-found service), and "property damage"
      // (an insurance/incident-tracking app) are all ordinary idioms with
      // nothing to do with real estate. \b alone can't fix this (it's a
      // whole word, not a substring) -- lookbehind/lookahead excludes only
      // those specific phrases, the same disambiguation style "garage"
      // (round 454) and "checkout" (round 550) already use.
      /\b(?<!intellectual\s)(?<!lost[\s-])propert(?:y|ies)\b(?!\s+damage\b)/,
      "real estate", /\blisting(s)?\b/, "apartment for rent", "נכס", "נכסים",
      "נדל\"ן", "דירה למכירה", "דירה להשכרה",
      // "דירה למכירה"/"דירה להשכרה" (apartment for sale/rent) had no plural
      // entries (round 580). Their plurals "דירות למכירה"/"דירות להשכרה"
      // swap the word-final ה for ות mid-word, the same construct-state gap
      // shape rounds 576-579 already found for "עמותה"/"עמותות",
      // "עורכת דין"/"עורכות דין", and "פוליסת ביטוח"/"פוליסות ביטוח". A
      // plural-only phrasing matched no domain entity at all.
      "דירות למכירה", "דירות להשכרה",
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
    // Bare "pupil" (round 561) is a whole-word genuine polysemy collision,
    // the same shape as "garage"/"garage sale" (454) and
    // "property"/"intellectual property" (558), not a substring issue --
    // "pupil" is also the ophthalmology/optometry term for part of the eye,
    // so an eye-care description mentioning pupil size/dilation/reaction
    // has nothing to do with a school. Excludes only those specific known
    // eye-anatomy idioms via lookbehind/lookahead, same style as garage.
    keywords: [
      "student",
      /\b(?<!dilated\s)pupils?\b(?!\s+(?:dilation|size|reaction|response))/,
      "learner",
      "תלמיד",
      "תלמידה",
      "תלמידים",
      "סטודנט",
      "סטודנטית",
    ],
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
    // Bare "courses" (round 447) is a substring of "discourses" -- an
    // ordinary word in a plain discussion/forum description ("hosting
    // public discourses and debates") that has nothing to do with
    // education, so it spuriously matched this entity. `\b`-bounded here,
    // same pitfall-1 shape as the other six fixes in this file. Deliberately
    // not adding a singular "course" keyword alongside it: "course" alone
    // would collide with "of course" and "golf course", both far more
    // common than any real education-app phrasing that needs it.
    keywords: [
      /\bcourses\b/, "curriculum", "lesson", "lessons", "קורס", "קורסים", "שיעור", "שיעורים", "כיתה",
      // "כיתה" (classroom/class) had no plural entry (round 583). Its
      // plural "כיתות" swaps the word-final ה for ות mid-word, the same
      // construct-state gap shape rounds 576-582 already found elsewhere
      // in this file. A plural-only phrasing matched no Course-specific
      // keyword at all.
      "כיתות",
    ],
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
    // Bare "patient" (round 372) is a substring of "impatient" -- an
    // ordinary word in a plain customer-support description ("handle
    // impatient customers politely") that has nothing to do with medical
    // care, so it spuriously matched this entity. `\b`-bounded, same
    // pitfall-1 shape as Order's "order"/Product's "stock" above (not the
    // idiom-co-occurrence shape Deal's removed "pipeline" keyword was).
    // "outpatient" is listed explicitly alongside the regex because it
    // would otherwise stop matching too: there's no word boundary between
    // "out" and "patient" in "outpatient" (both are word characters), so
    // `\bpatient\b` alone can't see it, even though it's a real,
    // legitimate healthcare term this entity should still catch.
    keywords: [/\bpatient(s)?\b/, "outpatient", "clinic patient", "מטופל", "מטופלת", "מטופלים"],
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
    keywords: [
      // Bare "project" (round 456) is a substring of "projector" -- an
      // ordinary word in an AV-equipment rental description that has
      // nothing to do with managing client work, so it spuriously matched
      // this entity. \b-bounded, same pitfall-1 shape as the thirteen
      // other collision fixes already in this file.
      /\bproject(s)?\b/,
      "פרויקט", "פרויקטים",
    ],
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
    // Bare "task" (round 557) is a substring of the unrelated, ordinary
    // word "multitasking" (a personal-productivity/time-management skill,
    // nothing to do with a tracked to-do item) -- the same pitfall-1 shape
    // as reservation/preservation and booking/overbooking above. \b-bounded
    // with the same "(s)?" plural handling those fixes already use, so
    // "tasks" still matches.
    keywords: [/\btasks?\b/, "todo", "to-do", "action item", "משימה", "משימות"],
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
      // Bare "mechanic" (round 450) is a substring of "mechanical" -- an
      // ordinary word in e.g. a facilities-management description
      // ("mechanical issues in a building") that has nothing to do with
      // vehicles, so it spuriously matched this entity. \b-bounded, same
      // pitfall-1 shape as order/stock/driver/patient/deals/worker/courses/
      // dish/product.
      "vehicle", "vehicles", "fleet management",
      // Bare "garage" (round 454) is a whole word that's genuinely
      // ambiguous: it means an auto-repair shop in most descriptions, but
      // "garage sale" is an unrelated everyday phrase (a household selling
      // unwanted items) with nothing to do with vehicles. Unlike the
      // substring-in-a-longer-word pitfall above, \b alone can't fix this
      // since "garage" word-boundary-matches correctly in "garage sale"
      // too -- the negative lookahead excludes only that specific phrase.
      // Round 812: the fix never added plural support -- unlike every
      // sibling keyword in this file (the very next one, mechanic(s)?,
      // plus driver(s)?/worker(s)?/service(s)?/product(s)? etc. below),
      // which all explicitly handle their natural plural right next to
      // the \b bound. \b can't match inside "garages" at all (no boundary
      // between "garage" and the trailing "s"), so a description naming
      // only "garages" (plural, no "garage sale(s)" to worry about either)
      // fell through to the generic DEFAULT_ENTITY instead of Vehicle.
      /\bgarages?\b(?!\s+sales?\b)/, /\bmechanic(s)?\b/, "car dealership",
      // Bare "רכב" (round 567) is a literal prefix-substring of "רכבת"
      // ("train") and its plural "רכבות" ("trains") -- extremely common
      // everyday words (Israel Railways is "רכבת ישראל"), with nothing to
      // do with cars, so a train/station-management description spuriously
      // matched this entity. Same unbounded-Hebrew-substring shape as every
      // other fix in this file (round 518 מלאי, round 563 מנוי, round 564
      // מוצר, round 565 עובד, etc.). The negative lookahead excludes "רכב"
      // immediately followed by an optional "ו" then "ת" (covering both
      // "רכבת" and "רכבות"), while still matching real usage like "רכב",
      // "רכבים" (vehicles, plural), "ברכב", and "כלי רכב".
      /רכב(?!ו?ת)/,
      // Bare "מוסך" (garage, round 577) had no plural entry. Its plural
      // "מוסכים" swaps the word-final sofit-kaf ("ך") for a regular kaf
      // ("כ") -- a different Unicode character -- so "מוסך" is not a
      // substring of "מוסכים" the way most of this file's Hebrew nouns
      // are of their own plurals. A description using only the plural
      // ("רשת מוסכים") matched no domain entity at all.
      "מוסך", "מוסכים", "מכונאי", "כלי רכב",
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
      "אירוע", "אירועים",
      // Bare "כנס" (round 562) is a substring of common כ.נ.ס
      // ("to enter"/"to log in") verb conjugations -- "להיכנס" (to log
      // in), "נכנס" (enters/logs in), "תיכנס"/"מתכנס"/"התכנסות" -- so a
      // plain login-flow description spuriously matched Event. Hebrew
      // has no \b (same reason round 518's "מלאי" and round 527's "חיוב"
      // fixes needed lookbehind/lookahead too), so this excludes the
      // specific known verb-conjugation prefixes directly.
      /(?<!נ)(?<!תי)(?<!להי)(?<!מת)(?<!הת)כנס/,
      // Bare "חתונה"/"חתונות" (round 575) are substrings of "תחתונה"/
      // "תחתונות" ("lower [clothing]"/"underwear", e.g. "הלבשה תחתונה"),
      // an unrelated, common clothing/lingerie term -- "תחתונה" is
      // literally "ת" + "חתונה" letter-for-letter. Hebrew has no \b, so a
      // plain underwear-store description spuriously matched Event. This
      // excludes the specific "ת" prefix directly, same approach as the
      // "כנס" fix just above.
      /(?<!ת)חתונה/, /(?<!ת)חתונות/,
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
      // "השכרת ציוד"/"השכרת רכב" (construct-state singulars) had no plural
      // entry (round 585). Their plurals "השכרות ציוד"/"השכרות רכב" swap the
      // word-final ת for ות mid-word, the same construct-state gap shape
      // rounds 576-584 already found elsewhere in this file. A plural-only
      // phrasing matched no Rental-specific keyword at all.
      "השכרות ציוד", "השכרות רכב",
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
      // Bare "מנוי" (round 563) is a substring of the ordinary plural
      // "אומנויות"/"אמנויות" ("arts"/"crafts", as in "אומנויות לחימה" --
      // martial arts), so a plain arts/crafts-school description spuriously
      // matched Subscription. Hebrew has no \b (same reason round 518's
      // "מלאי" and round 562's "כנס" fixes needed lookahead/lookbehind
      // too); this excludes the specific "ות" plural suffix that marks the
      // unrelated "arts" word while still matching "מנוי"/"מנויים".
      /מנוי(?!ות)/, "חברות מועדון", "דמי חבר",
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
    //
    // Bare "donation"/"donations" (round 548) is a substring of the
    // unrelated, ordinary word "condonation" (as in "condonation of delay",
    // a standard legal/compliance phrase for excusing a missed deadline),
    // so a law-firm/compliance description using that word spuriously
    // matched this entity too -- the same pitfall-1 shape as
    // reservation/shipping/order/stock/driver/patient/deals/worker/courses/
    // dish/product. \b-bounded, with the same "(s)?" plural handling those
    // fixes already use, so "donations" still matches.
    //
    // "עמותה" had no plural entry (round 576): unlike most of this file's
    // Hebrew nouns, the plural "עמותות" replaces the final ה with ות rather
    // than appending a suffix, so it is not a substring of "עמותה" the way
    // "תרומה"/"תרומות" already are -- a description using only the plural
    // matched no domain entity at all.
    keywords: [
      /\bdonations?\b/, "donor", "nonprofit", "fundraising campaign",
      "תרומה", "תרומות", "עמותה", "עמותות",
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
      // Bare "shipping" (round 455) is a substring of "worshipping" -- an
      // ordinary word in a church/congregation attendance description
      // that has nothing to do with logistics, so it spuriously matched
      // this entity. \b-bounded, same pitfall-1 shape as the twelve other
      // collision fixes already in this file.
      /\bshipping\b/, "logistics", "warehouse management", "package tracking", "freight",
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
    // Bare "תביעה" (round 572) is the ordinary, generic Hebrew word for
    // "claim"/"lawsuit" -- used constantly in general legal contexts
    // ("הגשת תביעה", "תביעה אזרחית") with zero connection to insurance, so
    // any law-firm/legal-case description spuriously matched this entity.
    // Unlike this file's substring-within-a-word fixes (רכב/מלאי/etc.),
    // this is whole-word polysemy (same shape as "property"/"garage"),
    // but there's an even simpler fix here: "תביעת ביטוח"/"תביעות ביטוח"
    // already cover every genuine insurance phrasing on their own, so the
    // redundant bare word is just removed rather than regex-guarded.
    keywords: [
      "insurance claim", "insurance claims", "claims processing", "policy holder", "policyholder",
      "תביעת ביטוח", "תביעות ביטוח",
      // "פוליסת ביטוח" (insurance policy) had no plural entry (round 579).
      // It's the construct-state singular of "פוליסה"; the plural
      // construct "פוליסות ביטוח" replaces the ה with ות mid-word, so
      // "פוליסת" is not a substring of "פוליסות" -- the same ה→ות gap
      // shape round 576 found for "עמותה"/"עמותות".
      "פוליסת ביטוח", "פוליסות ביטוח",
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
    // mirror image of Customer (who it sells TO). "supplier"/"vendor"
    // don't collide with any short English keyword. But bare "ספק" is a
    // true Hebrew homograph, not just an unbounded substring (round 571):
    // it's also the ordinary word for "doubt", used in extremely common
    // filler idioms like "ללא ספק"/"אין ספק"/"בלי ספק" (undoubtedly/no
    // doubt) and "מוטל בספק" (in doubt) -- none about purchasing at all.
    // JS has no \b for Hebrew (same reason round 518's "מלאי", round
    // 562's "כנס", round 563's "מנוי", round 564's "מוצר", round 565's
    // "עובד", and round 567's "רכב" needed lookahead/lookbehind), so this
    // excludes "ספק" immediately preceded by those specific idiom words
    // and excludes the "ות" plural suffix that marks "ספקות" (doubts),
    // while still matching real usage like "ספק"/"ספקים".
    keywords: [
      "vendor", "vendors", "supplier", "suppliers", "procurement",
      /(?<!ללא )(?<!אין )(?<!בלי )(?<!מוטל ב)ספק(?!ות)/, "ספקים", "רכש",
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
      // "עבודת תחזוקה" (maintenance job) had no plural entry (round 581).
      // Its plural "עבודות תחזוקה" swaps the word-final ה for ות mid-word,
      // the same construct-state gap shape rounds 576-580 already found
      // for "עמותה", "פוליסת ביטוח", and "דירה למכירה"/"דירה להשכרה". A
      // plural-only phrasing matched no WorkOrder-specific keyword at all.
      "עבודות תחזוקה",
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
      "תיק משפטי", "תיקים משפטיים",
      // "עורך דין"/"עורכת דין" (attorney) had no plural entries (round 578).
      // "עורך" ends in the word-final sofit-kaf ("ך"); its plural "עורכי"
      // swaps it for a regular kaf ("כ") -- a different Unicode character,
      // the same shape round 577 found for "מוסך"/"מוסכים". "עורכת"'s
      // plural "עורכות" has the analogous ת→ות gap round 576 found for
      // "עמותה"/"עמותות". Either plural-only phrasing ("עורכי דין"/
      // "עורכות דין") matched no domain entity at all.
      "עורך דין", "עורכי דין", "עורכת דין", "עורכות דין",
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
  keywords: (string | RegExp)[];
  labelHe: string;
}

export const ROLE_RULES: Record<string, RoleRule> = {
  Admin: { keywords: ["admin", "administrator", "owner", "מנהל מערכת", "אדמין", "בעלים"], labelHe: "מנהל/ת ראשי/ת" },
  // Bare "management" (round 559) is the same bare-substring collision as
  // Employee's "worker" below -- it's a substring of the unrelated,
  // ordinary word "mismanagement", so a compliance/nonprofit description
  // mentioning financial mismanagement spuriously fabricated a Manager
  // role. \b-bounded here too. Bare "מנהל" (round 659) is itself a
  // substring of Admin's own "מנהל מערכת" phrase just above -- a
  // description naming only a system admin ("מנהל מערכת") spuriously
  // matched Manager too, which (since matchRoles only adds the Member
  // fallback when exactly one role matched) silently suppressed Member
  // and fabricated a Manager role/persona/screens the description never
  // asked for. The negative lookahead excludes only that specific phrase.
  // Round 811: the round-659 lookahead above only excluded "מנהל" directly
  // followed by "מערכת" -- but "מנהלת מערכת" ("female system admin") also
  // contains the bare substring "מנהל" (as מנהלת's own first four letters),
  // immediately followed by "ת", not "מערכת" -- so the lookahead (?!\s*מערכת)
  // doesn't fire for it, and the old bare "מנהלת" keyword below matched it
  // too. Both were the identical substring-collision bug round 659 fixed
  // for the masculine phrase, just never carried through to the feminine
  // one -- this file's own comment a few lines below (describing the
  // "מנהל"/"מנהלת"/"מנהלים" word family) already treats them as
  // interchangeable. One merged lookahead -- (?!ת?\s*מערכת), the ת
  // optional -- excludes both "מנהל מערכת" and "מנהלת מערכת" while still
  // matching a standalone "מנהל"/"מנהלת" (e.g. "מנהל/ת חנות", a store
  // manager) that isn't naming a system admin.
  // Round 814: a third inflection of the same word family -- the Hebrew
  // construct-state plural "מנהלי מערכת" ("system administrators"), the
  // standard phrasing for naming the role/permission group rather than one
  // person (e.g. "רק מנהלי מערכת יכולים לגשת לדוחות"). After "מנהל" the
  // next letter is "י" (not "ת" or whitespace), so neither the round-659
  // nor round-811 lookahead fires for it. Admin's own "מנהל מערכת" keyword
  // doesn't match the plural either (the extra "י" breaks the contiguous
  // substring), but that's harmless -- matchRoles adds Admin unconditionally
  // regardless of its own keyword match (see its own doc comment in
  // heuristic.ts) -- only Manager's spurious match needed fixing. The "י"
  // made optional alongside the existing "ת", matching all three
  // inflections while still matching a real standalone "מנהל"/"מנהלת"/
  // "מנהלי" (e.g. "מנהלי חנות", real store managers, plural).
  Manager: { keywords: ["manager", /\bmanagement\b/, /מנהל(?!י?ת?\s*מערכת)/, "ניהול"], labelHe: "מנהל/ת" },
  // Same bare-substring collision as the Employee entity rule above
  // ("coworker" contains "worker") -- \b-bounded here too. Also same
  // pu'al "מעובד" collision (round 565) as the Employee entity rule's own
  // Hebrew keywords -- lookbehind-bounded here too. Also same "staff"/
  // "Staffordshire" collision (round 574) as the Employee entity rule's
  // own fix above -- \b-bounded here too. Also same bare "צוות"/"מצוות"
  // collision (round 825) as the Employee entity rule's own fix above --
  // lookbehind-bounded here too.
  Employee: {
    keywords: [
      "employee", /\bstaff\b/, /\bworkers?\b/, "team member",
      /(?<!מ)עובד/, /(?<!מ)עובדת/, /(?<!מ)עובדים/, /(?<!מ)צוות/,
    ],
    labelHe: "עובד/ת",
  },
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
