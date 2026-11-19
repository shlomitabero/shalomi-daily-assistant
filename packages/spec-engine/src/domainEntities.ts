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
    //
    // Round 889: bare "client"/"קליינט" are both correctly-spelled whole
    // words with a completely unrelated SECOND meaning -- the ordinary
    // software sense (a client-server/network client), the same
    // grammatical-polysemy shape round 888 fixed for Patient's "patient",
    // but reachable even more often here since this spec-engine is itself
    // routinely used to describe developer tools and technical products
    // ("an email client", "a REST API client library", "client-side
    // errors", "database client connections", "a mobile client app") --
    // none of those describe a business-to-customer relationship, yet
    // every one of them spuriously fabricated a full CRM Customer entity
    // (confirmed empirically with the real matchEntities before fixing).
    // `\b` alone can't help (both senses are the identical whole word);
    // narrowed to exclude only the specific technical collocations the
    // software sense actually appears in -- a known tech-noun immediately
    // before ("email"/"mail"/"api"/"database"/"db"/"web"/"mobile"/
    // "desktop"/"git"/"ssh"/"ftp"/"rest"/"graphql"/"http"/"thick"/"thin"),
    // or a known technical suffix immediately after ("-side"/"library"/
    // "app"/"connection(s)"/"server"/"sdk") -- neither touches an ordinary
    // business usage ("our clients", "client intake", "client meetings",
    // "client payments"). קליינט gets the mirrored Hebrew exclusions for
    // the same handful of common technical phrasings ("קליינט אימייל",
    // "קליינט API", "צד קליינט" [client-side], "קליינט-שרת"
    // [client-server]); real business usage ("קליינטים", "ניהול
    // הקליינטים") is unaffected.
    keywords: [
      "customer", "sales lead",
      /(?<!\b(?:email|mail|api|database|db|web|mobile|desktop|git|ssh|ftp|rest|graphql|http|thick|thin)[\s-])\bclient(s)?\b(?![\s-](?:side|library|libraries|app|apps|connection|connections|server|sdk))/i,
      // Round 2338: bare "לקוח"/"לקוחה" were listed completely unguarded
      // -- unlike the ENGLISH "client" a few lines above (and קליינט just
      // below), neither had any collision guard at all. "לקוח"/"לקוחה" is
      // not only the noun "customer": it's also the ordinary Pa'al
      // passive-participle adjective of the root ל-ק-ח ("to take"),
      // meaning "derived/taken from" -- e.g. "הציטוט לקוח מתוך הספר" (the
      // quote is taken from the book). Confirmed live: "הציטוט הזה לקוח
      // מתוך הספר הקדוש..." (this quote is taken from the holy book),
      // "הקטע לקוח מתוך נאום היסטורי..." (the passage is taken from a
      // historic speech), and a realistic quotes-app description ("כל
      // ציטוט לקוח מתוך ספר מסוים...") each fabricated a bogus Customer
      // entity for a plain content/quotes app with zero CRM content.
      //
      // Hebrew has no \b, so this excludes the specific "excerpt/content/
      // name"-type cue nouns (bare or ה-prefixed) that precede the
      // adjective in this idiom, allowing up to 3 intervening words (same
      // bounded-window convention as this file's other leaky-denylist
      // guards, e.g. round 2337's הזדמנות guard) -- confirmed empirically
      // against every existing "לקוח"/"לקוחה" fixture in heuristic.test.ts
      // (none has a cue noun within the window) that this doesn't
      // regress any genuine-customer test. The plural "לקוחות" is left
      // unguarded, same as before: its adjective-plural counterpart would
      // be "לקוחים", a distinct word, so "לקוחות" has no equivalent
      // collision. Deliberately a leaky denylist, not an exhaustive fix,
      // same class as round 2334's צדקה guard: a cue noun outside this
      // list (e.g. "כתבה"/article, "פתגם"/proverb) or more than 3 words
      // before the target still isn't excluded.
      /(?<!(?:^|[\s.,!?])(?:ה)?(?:ציטוט|ציטוטים|קטע|קטעים|מידע|שם|שמות|מילה|מילים|סיפור|סיפורים|תוכן|נתון|נתונים|תרגום|רעיון|כתובה|משפט|משפטים|פסוק|פסוקים|תיאור|קביעה)(?:\s+\S+){0,3}\s)לקוח(?!ה|ות)/,
      /(?<!(?:^|[\s.,!?])(?:ה)?(?:ציטוט|ציטוטים|קטע|קטעים|מידע|שם|שמות|מילה|מילים|סיפור|סיפורים|תוכן|נתון|נתונים|תרגום|רעיון|כתובה|משפט|משפטים|פסוק|פסוקים|תיאור|קביעה)(?:\s+\S+){0,3}\s)לקוחה/,
      "לקוחות",
      /(?<!צד\s)קליינט(ים)?(?!\s*(?:ה)?(?:אימייל|מייל|api|דאטהבייס|מובייל|שרת)|-שרת)/,
    ],
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
    //
    // Round 1799: a hair salon, barbershop, or nail salon business (an
    // extremely common small-business category in both languages) had no
    // keyword anywhere matching it, so it fell through to matchEntities'
    // degenerate generic "Item" fallback -- the same failure class rounds
    // 1700/1708/1720/1722/1727/1752/1769 already closed for other
    // verticals -- unless the description happened to also literally say
    // "appointment"/"booking"/"reservation". This entity's own field shape
    // (customerName/date/service/status/notes) already fits a salon or
    // barbershop booking exactly, so widening its own keywords (rather
    // than inventing a new entity) matches this file's established
    // convention. Bare "salon" is deliberately excluded -- it's ambiguous
    // with a furniture/auto showroom "salon" and a person's surname -- so
    // only the scoped phrases below are listed, the same style as this
    // file's other phrase-collision fixes (e.g. "nursery school" above).
    //
    // Round 1800: a spa or massage business (a different vertical than
    // round 1799's salon/barber fix, but the same degenerate-fallback
    // failure class) had no keyword anywhere matching it either --
    // "a spa offering massages"/"a massage therapy clinic" still fell
    // through to the generic "Item" fallback. Bare "spa" is bounded with
    // `\b` rather than listed as a plain string -- unlike "salon", it has
    // no ambiguous OTHER meaning, but IS a substring of ordinary, unrelated
    // words ("workspace", "space", "spacious"), so a plain `.includes()`
    // match would have spuriously matched any shared-workspace or
    // office-space business too. Confirmed via direct `matchEntities`
    // invocation: "a shared workspace for freelancers" must NOT match.
    //
    // Round 1983: the Hebrew counterpart "ספא" was left as a bare,
    // unguarded substring -- the same unbounded-Hebrew-substring pitfall
    // this file's header and every other round-518-style fix already
    // warns about, which English "spa" above was explicitly protected
    // from via `\b` but Hebrew never got an equivalent guard for. "ספא" is
    // a literal 3-letter prefix of two ordinary, common, completely
    // unrelated Hebrew words: "ספארי" ("safari", as in an African safari
    // tour/park business) and "ספאם" ("spam", the common transliteration
    // for unwanted email/messages). Confirmed empirically via the real
    // `matchEntities`: "אפליקציה לניהול טיולי ספארי באפריקה" (an app for
    // managing safari trips in Africa) matched Appointment as its ONLY
    // entity, the real safari-tour domain entirely lost -- the same
    // severity round 880's own "menu" finding and round 1982's own
    // "משובח" finding already document -- and "אפליקציה לסינון הודעות
    // ספאם נכנסות" (an app for filtering incoming spam messages) matched
    // only Appointment too. A lookahead excluding "רי" and "ם" immediately
    // after "ספא" rejects both collisions while still matching every real
    // standalone use ("ספא לעיסויים", "מכון ספא", "חדר ספא").
    //
    // Round 2287: "פגישה"/"פגישות" above cover the bare noun and plain
    // plural, but not Hebrew's own construct-state ("סמיכות") inflection
    // -- exactly the pitfall #2 this file's own header warns about,
    // applied here to an entry nobody had checked against it yet.
    // "פגישה" (ending ה) becomes "פגישת" (ending ת) immediately before a
    // following noun, e.g. "פגישת ייעוץ" ("consultation meeting") or
    // "פגישת עבודה" ("work meeting") -- an everyday, idiomatic way to
    // describe exactly the appointment this entity exists for, and
    // "פגישת" is not a substring of either bare form, so it silently
    // escaped this hint entirely. Confirmed via the real matchEntities:
    // "אפליקציה לקביעת פגישת יעוץ ולשלוח תזכורת יום לפני" (an app for
    // scheduling a consultation meeting and sending a reminder the day
    // before) matched only the generic Item fallback, with the real
    // Appointment domain entirely lost, while the bare-noun twin
    // ("...פגישה עם רופא...") already matched correctly.
    //
    // Round 2288: the exact same construct-state gap round 2287 just
    // fixed for "פגישה"/"פגישת", sitting two keywords later in this same
    // array -- "מספרה" (barbershop/hair salon, below) never got its own
    // construct form "מספרת" added. "מספרת גברים" ("men's barbershop")
    // and "מספרת נשים" ("women's hair salon") are extremely common,
    // idiomatic ways to name this exact business, and "מספרת" is not a
    // substring of "מספרה", so it silently escaped this hint too.
    // Confirmed via the real matchEntities: "אפליקציה למספרת גברים
    // לניהול לוח הזמנים והלקוחות שלנו" matched only Customer, with the
    // real Appointment domain lost, while the bare-noun twin ("...
    // במספרה...") already matched both Customer and Appointment.
    keywords: [
      // Round 2312: bare "appointment" is a literal substring of two
      // completely unrelated, common words -- "disappointment"
      // (feelings/reviews/complaints) and "reappointment" (e.g. a board
      // or committee member, an HR/governance concept) -- with zero
      // scheduling connection. Confirmed live: "An app to record moments
      // of disappointment." and a committee-reappointment description
      // both matched ONLY ['Appointment'], fabricating a bogus
      // scheduling entity with zero relation to either description.
      // The same unguarded-bare-string pitfall this file's other
      // `\b`-bounded keywords (just below, "bookings?"/"reservations?")
      // already guard against. Not in BILLING_ENTITY_NAMES (rounds
      // 1345/1346 deliberately excluded Appointment there) and not
      // duplicated in PAYMENT_KEYWORDS, so this fix affects only entity
      // detection, not payment recommendations.
      /\bappointments?\b/, /\bbookings?\b/, /\breservations?\b/,
      "hair salon", "beauty salon", "nail salon", "barbershop", "barber shop", "hairdresser", "hair stylist",
      /\bspa\b/, "massage", "massage therapy",
      "תורים", "פגישה", "פגישות", "פגישת", "מספרה",
      // Round 2339: the round 2288 construct-state fix above added bare
      // "מספרת" completely unguarded -- unlike almost every other Hebrew
      // keyword in this file. "מספרת" is also the ordinary Hebrew
      // feminine-singular present-tense verb "tells/narrates" (Piel
      // binyan of the root ס-פ-ר, e.g. "היא מספרת סיפור" = "she tells a
      // story"), with zero connection to a hair salon/barbershop.
      // Confirmed live: "אפליקציה לילדים שבה דמות מספרת סיפור לפני
      // השינה כל ערב" (a kids' app where a character tells a bedtime
      // story every night) fabricated Appointment as its ONLY entity for
      // a pure storytelling app with zero scheduling content, and
      // "...המורה מספרת סיפורים קצרים לתלמידים..." (the teacher tells
      // short stories to students) bolted a bogus Appointment onto an
      // otherwise-correct Student/Course spec.
      //
      // Hebrew has no \b, so this excludes the specific narrative-verb
      // direct objects the "tells" sense takes immediately after it
      // (same leaky-denylist convention as this file's other idiom
      // guards, e.g. round 2338's לקוח guard) -- confirmed empirically
      // against both existing round-2288 test fixtures ("מספרת גברים"/
      // "מספרת נשים") that this doesn't regress genuine salon-naming
      // usage, since neither "גברים" (men) nor "נשים" (women) is a
      // narrative-object noun. Deliberately a leaky denylist, not an
      // exhaustive fix: a narrative object outside this curated list
      // (e.g. "מספרת שיר"/tells a poem, "מספרת חידה"/tells a riddle)
      // would still slip through, an accepted trade-off for the
      // confirmed-live common cases this closes.
      /מספרת(?!\s*(?:סיפור|סיפורים|סיפורי|בדיחה|בדיחות|חוויה|חוויות|אגדה|אגדות|זכרון|זכרונות|זיכרון|זיכרונות|עלילה|עלילות|על|לי|לו|לה|להם|לנו|איך|כיצד|מה|משהו))/,
      // Round 2365: the plain plural "מספרות" ("hair salons"/
      // "barbershops") was never added at all -- "מספרה" ends in ה, its
      // plural "מספרות" ends in ות, not a substring of either existing
      // form, the same fem-plural gap shape already fixed elsewhere
      // (תרומה/עמותה/הזמנה/חתונה). A plural-only hair-salon description
      // lost the Appointment entity entirely. Guarded identically to the
      // round-2339 "מספרת" guard above: "מספרות" also spells the
      // ordinary fem.-plural present-tense verb "tell/narrate" (e.g.
      // "המורות מספרות סיפורים"), confirmed live via several real
      // storytelling sentences all spuriously matching without this
      // guard -- same leaky-denylist convention as the construct-form
      // guard it mirrors.
      /מספרות(?!\s*(?:סיפור|סיפורים|סיפורי|בדיחה|בדיחות|חוויה|חוויות|אגדה|אגדות|זכרון|זכרונות|זיכרון|זיכרונות|עלילה|עלילות|על|לי|לו|לה|להם|לנו|איך|כיצד|מה|משהו))/,
      "סלון יופי", /ספא(?!רי|ם)/, "עיסוי",
    ],
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
      // "trainer"/"מאמן" (round 1720): a fitness-studio app's own staff are
      // its trainers/coaches, not generic "employees" -- without this the
      // heuristic generator produces no Employee entity at all for a gym
      // description that explicitly names trainers. "מאמן"/"מאמנת"/"מאמנים"
      // don't collide with "מאמין" (believer) or "מתאמן"/"להתאמן" (to
      // practice/work out) as bare substrings, so no lookbehind guard is
      // needed here (unlike עובד/צוות below).
      //
      // Round 2290: those three forms don't cover Hebrew's own construct-
      // state ("סמיכות") plural "מאמני" (e.g. "מאמני כדורגל", "football
      // coaches") -- the same inflection-gap class already fixed 4 rounds
      // running for other entities (lodging, Appointment x2, Task). The
      // plural "מאמנים" reverts the bare singular's word-final sofit nun
      // (ן) to a regular nun (נ) before adding its own suffix, so neither
      // "מאמן" (ending in sofit nun) nor "מאמנת" is a substring of the
      // construct form "מאמני" (ending in regular nun + "י") -- two
      // different Unicode letters, not just a human-readable near-miss.
      // Confirmed via the real matchEntities: "אפליקציה לניהול מאמני
      // כדורגל בקבוצה" matched only the generic Item fallback, with the
      // real Employee/staff domain entirely lost, while the bare-plural
      // twin ("...מאמנים בקבוצה") already matched Employee correctly.
      // Round 2362: the same reasoning applies to the fourth inflection,
      // feminine plural "מאמנות" ("female trainers/coaches") -- the bare
      // "מאמן" ends in sofit-nun "ן", never a substring of "מאמנות"'s
      // regular "נ" + "ות", so it was never covered either. Confirmed no
      // collision with "מתאמנות" (trainees/practicing women) or
      // "מאמינות" (believers) -- "מאמנות" is not a substring of either.
      /\btrainers?\b/, "מאמן", "מאמנת", "מאמנים", "מאמני", "מאמנות",
      // Bare "עובד"/"עובדת"/"עובדים" (round 565) are substrings of the
      // pu'al passive-participle adjective "מעובד"/"מעובדת"/"מעובדים"/
      // "מעובדות" ("processed", as in processed food/data/materials), an
      // extremely common Hebrew word with nothing to do with staff. Hebrew
      // has no \b (same reason round 518's "מלאי" and round 564's "מוצר"
      // fixes needed lookbehind too); this excludes the specific "מ" pu'al
      // prefix while still matching every real "עובד"-based phrasing.
      //
      // Round 1919: that fix only ever guarded the single character
      // immediately BEFORE "עובד" -- it did nothing about "עובד" also
      // being the literal 4-letter prefix of two different nouns that
      // START with it: "עובדה" (fact, singular -- completely unambiguous,
      // never means "worker") and "עובדות", a true homograph (either
      // "facts"/plural-of-עובדה, or "female workers"/plural-of-עובדת). A
      // plain trivia/quiz/educational-facts app description ("אפליקציית
      // טריוויה שמציגה עובדות מעניינות על חלל ומדע") spuriously fabricated
      // an unrelated Employee entity AND role, purely from "עובדות
      // מעניינות על" ("interesting facts about"). "עובדה" is dropped
      // outright (no legitimate "worker" sense collides with it); for the
      // genuine "עובדות" homograph, only the specific co-occurring words
      // that mark the "facts" sense are excluded (mirroring round 890's
      // identical "ביקורת" audit/review homograph fix's own by-co-
      // occurrence approach), so a bare "עובדות" with no such word nearby
      // (e.g. "ניהול עובדות משק הבית", "גיוס עובדות חדשות") still matches
      // Employee by default, same as before this fix.
      /(?<!מ)עובד(?!ה)(?!ות\s*(?:על|מעניינ|מרתק|מדהימ|משעשע|סקרני|אקראי))/,
      /(?<!מ)עובדת/, /(?<!מ)עובדים/,
      // Bare "צוות" (round 825) is a substring of "מצוות" ("commandments"/
      // "mitzvot" -- a religious-observance tracker or bar/bat-mitzvah
      // planning app description), the same "מ + root" collision shape
      // "עובד" just above was fixed for.
      /(?<!מ)צוות/,
    ],
    labelHe: "עובדים",
    descriptionHe: "מישהו שעובד בעסק.",
    fieldLabelsHe: { name: "שם", role: "תפקיד", email: "אימייל", phone: "טלפון", active: "פעיל/ה" },
    entity: {
      name: "Employee",
      description: "A person who works for the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "role", type: "text", required: false },
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
        { name: "active", type: "boolean", required: false },
      ],
    },
  },
  {
    // Bare "חיוב" is a substring of the unrelated adjective/noun
    // "חיובי"/"חיובית"/"חיוביות" ("positive"/"positivity") -- see the
    // identical fix and its rationale in heuristic.ts's PAYMENT_KEYWORDS.
    // "חיובים" is still matched explicitly as its own keyword below.
    //
    // Round 2301: the bare English "billing" keyword that used to sit
    // here (and was independently duplicated in heuristic.ts's
    // PAYMENT_KEYWORDS) was unguarded, unlike every other keyword in
    // this array -- the same shape round 2297 ("nonprofit") and round
    // 2300 ("subscription") fixed. "Billing" is genuinely polysemous:
    // the entertainment-industry sense ("billing order" -- whose name
    // appears first/biggest in credits) has nothing to do with money.
    // Confirmed live: "An app for a community theater to track actors,
    // their roles, and billing order in each show's printed program."
    // fabricated an Invoice entity and wrongly recommended Stripe.
    // Removed -- every genuine invoicing/billing description already
    // matches via "invoice"/"payment" or the Hebrew keywords instead.
    keywords: ["invoice", "payment", "חשבונית", "חשבוניות", /חיוב(?!י(?!ם))/, "חיובים"],
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
      // "order"/"orders" as a plain \b-bounded word is still a substring
      // collision of a different, idiom-co-occurrence shape (pitfall 1b,
      // same class as Deal's removed "pipeline" and Appointment's removed
      // "schedule" below): "in order to" is one of the most common
      // connector phrases in ordinary English, so a description for a
      // completely unrelated app -- a yoga studio's class schedule, an
      // employee-compliance tracker, a legal-aid case tool -- that happens
      // to use it ("...to help instructors plan their week, in order to
      // keep classes on schedule") spuriously matches this entity too,
      // confirmed with a real repro before fixing. Unlike "pipeline"/
      // "schedule", bare "order" can't simply be dropped: two existing
      // tests below rely on it matching a genuine standalone use ("Place
      // an order for pickup.", "order-management"), and this entity's own
      // other keywords (purchase/checkout/delivery) don't cover every
      // legitimate order-tracking description on their own.
      //
      // Round 2130: the original fix here only excluded the LITERAL
      // three-word "in order to" (requiring "in " immediately before AND
      // " to" immediately after the same occurrence) -- but "in order"
      // without a trailing "to" is an equally common, equally unrelated
      // idiom ("keep my daily life in order", "keep client files in
      // order", "keep case documents in order and organized") meaning
      // "organized/valid/functioning", nothing to do with e-commerce.
      // Confirmed live before fixing: a habit-tracker description, a law-
      // office-filing description, and a legal-case-document description
      // each spuriously matched Order via this exact keyword. Simplified
      // to excluding "order(s)" whenever preceded by a standalone "in "
      // at all (covering "in order", "in order to", "in order for X to
      // Y" uniformly), with an extra lookbehind keeping real compound
      // words like "walk-in orders"/"drop-in orders" matching (the
      // hyphen means that "in" isn't the standalone connector word).
      // This doesn't reach the rarer idioms that keep "order" as a
      // genuine standalone word with unrelated meaning ("court order",
      // "money order", "restraining order") -- accepted as residual
      // risk, the same trade-off this file's other \b-bounded fixes
      // already make, since "in order (to)" alone is overwhelmingly more
      // common across ordinary app descriptions than all of those
      // combined.
      /(?<!(?<!-)\bin\s)\border(s)?\b/,
      // Round 2305: bare "purchase" had no guard against the ordinary
      // mechanical/climbing/political "grip/influence" idiom ("how much
      // purchase their shoes get on the rock face", "the purchase our
      // message has with swing voters", "a lever gives you more purchase
      // on a stuck bolt") -- confirmed live, all three fabricated an
      // Order entity with zero e-commerce concept. Not a bare deletion:
      // "an app to track customer purchases at our shop" depends solely
      // on this bare word, so a lookbehind excluding only the specific
      // "much/more purchase" idiom is used instead, mirroring this
      // file's other \b-bounded fixes' accepted-residual-risk trade-off
      // (e.g. "court order"/"money order" above).
      //
      // Round 2368: the English side of this same completeness gap
      // Hebrew keywords were swept for in rounds 2359-2366 -- this
      // keyword only ever covered the bare infinitive/present "purchase"
      // and the plural/3rd-person "purchases", never the past tense
      // "purchased" or the gerund "purchasing", even though describing
      // a purchase-tracking feature in either tense is at least as
      // natural. Since Order is in BILLING_ENTITY_NAMES, losing the
      // entity match also flipped the payment recommendation to "No
      // payments". The "much/more purchase" idiom guard doesn't need
      // widening: that mechanical/grip idiom never conjugates as
      // "purchased"/"purchasing" in natural English.
      /\bpurchas(?:e|es|ed|ing)\b(?<!(?:much|more)\s*purchase)/,
      "checkout page", "checkout flow", "online checkout",
      // Round 2305: bare "delivery"/"deliveries" had no guard against
      // the ordinary childbirth/obstetric sense ("a midwife app to track
      // patient deliveries", "an obstetric clinic app that logs each
      // delivery") -- confirmed live, all three fabricated an Order
      // entity with zero e-commerce concept. Not a bare deletion: "an
      // app for a delivery service to manage drivers and routes"
      // depends solely on this bare word, so a document-wide
      // bidirectional exclusion is used instead (mirroring this file's
      // own burger-menu/property-נכס/מנות conventions for the same
      // "genuinely ambiguous between two domains" shape), excluding
      // only when an unambiguous obstetric cue word co-occurs anywhere
      // in the text.
      /\bdeliver(?:y|ies)\b(?![\s\S]*?(?:midwife|prenatal|obstetric|newborn|maternity))(?<!(?:midwife|prenatal|obstetric|newborn|maternity)[\s\S]*)/,
      "wolt",
      // "הזמנה"/"הזמנות" is a true Hebrew homograph: it means both "order"
      // (a purchase) and "invitation" (a wedding/party/event invitation --
      // "הזמנה לחתונה", "הזמנות למסיבה"). Excludes the idiomatic "invitation
      // to X" phrasing while still matching every genuine order/purchase
      // use.
      //
      // Round 2292: despite this comment's own original claim to also
      // handle "construct-state forms," the alternation only ever covered
      // "ה"/"ות" -- there was no "ת" branch at all, so the construct-state
      // ORDER sense "הזמנת" (e.g. "הזמנת לקוח", "customer order" -- an
      // everyday, idiomatic way to describe exactly the purchase this
      // entity exists for) never matched in the first place. Simply
      // adding "ת" isn't enough on its own: "הזמנת חתונה"/"הזמנת יום
      // הולדת" (construct-state wedding/birthday INVITATION) would then
      // start matching too, since the exclusion lookahead only recognized
      // the "ל"-preposition phrasing ("הזמנה לחתונה"), not the construct-
      // state phrasing that drops the "ל" entirely ("הזמנת חתונה" has no
      // "ל" at all). The "ל" in the lookahead is made optional to cover
      // both phrasings uniformly. Confirmed via the real matchEntities:
      // "אפליקציה למעקב אחרי הזמנת לקוח" matched only Customer before this
      // fix, with the real Order domain entirely lost, while the bare-
      // noun twin ("...הזמנה של לקוח...") already matched Order correctly.
      /הזמנ(?:ה|ות|ת)(?!\s*ל?(?:חתונה|חתונת|חתונות|אירוע|אירועי|אירועים|מסיבה|מסיבת|מסיבות|כנס|יום\s*הולדת))/,
      "רכישה", "רכישות",
      // Round 2364: the absolute forms "רכישה"/"רכישות" above never
      // covered the construct-state singular "רכישת" (e.g. "רכישת ציוד"
      // = "equipment purchase", "רכישת לקוח" = "customer purchase/
      // acquisition") -- since "רכישת" ends in ת, not ה, it is not a
      // substring of either absolute form and fell through entirely to
      // whatever other entity matched (Item/Customer/Vehicle), exactly
      // the same construct-state gap shape round 2363 fixed for
      // Donation's "תרומת". Unlike "תרומת" though, a bare "רכישת"
      // addition collides with the ordinary "acquisition of X" idiom
      // (gaining knowledge/experience/citizenship/trust/status etc.,
      // e.g. "רכישת ניסיון מקצועי" = "gaining professional experience",
      // "רכישת אזרחות" = "acquiring citizenship") -- confirmed live, a
      // naive unguarded "רכישת" addition turned every one of several
      // such idiom sentences (none of which matched Order before) into
      // a spurious Order match, which is strictly worse than the status
      // quo. The negative lookahead excludes exactly those idiom nouns
      // right after "רכישת", mirroring this file's other "common word +
      // excluded noun list" guards (e.g. ROLE_RULES.Manager's
      // "מנהל(?!...מערכת)"). The pre-existing absolute-form idiom
      // collision ("רכישה של ניסיון מקצועי" already spuriously matching
      // Order) is a separate, broader, pre-existing bug this round does
      // not attempt to fix.
      /רכישת(?!\s*(?:ניסיון|זמן|אזרחות|ידע|השכלה|מוניטין|ביטחון|אמון|כוח|השפעה|מעמד|חברים))/,
      "משלוח", "משלוחים",
      // "וולט" is the Hebrew transliteration of both the Wolt delivery
      // app and the electrical unit "volt" -- identical spelling, no way
      // to tell them apart by spelling alone. Excludes the unit sense via
      // (a) an immediately preceding digit (with an optional space) and
      // (b) the "ים"/"אז" inflections ("וולטים"/"וולטאז'"), while leaving
      // every genuine standalone brand mention ("וולט", "כמו וולט",
      // "מוולט") still matching.
      /(?<!\d)(?<!\d\s)וולט(?!ים|אז)/,
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
    //
    // Bare "שירות"/"שירותים" (round 829) are substrings of "כשירות"
    // ("competency"/"fitness"/"eligibility" -- e.g. "כשירות משפטית" legal
    // competency, "בדיקת כשירות גופנית" a physical fitness test), an
    // ordinary Hebrew word with nothing to do with selling a service.
    // Hebrew has no \b (same reason round 565's "מעובד" and round 825's
    // "מצוות" fixes needed lookbehind too); this excludes the specific "כ"
    // prefix while still matching every real "שירות"-based phrasing.
    //
    // Round 1984: bare "טיפול" is itself an unguarded 5-letter prefix of
    // the unrelated, ordinary Hebrew word "טיפולוגיה" ("typology" -- a
    // psychology/personality-classification or categorization-system term,
    // e.g. "טיפולוגיה פסיכולוגית"/"טיפולוגיה ארגונית"), with zero connection
    // to selling a service. Hebrew has no `\b` (the same reason this same
    // entry's own "שירות" fix above, and round 518's "מלאי", needed a
    // lookahead/lookbehind too), so an unguarded bare substring match fired
    // on the "typology" sense exactly as readily as the real "treatment"
    // sense -- confirmed empirically via the real `matchEntities`:
    // "אפליקציה למיון סוגי אנשים לפי טיפולוגיה פסיכולוגית" (an app to sort
    // people by psychological typology) and "אתר שמציג טיפולוגיה של סוגי
    // אישיות שונים" (a site presenting a typology of different personality
    // types) both produced only `[Service]`, fabricating a price/duration
    // catalog entity for an app with nothing to do with selling a service --
    // the same "real domain entirely lost" severity round 880's own "menu"
    // finding and rounds 1982/1983's own "משובח"/"ספארי" findings already
    // document. A single `(?!וג)` lookahead excludes exactly the
    // "טיפולוגיה"/"טיפולוגי"/"טיפולוגים" inflections (all of which continue
    // with "וג" right after "טיפול", with no space) while still matching
    // every real standalone use ("טיפול", "הטיפול", "לטיפול", and the
    // plural "טיפולים", none of which are followed by "וג"), confirmed
    // empirically after fixing.
    keywords: [/\bservice(s)?\b/, /\btreatment(s)?\b/, /(?<!כ)שירות/, /(?<!כ)שירותים/, /טיפול(?!וג)/, "טיפולים"],
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
      // Bare "מלאי" ("inventory/stock") is a substring of three unrelated,
      // ordinary Hebrew words. Round 518 excluded WorkOrder's own
      // "חשמלאי"/"חשמלאים" ("electrician(s)") and the common adjective
      // "מלאים" ("full", plural) -- e.g. "ארונות מלאים" ("full cabinets")
      // has nothing to do with retail inventory. Round 1535: "ממלאי מקום"/
      // "ממלאי תפקיד" ("deputies"/"role-holders" -- ordinary HR/admin
      // Hebrew, e.g. substitute teachers) also contains "מלאי" as a
      // literal substring ("מ"+"מלאי"), and round 518's own lookbehind
      // only excluded the two-character "חש" prefix, not a bare single
      // "מ" -- same reason round 565's "עובד"/"נהג" fixes needed a
      // `(?<!מ)` lookbehind of their own. JS regex's `\b` only recognizes
      // ASCII word characters, so it can't bound a Hebrew word the way it
      // bounds "stock"/"product" above; a lookbehind for "חש", a second
      // lookbehind for a bare "מ", plus a lookahead against the "ם"
      // plural suffix excludes all three collisions while "מלאי" still
      // matches as its own word (e.g. "ניהול מלאי", "המלאי", "במלאי").
      /(?<!חש)(?<!מ)מלאי(?!ם)/,
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
    //
    // "deals with" (round 911): the far more common pitfall-1b shape this
    // entry never got -- "deals with" is the ordinary English phrasal
    // verb for "handles/manages" ("a help desk app that deals with
    // customer complaints", "a tool that deals with scheduling
    // conflicts"), nothing to do with sales, and a bare `\bdeals\b` fires
    // on it every time via the real HeuristicSpecProvider. Confirmed via
    // matchEntities directly: a scheduling-conflict description got Deal
    // as its ONLY entity, with the app's real (nonexistent) domain
    // entirely lost -- the same severity as round 880's "menu" finding.
    // Can't just exclude "deals with" outright, though: the sales reading
    // genuinely uses the identical three words ("close more deals with
    // current clients", already covered by this file's own existing
    // tests) -- the two readings differ in what comes *before* "deals",
    // not what follows it. Only the sales-closing-verb reading re-allows
    // "deals with"; every other case (the far more common phrasal-verb
    // reading, where "deals" itself is the sentence's own main verb) is
    // excluded, the same two-independent-exclusions shape MenuItem's own
    // "dish" entry above already uses for an analogous idiom collision.
    // "opportunity"/"opportunities" (round 1722): the app's own built-in
    // "Sales CRM" home-screen example (home.examples.crm.text, both
    // languages) reads "...with sales stages, meetings, and opportunity
    // tracking" / "...עם שלבי מכירה, פגישות ומעקב הזדמנויות" -- live-
    // confirmed via HeuristicSpecProvider.generate() that this exact
    // sentence produced no Deal entity at all before this fix, in either
    // language, despite the Deal entity's own `stage` enum literally
    // including "Lead" as a value. "lead"/"leads" itself is deliberately
    // NOT added here: unlike "deals" above (whose one false-positive
    // idiom, "deals with", is cleanly excludable by what follows it),
    // "lead(s)" collides with the ordinary English verb "to lead" in far
    // too many common, unrelated app-description shapes to exclude with
    // one or two lookaheads ("an app that leads users through...", "leads
    // the team", "leads to", "takes the lead", "lead guitarist") -- no
    // single-exclusion guard meaningfully separates the CRM-noun reading
    // from the verb reading the way "deals with" vs "close deals with"
    // could be told apart by what came immediately before it.
    // Round 2105: the bare "opportunity"/"opportunities" keyword just
    // below had the identical "deals with" collision shape, just never
    // given its own guard -- "equal opportunity employer" (an everyday
    // phrase in an HR/hiring app description) and "an opportunity to
    // learn/attend/..." (the ordinary English idiom "opportunity to
    // VERB", common in education/nonprofit descriptions) both fabricated
    // a spurious Deal entity with zero sales-CRM content. Confirmed live:
    // an HR applicant-tracker description containing "equal opportunity
    // employer" matched ['Deal', 'JobApplicant'] instead of just
    // ['JobApplicant']. Two independent exclusions, the same shape as the
    // "deals" guard above: excluded when preceded by "equal " (the
    // hiring-policy idiom) or followed by " to" (the "opportunity to
    // VERB" idiom) -- the round-1722 CRM example's own "opportunity
    // tracking" phrasing is neither, so it still matches correctly.
    // Round 2151: the sales-closing-verb lookbehind just below bounded its
    // own word gap to {0,2} -- the false-NEGATIVE mirror of the same
    // fixed-distance-window defeat class rounds 2149/2150 already fixed
    // elsewhere in this file (Courier's font-exclusion, Volunteer's
    // "volunteer information" exclusion): those were too-narrow EXCLUSION
    // windows letting a false positive slip past; this is a too-narrow
    // RE-ALLOW window, so a real sales phrase with 3+ qualifying words
    // between "close" and "deals" (adjectives describing the deals, e.g.
    // "close bigger, more complex enterprise deals with key accounts")
    // never re-enables the "deals with" match at all, silently dropping
    // the Deal entity from an unambiguous sales-CRM description.
    // Confirmed live: a CRM description built around exactly that phrase
    // matched only ['Customer'], Deal entirely missing, not masked by any
    // other Deal keyword (negotiation/opportunity/עסקה all absent too).
    // Widened from {0,2} to {0,6} rather than a fully unbounded `*` --
    // unlike Courier/Volunteer's EXCLUSION windows (where unbounded only
    // ever narrows an already-positive match, so reaching further back
    // is always safe), this is a RE-ALLOW window: going fully unbounded
    // would let an unrelated, much earlier "close/closing/closed" (e.g.
    // from a prior, unconnected sentence) re-enable "deals with" for a
    // genuinely different, later phrasal-verb use. `[^\s.!?]+` (rather
    // than `\S+`) also stops the lookbehind from crossing a sentence
    // boundary at all, so an earlier sentence's own "closed" can never
    // reach into a later, unrelated "deals with" -- confirmed live: "We
    // closed the store at 9pm. The app deals with inventory tracking."
    // still correctly gets no Deal entity.
    keywords: [
      // Round 2307: bare "deals" had no guard against the ordinary
      // criminal/diplomatic sense of "deal" -- "drug deals", "illegal
      // deals", "hostage-exchange deals" are all common, genuinely
      // unrelated phrasings with zero sales-CRM content. Confirmed
      // live: "A system for police to track drug deals exposed during
      // investigations..." and two similar sentences all fabricated a
      // Deal entity (and, for the police/investigation case, lost the
      // app's real domain entirely). Guarded with lookbehinds excluding
      // the specific drug/illegal qualifiers immediately before "deals"
      // and a document-wide exclusion for "hostage" (which can precede
      // "deals" at any distance, e.g. "hostage-exchange deals"),
      // mirroring this file's other bare-overly-broad-word fixes.
      /(?<!\bdrug\s)(?<!\billegal\s)(?<!hostage[\s\S]*)\bdeals\b(?!\s+with\b)|(?<=\b(?:close|closing|closed)\b(?:\s+[^\s.!?]+){0,6}\s)\bdeals\b(?=\s+with\b)/,
      "negotiation",
      /(?<!\bequal\s)\bopportunit(?:y|ies)\b(?!\s+to\b)/,
      // Round 2307: the Hebrew sibling had the identical collision --
      // "עסקה לא חוקית" (illegal deal), "עסקאות סמים" (drug deals), and
      // "עסקאות החזרת חטופים" (hostage-exchange deals) all fabricated a
      // Deal entity too. Guarded with a lookahead excluding the same
      // three qualifiers (which follow the noun in Hebrew).
      /עסק(?:ה|אות)(?!\s*(?:לא\s*חוקית|סמים|החזרת\s*חטופים))/,
      "משא ומתן",
      // "לידים" (plural "leads", round 1722): the Hebrew half of the same
      // CRM example gap above -- unlike the English noun, this Hebrew
      // plural has no competing everyday meaning, so no collision guard
      // is needed. The bare SINGULAR "ליד" is deliberately excluded: it's
      // also the extremely common preposition "near/beside" ("חדר ליד
      // המטבח" = "a room near the kitchen"), an ambiguity at the word
      // level itself (not a substring-boundary issue regex lookbehind/
      // lookahead can resolve, since both readings are the identical
      // standalone word) -- adding it unguarded would spuriously tag
      // nearly any description mentioning something being near something
      // else as a sales CRM.
      "לידים",
      // Round 2337: unlike every other Hebrew keyword in this array
      // (עסקה/עסקאות and לידים both have their own collision writeup,
      // or an explicit note on why none is needed), bare "הזדמנות"/
      // "הזדמנויות" were listed completely unguarded -- the exact Hebrew
      // counterpart of the ENGLISH "opportunity"/"opportunities"
      // collision already fixed a few lines above (round 2105's
      // (?<!\bequal\s)\bopportunit(?:y|ies)\b(?!\s+to\b) guard), but that
      // fix was never mirrored onto the Hebrew side. "הזדמנות" is
      // routinely used in the ordinary, non-CRM "chance/opportunity to
      // do X" idiom -- confirmed live: "זו הזדמנות פז לנסוע לחופשה
      // בחינם..." (a golden opportunity to go on a free vacation),
      // "...ההזדמנות הזו ללמוד שפה חדשה..." (this opportunity to learn a
      // new language), and "הזדמנות של פעם בחיים לטייל בעולם" (a
      // once-in-a-lifetime opportunity to travel the world) each
      // fabricated a bogus Deal entity (fields title/value/stage/owner)
      // for a plain vacation/learning sentence with zero CRM content.
      //
      // Mirrors round 2105's "opportunity to VERB" exclusion shape, but
      // Hebrew's "ל" prefix marks both an infinitive verb AND a dative
      // noun (unlike English "to"), so a bare "ל" exclusion would be
      // unsafe -- it would wrongly exclude genuine CRM phrasing like
      // "הזדמנות ללקוחות חדשים" (opportunity for new customers) or
      // "הזדמנות למכירה" (opportunity for a sale), both confirmed still
      // matching correctly since "לקוחות"/"מכירה" aren't infinitives.
      // Instead this excludes a specific, deliberately leaky denylist of
      // common infinitives that follow the noun in this idiom (same
      // "leaky denylist" convention as round 2027's ספק guard and round
      // 2334's צדקה guard), allowing up to 3 intervening words
      // (adjectives like "פז"/"מצוינת", demonstrative "הזו") between the
      // noun and the verb -- confirmed empirically this bound doesn't
      // regress any of this entity's existing genuine-CRM test fixtures.
      // A verb outside this list (e.g. "ההזדמנות הזו היא לפתוח עסק
      // חדש") can still slip through unfixed, an accepted trade-off for
      // the confirmed-live common cases this closes.
      /הזדמנ(?:ות|ויות)(?!(?:\s+\S+){0,3}\s*ל(?:נסוע|למוד|התפתח|גלות|חוות|השתתף|הרוויח|חסוך|התנסות|קחת\s*חלק|הנות|ראות|בקר|חיות|גדול|היות|עבוד|בלות|טייל|הכיר)\S*)/,
    ],
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
    // Round 871: a `\b`-bounded "dish(es)" is still the idiom-co-occurrence
    // shape (pitfall 1b, same as Order's "in order to" and Event's "video
    // conference"/"conference call") -- "satellite dish(es)" is a genuine,
    // correctly-spelled standalone phrase for a satellite-TV installer
    // that has nothing to do with restaurants, and "dish soap"/"dish
    // rack(s)"/"dish towel(s)"/"Dish Network" are equally ordinary
    // kitchenware/cleaning/brand phrases. Confirmed empirically before
    // fixing: a satellite-TV installation description, a dish-soap
    // subscription description, and a dish-rack-inventory description all
    // spuriously matched MenuItem via HeuristicSpecProvider's real
    // matchEntities. Bare "dish"/"dishes" can't simply be dropped --
    // heuristic.test.ts already relies on it matching genuine standalone
    // uses ("daily dish specials", "which dishes are available"), so this
    // mirrors Event's two-INDEPENDENT-exclusions shape rather than Order's
    // single joined idiom: excluded when immediately preceded by
    // "satellite " OR immediately followed by one of a small, specific set
    // of non-restaurant compound nouns, either alone sufficient to reject
    // a match.
    // Round 880: bare "menu"/"תפריט" was the exact same unguarded-substring
    // shape -- but far more reachable than "dish", since "menu" is
    // ubiquitous software UI vocabulary ("navigation menu", "hamburger
    // menu", "dropdown menu", "menu bar"), not a niche idiom. Confirmed
    // empirically: HeuristicSpecProvider.generate on a plain task-manager
    // description mentioning a "navigation menu" fabricated a whole
    // MenuItem restaurant entity (price/category/available fields) with
    // zero connection to the actual app; a note-taking app with a
    // "hamburger menu for settings" matched ONLY MenuItem, losing the real
    // Note entity entirely. Hebrew "תפריט ניווט" (navigation menu) and
    // "תפריט נפתח" (dropdown menu) reproduced the identical failure. Every
    // existing test already pairs "menu"/"תפריט" with "cafe"/"restaurant"/
    // "dish"/"מסעדה", so excluding the UI-chrome phrasing (rather than
    // dropping the keyword outright) preserves every genuine menu-only
    // restaurant description while rejecting the ubiquitous UI sense.
    // Round 2241: "burger menu" -- a real, if less common, synonym for the
    // "hamburger menu" UI icon -- was never added to round 880's own list.
    // Confirmed live: "a burger menu that links to profile and settings
    // pages" matched ONLY MenuItem, same failure mode round 880 fixed.
    // Unlike the other excluded words, though, "burger" is NOT safe to add
    // to that same immediate-lookbehind list outright -- "burger" (unlike
    // "navigation"/"hamburger"/"dropdown"/etc.) has a genuine, ordinary
    // restaurant sense of its own ("the burger menu and daily specials"),
    // so a blanket exclusion would wrongly reject every real burger-joint
    // app description instead. This is the exact same "genuinely
    // ambiguous between two domains" shape round 1828/2110 already solved
    // for "property"/"נכס" (asset vs. real estate) with a document-wide
    // bidirectional lookaround rather than a simple adjacent-word
    // exclusion: "burger menu" is excluded only when an unambiguous
    // software-UI cue word (navigation/icon/sidebar/profile/settings/tap/
    // click/link) co-occurs ANYWHERE in the text, in either order
    // relative to "burger" -- otherwise it still matches as the ordinary
    // restaurant idiom it usually is.
    keywords: [
      /(?<!\b(?:navigation|nav|hamburger|dropdown|drop-down|side|context|settings)\s)(?<!\bburger\s(?=[\s\S]*?\b(?:navigation|icon|sidebar|profile|settings|tap|click|link)\b))(?<!\b(?:navigation|icon|sidebar|profile|settings|tap|click|link)\b[\s\S]*?\bburger\s)\bmenu\b(?!\s*bar\b)/i,
      /(?<!\bsatellite\s)\bdish(es)?\b(?!\s*(soap|racks?|towels?|network)\b)/, "food item", "restaurant", "cafe", "מסעדה", "מסעדות",
      // Round 2319: round 880's own UI-chrome guard above excluded bare
      // "תפריט" (menu) only when the cue word (ניווט/נפתח/צד) appeared
      // immediately after the SINGULAR form -- it was never extended to
      // the construct-plural "תפריטי" or absolute plural "תפריטים"
      // forms, a separate substring relationship since Hebrew's plural
      // suffix isn't part of the singular word. Confirmed live: "כמה
      // תפריטי ניווט בצד המסך..." (several navigation menus on the side
      // of the screen) and "תפריטי צד שונים לניווט..." (various side
      // menus for navigating) both fabricated MenuItem -- and, since
      // MenuItem is in BILLING_ENTITY_NAMES, also wrongly flipped the
      // payment recommendation to Stripe for a plain settings/profile
      // app. The optional plural suffix is placed INSIDE the lookahead
      // itself (not as a separate optional group before it) -- placing
      // it outside lets the regex engine backtrack to the zero-length
      // alternative and still pass the now-trivially-satisfied
      // lookahead, silently reintroducing the exact bug (confirmed by
      // testing that naive structure directly). The genuine restaurant
      // plural ("תפריטי השף" = the chef's menus) still matches,
      // confirmed empirically.
      /תפריט(?!(ים|י)?\s*(ניווט|נפתח|צד))/,
      // Round 2304: bare "מנות" (plural of "מנה") already excluded the
      // "הזמנות" (orders) collision via the (?<!ז) lookbehind, but had no
      // guard against its equally common medical/clinical "dose(s)"
      // sense (medication/vitamin/radiation doses) -- a true Hebrew
      // homograph, the same "genuinely ambiguous between two domains"
      // shape this file's own burger-menu/property-נכס fixes already
      // use a document-wide bidirectional lookaround for. Confirmed
      // live: a nursing-home medication-dose tracker, a vitamin-dose
      // tracker, and an oncology radiation-dose tracker all fabricated
      // a MenuItem entity (plus a wrong Stripe recommendation) purely
      // from "מנות", with zero restaurant/menu concept. Not a bare
      // deletion -- "מציגה את כל המנות עם מחיר" (a real menu-with-
      // pricing description) depends solely on this bare word with no
      // other MenuItem keyword present, so a document-wide exclusion
      // (mirroring the property-נכס approach) is used instead, only
      // when an unambiguous dosage-cue word co-occurs ANYWHERE in the
      // text, in either order relative to "מנות".
      //
      // Round 2337: the (?<!ז) lookbehind only catches "מנות" preceded
      // by "ז" (for "הזמנות", orders) -- it missed that bare singular
      // "הזדמנות" (opportunity, fixed as its own Deal-entity false
      // positive just above in this file) is ALSO a literal superstring
      // of "מנות": ה-ז-ד-מ-נ-ו-ת, where the character immediately before
      // "מנות" is "ד", not "ז". Since MenuItem is in BILLING_ENTITY_NAMES,
      // this corrupted even GENUINE Deal/CRM sentences mentioning the
      // singular "הזדמנות" -- confirmed live: "הזדמנות עסקית חדשה עם
      // לקוח פוטנציאלי" (a new business opportunity with a potential
      // client), a plain, correctly-classified CRM sentence, also
      // fabricated a bogus MenuItem entity and wrongly flipped the
      // payment recommendation to Stripe. (The PLURAL "הזדמנויות" does
      // NOT have this problem -- its extra "וי" infix breaks the "מנות"
      // substring, confirmed empirically.) Extended the lookbehind to
      // also exclude a preceding "ד", confirmed no other common Hebrew
      // word ends in "...דמנות".
      /(?<![זד])מנות(?![\s\S]*?(?:תרופה|תרופות|ויטמין|ויטמינים|קרינה|אנטיביוטיקה|כימותרפיה|אינסולין|זריקות))(?<!(?:תרופה|תרופות|ויטמין|ויטמינים|קרינה|אנטיביוטיקה|כימותרפיה|אינסולין|זריקות)[\s\S]*)/,
      "בית קפה",
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
      // Bare "נהג"/"נהגים" (round 830) are substrings of "מנהג"/"מנהגים"
      // ("custom"/"tradition" -- e.g. a holiday-observance or family
      // customs description), an ordinary word with nothing to do with
      // delivery drivers. Hebrew has no \b (same reason round 565's
      // "מעובד", round 825's "מצוות", and round 829's "כשירות" fixes
      // needed lookbehind too); this excludes the specific "מ" prefix
      // while still matching every real "נהג"-based phrasing.
      // Round 2106: bare "courier" is also one of the most common
      // monospace/typewriter font names in everyday software (typography
      // pickers, PDF/document generators, invoice/template designers,
      // code editors) -- "Courier New" and plain "Courier" in a font
      // list have nothing to do with a delivery person. Confirmed live:
      // a PDF-generator description naming "Arial, Courier, or Times New
      // Roman" as font choices matched ONLY ['Courier'], losing the real
      // document-generator domain entirely -- the same severity as round
      // 880's "menu" finding.
      //
      // Round 2149: round 2106's own fix used a bounded 3-word-either-side
      // proximity window, but a very natural way to phrase the identical
      // scenario lists every font name first and only says "font" at the
      // END, once, after the whole list (e.g. "choose from Arial, Courier,
      // or Times New Roman as the font") -- "font" then sits 5+ words away
      // from "courier", outside that window on both sides, so the bounded
      // lookaround failed to exclude it. Confirmed live: both "...Courier,
      // or Times New Roman as the font." and "...Courier, or Times New
      // Roman for the document's font." still matched bare ['Courier'],
      // the real domain lost exactly as round 2106 already describes.
      // Switched to the same document-wide (unbounded, lazy) co-occurrence
      // check this file already uses for an identical "disambiguating word
      // can be far away" problem -- the Property entity's own נכס fix just
      // below -- rather than merely widening the bound again, since any
      // fixed bound can be defeated the same way by a longer list of font
      // names. "courier" immediately followed by "new" is still excluded
      // too (the single most common exact phrase, often with no nearby
      // "font" at all, e.g. "a code editor using Courier New"). A real
      // courier/delivery description essentially never mentions the word
      // "font" anywhere in the same description.
      /(?<!\bfont\b[\s\S]*)\bcouriers?\b(?!\s+new\b)(?![\s\S]*?\bfont\b)/,
      // Round 2243: bare "driver(s)" collides with the extremely common
      // tech sense -- a device/hardware driver (printer driver, graphics
      // driver, USB driver, etc.) -- with zero connection to a delivery
      // driver, the same ordinary-word-vs-software-term collision this
      // very rule's own "courier" keyword already had fixed above (round
      // 2106) for font names. Confirmed live via the real matchEntities:
      // "A dashboard to track device drivers and firmware versions..."
      // and "An app to manage printer drivers, their versions..." both
      // matched ONLY ['Courier'], fabricating a bogus delivery entity
      // (vehicleType/status fields) and losing the real IT-inventory
      // domain entirely -- the identical catch-all-losing severity every
      // other keyword-collision fix in this file describes. Excluded the
      // specific device/hardware noun immediately before "driver(s)" --
      // device/printer/graphics card/audio/network/display/usb/gpu/
      // hardware/software/chipset/bluetooth/wifi/sound/video/webcam --
      // the exact collocation this tech sense is always phrased with, so
      // the real courier sense ("our delivery drivers", "assign drivers
      // to routes") is untouched.
      // Round 2311: bare "driver(s)"/"נהג"/"נהגים" also collide with the
      // DMV/racing/driving-school sense -- a licensed-to-drive PERSON,
      // outside any delivery/courier context -- distinct from the
      // device/hardware sense fixed above (round 2243). Confirmed live:
      // "An app for the DMV to manage driver license renewals.", "A
      // racing league app to track drivers, their lap times, and
      // standings.", and a driving-school student-driver description
      // (English and Hebrew equivalents of all three) each fabricated
      // Courier as a spurious entity with zero delivery/courier content.
      // Document-wide markers exclude only the sub-cases confirmed to
      // have NO plausible overlap with genuine courier text (dmv/racing/
      // lap times/driving school/student driver -- a real courier
      // description never mentions these). Deliberately NOT excluding
      // "license"/"insurance" as markers: confirmed live that genuine
      // courier descriptions legitimately and correctly match via this
      // very keyword while also mentioning compliance fields like
      // "drivers license numbers" or "driver insurance" ("Track our
      // drivers license numbers and vehicle registrations for
      // deliveries.", "A courier company app to verify driver insurance
      // before assigning routes." -- both must keep matching Courier).
      // A naive license/insurance marker would wrongly exclude both.
      // That DMV/traffic-ticket/license/insurance sub-case is left open/
      // deferred, needing real disambiguation (e.g. requiring an absence
      // of courier-domain cues like delivery/package/route elsewhere in
      // the text) rather than an unsafe blanket marker -- the same way
      // the Ticket bare-noun gap (rounds 2282-2283) is deliberately left
      // open rather than force-fixed.
      /(?<!\b(?:dmv|racing|lap times|driving school|student driver)\b[\s\S]*)\b(?<!(?:device|printer|graphics card|audio|network|display|usb|gpu|hardware|software|chipset|bluetooth|wifi|sound|video|webcam)\s)driver(s)?\b(?![\s\S]*?\b(?:dmv|racing|lap times|driving school|student driver)\b)/i,
      "delivery person", /שליח(?![תו])/, "שליחים",
      /(?<!(?:משרד הרישוי|מירוץ|מירוצים|בית ספר לנהיגה)[\s\S]*)(?<!מ)נהג(?![\s\S]*?(?:משרד הרישוי|מירוץ|מירוצים|בית ספר לנהיגה))/,
      /(?<!(?:משרד הרישוי|מירוץ|מירוצים|בית ספר לנהיגה)[\s\S]*)(?<!מ)נהגים(?![\s\S]*?(?:משרד הרישוי|מירוץ|מירוצים|בית ספר לנהיגה))/,
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
    // Round 1655: rounds 1629/1641 each listed Courier alongside the
    // sibling person-type entities while fixing a different field's own
    // gap (phone), describing them all as carrying "name/email" -- but
    // that was never actually true for Courier specifically, which had no
    // email field or label at all, unlike every other person-type entity
    // in this file (Customer, Employee, Student, JobApplicant, Vendor,
    // Volunteer).
    fieldLabelsHe: { name: "שם", email: "אימייל", phone: "טלפון", vehicleType: "סוג רכב", status: "סטטוס" },
    enumLabelsHe: {
      vehicleType: { Bike: "אופניים", Scooter: "קטנוע", Car: "רכב" },
      status: { Available: "זמין", OnDelivery: "במשלוח", Offline: "לא זמין" },
    },
    entity: {
      name: "Courier",
      description: "The person who delivers an order to a customer.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: false },
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
      //
      // Round 1828: round 558's own comment calls "property" "genuinely
      // ambiguous" but only ever patched those 3 idioms -- the generic
      // "attribute/characteristic" sense of "properties" (material
      // science, chemistry, physics, or software/data: "the chemical
      // properties of materials", "CSS properties", "object properties")
      // is at least as common as those idioms in a non-real-estate app
      // description, and had no exclusion at all, confirmed live via
      // matchEntities -- "an app to track the chemical properties of
      // materials in a lab" got ONLY the real-estate Property entity
      // injected (address/rooms/price fields), a nonsensical spec for
      // what the description actually describes. Same multi-word
      // lookbehind-alternation style this file's own "client(s)" regex
      // above already uses for an analogous multi-qualifier exclusion.
      /\b(?<!intellectual\s)(?<!lost[\s-])(?<!\b(?:material|chemical|physical|mechanical|thermal|electrical|magnetic|optical|acoustic|structural|nutritional|medicinal|healing|object|css|data|file|system|software)[\s-])propert(?:y|ies)\b(?!\s+damage\b)/,
      // Bare "listing(s)" (round 457's own \b-bounded fix, then round 881's
      // own lookbehind fix excluding "job "/"product listing(s)") is still
      // a genuinely ambiguous whole word, the same "property" shape just
      // above -- but round 881 only ever patched those 2 specific
      // predecessors, and "listing(s)" is far more broadly ambiguous than
      // that: business-directory listings, event listings, podcast/show
      // listings, stock-market listings, and recruiter listings are all
      // ordinary idioms with nothing to do with real estate, none excluded
      // by round 881's own 2-idiom lookbehind. Confirmed live via
      // matchEntities: "a directory app for local business listings",
      // "a site for event listings", "an app for podcast episode
      // listings", and "a job board with recruiter listings" each
      // spuriously matched ONLY Property -- the real domain (directory,
      // events, podcast, job board) entirely lost -- and a stock-market-
      // listing description injected a bogus Property sibling alongside
      // the correct Product entity. Round 2129 extends round 881's own
      // lookbehind-alternation (same multi-word-exclusion style as
      // "property"'s own 15-way exclusion right above) with the specific
      // word immediately preceding "listing(s)" in each of those five
      // phrasings -- "business"/"event"/"episode"/"market"/"recruiter" --
      // rather than switching to a document-wide cue-requirement: a cue-
      // requirement would also have broken the existing "an app for an
      // agent to manage each listing and schedule viewings with buyers"
      // test just below, a genuine real-estate description using none of
      // "real estate"/"apartment"/"rent"/etc. anywhere in the text.
      // Bare "נכס"/"נכסים" (round 2110) is the exact same "genuinely
      // ambiguous whole word" shape round 1828 already fixed for the
      // English "property" -- in Hebrew it's the ordinary general-finance/
      // accounting word for "asset(s)" (balance-sheet assets, intangible
      // assets like patents/IP), not specifically real estate. Confirmed
      // live via matchEntities: a company-assets-and-liabilities-for-
      // financial-reports description and an intangible-IP-assets
      // description each spuriously matched ONLY Property, the real
      // accounting/IP-tracking domain entirely lost. No single adjacent
      // word disambiguates it (the real cue -- "פיננסיים"/"התחייבויות"/
      // "דוחות כספיים" -- is often several words away), so this uses the
      // same document-wide bidirectional-lookaround technique rounds
      // 2107/2109 established: excluded when a financial/IP-asset marker
      // co-occurs anywhere in the text, in either order relative to the
      // keyword.
      "real estate",
      // Round 2240: round 2129's own exclusion list (business/event/
      // episode/market/recruiter) still never covered "service listing(s)"
      // -- an extremely ordinary phrase for any marketplace/directory/
      // freelancer-platform app -- so such a description got a bogus
      // Property entity bolted on alongside the real Service entity
      // (matchEntities returns the union of every matched rule, with no
      // mutual exclusivity, so "service" matching Service doesn't stop
      // "listing" from also matching Property). Confirmed live before
      // fixing: "contractors can post service listings" spuriously
      // matched both Service AND Property.
      /\b(?<!job\s)(?<!product\s)(?<!business\s)(?<!event\s)(?<!episode\s)(?<!market\s)(?<!recruiter\s)(?<!service\s)listing(s)?\b/,
      "apartment for rent",
      // Round 2282: the lookbehind half of this bidirectional exclusion
      // (`(?<![\s\S]*?marker)`) never actually worked -- a JS lookbehind
      // only matches when its own pattern ends EXACTLY at the assertion
      // point, so `[\s\S]*?` followed by the marker can only succeed when
      // the marker itself is the literal text immediately preceding "נכס"
      // (no gap), not "the marker appears anywhere earlier in the text"
      // the way the lookahead's `(?!marker[\s\S]*?)`-style check on the
      // FORWARD side correctly does. Confirmed live: "מערכת לדיווחים
      // פיננסיים על נכסי החברה" (a financial-reporting app, "פיננסיים"
      // one word before "נכסי") still spuriously matched ONLY Property --
      // the real financial/accounting domain entirely lost, exactly the
      // failure mode this exclusion was written to prevent, just for the
      // "marker before" word order instead of "marker after". The correct
      // shape for "marker anywhere before the match" is `marker[\s\S]*`
      // (marker THEN wildcard, ending at the assertion point) -- the same
      // order this file's own courier/font exclusion (above, in this same
      // file) and menu/burger exclusion already use correctly; this entry
      // had the two reversed.
      /נכס(?:ים)?(?![\s\S]*?(?:פיננסי|מוחשי|התחייבויות|מאזן|דוחות\s*כספיים))(?<!(?:פיננסי|מוחשי|התחייבויות|מאזן|דוחות\s*כספיים)[\s\S]*)/,
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
    //
    // Round 2249: round 561's own exclusion list only covered 4 of the
    // many ordinary ways "pupil" is used in its eye-anatomy sense --
    // dilation/size/reaction/response. Confirmed live via the real
    // matchEntities: "A mobile app for photographers to study how pupil
    // contraction changes..." (ONLY ['Student']), "An app that tracks
    // pupil movement during eye exams for an ophthalmology clinic."
    // (ONLY ['Student']), "...measuring pupil diameter changes..."
    // (ONLY ['Student']), and "An app to log pupil color changes after
    // cataract surgery for an eye clinic." (ONLY ['Student']) -- each
    // fabricating a bogus school entity for a vision-science/ophthalmology
    // app with zero connection to education, the real domain entirely
    // lost. Widened the exclusion list with the same 4 reproductions'
    // own immediate-following words (contraction/movement/diameter/
    // color), plus "constriction" (the direct opposite of "dilation",
    // already excluded) for symmetry -- the real school phrasing ("each
    // pupil's attendance", "all the pupils' attendance") has none of
    // these words anywhere near "pupil", confirmed unaffected.
    keywords: [
      "student",
      /\b(?<!dilated\s)pupils?\b(?!\s+(?:dilation|size|reaction|response|contraction|constriction|movement|diameter|color))/,
      "learner",
      // Round 1769: a daycare/preschool/childcare business (an extremely
      // common small-business category in both languages) had no keyword
      // anywhere matching it -- fell through to the degenerate generic
      // "Item" fallback, the same failure class rounds 1700/1708/1720/
      // 1722/1727/1752 already closed for other verticals. This entity's
      // existing field shape (name/email/phone/status: Active|Graduated|
      // OnHold) and description already fit a child enrolled in daycare
      // reasonably well, so widening its own keywords -- the established
      // convention -- rather than inventing a new entity. Bare "nursery"
      // deliberately excluded: it collides with a plant/garden nursery
      // business, so only the full "nursery school" phrase is listed.
      // Bare "daycare" DOES collide with Pet's own "dog daycare" keyword
      // (round 1752) -- a dog-daycare business is about pets, not
      // enrolled children -- so the negative lookbehind excludes only
      // that specific phrase, the same style as this file's other
      // phrase-collision fixes (e.g. "menu"/"dish" above).
      /(?<!\bdog\s)\bdaycare\b/,
      "preschool",
      "childcare",
      "child care",
      "nursery school",
      "kindergarten",
      "תלמיד",
      "תלמידה",
      "תלמידים",
      "סטודנט",
      "סטודנטית",
      "גן ילדים",
      "פעוטון",
      "מעון יום",
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
      /\bcourses\b/,
      // Round 2317: bare "curriculum" collided with the Latin phrase
      // "curriculum vitae" (a CV/resume) -- a job-application/HR/
      // recruiting document, with zero connection to lessons or
      // classes. Confirmed live: a recruiter CV-search app, a job
      // board's CV-submission flow, and an HR system storing employee
      // CVs each fabricated Course (in one case losing the real
      // JobApplicant domain entirely). The lookahead excludes only the
      // "vitae" collocation (optionally hyphenated or with extra
      // whitespace, as in "curriculum-vitae"/"curriculum   vitae");
      // genuine curriculum phrasing, including the compound adjective
      // "curriculum-based" (which has a hyphen but never "vitae" after
      // it), still matches.
      /curriculum(?!\s*-?\s*vitae)/, "שיעורים",
      // Round 2316: bare "קורס"/"קורסים" (the one keyword pair in this
      // entity's whole array with no guard at all) collided with three
      // unrelated senses with zero connection to a course: the ordinary
      // verb "to collapse/crash", in all four conjugations -- masc.sg
      // "קורס", fem.sg "קורסת", masc.pl "קורסים", fem.pl "קורסות" --
      // ("the price/market/building/company is crashing/collapsing"),
      // and "Corsica"/"Corsican". Confirmed live: a stock-price-crash
      // alert app, a market-crash alert, a collapsing-building monitor
      // (and its feminine/plural conjugations), and a Corsica travel
      // guide each fabricated Course as the sole entity. The lookbehind
      // excludes only when one of the confirmed crash-subject nouns
      // (share/shares, stock exchange, structure, building, company,
      // market) sits immediately before the keyword, including through
      // the attached relative pronoun; the lookahead excludes the
      // Corsica derivatives. Deliberately a LOCAL immediately-adjacent
      // check, not a document-wide one: a genuine course description
      // very plausibly names its topic AFTER the keyword (a course in
      // stock trading, in the stock market, in economics), never
      // immediately before it as a bare construct -- confirmed all
      // such phrasings, and the two existing test-fixture sentences,
      // still match. Deliberately did NOT add "price"/"prices" as a
      // crash-subject cue: "the price of an online course" is itself
      // plausible genuine phrasing, so a bare "the price/prices is/are
      // crashing" with no other crash-subject noun nearby remains an
      // open, deliberately deferred gap, the same discipline as the
      // Courier license/insurance gap (round 2311) -- a cue word broad
      // enough to catch it would also catch real course-pricing
      // phrasing.
      /(?<!(?:מניה|מניות|בורסה|מבנה|בניין|חברה|שוק)\s)(?<!(?:מניה|מניות|בורסה|מבנה|בניין|חברה|שוק)\sש)קורס(?:ת|ים|ות)?(?!יק)/,
      // Round 2316: bare "כיתה" also collides with the ordinary Hebrew
      // word for a military "squad" (a combat squad, a squad in basic
      // training), with zero connection to a classroom. Confirmed live:
      // a combat-squad management app and a basic-training-squad
      // tracker each fabricated Course. Scoped NARROWLY to specific
      // structural/organizational military terms (combat/combat-unit,
      // battalion, company (military unit), basic training) that
      // essentially never appear in a genuine classroom-app
      // description. Deliberately did NOT add the more generic "army"/
      // "soldiers"/"soldier"/"commander"/"IDF" -- adversarially tested
      // and confirmed a civics/history class description that
      // genuinely discusses the military (a class learning about
      // military service) would be wrongly excluded by those broader
      // cues, the same unsafe-document-wide-marker pitfall round 2311
      // found for Courier's license/insurance sub-case. That broader
      // military-topic-vs-military-unit ambiguity is left open/
      // deferred rather than force-fixed with an unsafe guard.
      /כיתה(?![\s\S]*?(?:קרבית|קרבי|גדוד|פלוגה|טירונות))(?<!(?:קרבית|קרבי|גדוד|פלוגה|טירונות)[\s\S]*?)/,
      // Round 2314: bare "lesson"/"lessons" collided with three common
      // idioms with zero connection to education -- "teach X a lesson"
      // (moral comeuppance/revenge), "learn(ed) a hard/valuable/...
      // lesson" (life-lesson-from-experience), and "lessons learned"
      // (retrospective/postmortem business jargon). Confirmed live:
      // "He wanted to teach his rival a lesson..." and three similar
      // descriptions each fabricated Course as a spurious entity
      // (sometimes bolted onto a real Product entity, as with the
      // postmortem case), with zero relation to lessons/classes.
      // The idiom always has a person/object between the verb and "a
      // lesson" ("teach HIM a lesson"); genuine literal use never does
      // ("teach a lesson", "teach a quick lesson") -- this distinguishes
      // the two readings without excluding real tutoring phrasing.
      // Deliberately NOT guarding a bare "learn(ed) a lesson" with no
      // evaluative adjective (e.g. "students learn a lesson every
      // week") -- there's no reliable syntactic distinguisher between
      // that and the idiom the way there is for "teach X a lesson" vs
      // "teach a lesson", so the exclusion is scoped narrowly to the
      // specific evaluative-adjective pattern the confirmed collision
      // actually uses, left open rather than force-fixed with an unsafe
      // blanket exclusion (same discipline as the deferred Courier
      // license/insurance gap, round 2311).
      /(?<!\b(?:teach|teaches|teaching|taught)\s+(?:\S+\s+){1,4}a\s)(?<!\b(?:learn|learns|learned|learning)\s+a\s+(?:hard|valuable|difficult|painful|tough|costly|bitter|important|harsh|humbling|good|real)\s)\blessons?\b(?!\s+learned\b)/i,
      // "כיתה" (classroom/class) had no plural entry (round 583). Its
      // plural "כיתות" swaps the word-final ה for ות mid-word, the same
      // construct-state gap shape rounds 576-582 already found elsewhere
      // in this file. A plural-only phrasing matched no Course-specific
      // keyword at all.
      //
      // Round 2318: round 2316 fixed this entity's SINGULAR "כיתה"
      // against the military-squad collision (combat squad/battalion/
      // company/basic-training squad) but missed this plural, a
      // completely separate literal string that inherited none of that
      // guard. Confirmed live: a combat-squad equipment tracker, a
      // battalion-squad roster app, a company-squad tracker, and a
      // basic-training-squad tracker each fabricated Course. Mirrors
      // round 2316's own singular guard exactly, scoped to the same
      // vetted-safe structural/military terms (not the broader "army"/
      // "soldiers"/"commander" cues that round already confirmed unsafe
      // for the singular) -- the same already-deferred military-topic-
      // vs-squad-unit ambiguity applies equally here, left open.
      /כיתות(?![\s\S]*?(?:קרבית|קרבי|גדוד|פלוגה|טירונות))(?<!(?:קרבית|קרבי|גדוד|פלוגה|טירונות)[\s\S]*?)/,
      // Round 1727: this entity's own description reads "A course or
      // class the business teaches," but had no English "class" keyword
      // at all -- flagged but deliberately deferred by round 1708. Bare
      // plural /\bclasses\b/ is safe (no common idiom pluralizes "class"
      // the way "of course"/"golf course" do singular "course"), same
      // plural-is-safe reasoning as "courses" above. Deliberately not
      // adding a singular "class" keyword: it would collide with
      // "world-class"/"first-class"/"middle class"/"weight class"/"asset
      // class"/"class action", none of which have anything to do with a
      // business's course offerings. "class schedule(s)" is added
      // separately so the common singular phrasing ("a weekly class
      // schedule") still matches without touching bare singular "class".
      //
      // Round 2318: that round-1727 reasoning checked IDIOMS but missed
      // a whole category of "<modifier> classes" compound nouns -- the
      // exact same category already excluded for singular "class" above
      // (asset/weight/middle/etc.) turns out to apply to several plural
      // modifiers too. Confirmed live: "drug classes", "tax classes",
      // "storage classes" (cloud/IT), "character classes" (video
      // games), "risk classes" (insurance), "income classes", "asset
      // classes", and "social classes" each fabricated Course, in zero
      // relation to lessons. The lookbehind excludes only these specific
      // confirmed-unambiguous modifiers; "weight classes" is
      // deliberately left OUT -- adversarially confirmed a genuine
      // class-scheduling app (a boxing gym) plausibly uses that exact
      // phrase for real classes organized by weight category, so
      // excluding it would risk a real false negative, while every
      // other guard here is scoped to modifiers that never mean
      // "lessons". The guard is local (the specific modifier
      // immediately before "classes"), not document-wide, so it never
      // costs a real hit as long as any other "classes"/Course keyword
      // occurrence exists in the same description.
      /(?<!\b(?:asset|drug|medication|tax|storage|character|risk|income|social|economic)\s)\bclasses\b/, /\bclass schedules?\b/,
      // Round 1992: "שיעור" is a true Hebrew homograph, the same
      // grammatical-polysemy shape round 890's "ביקורת" (audit/review) fix
      // and round 1982's "משוב" (feedback/"excellent") fix already closed
      // for this file -- the identical spelling also means "rate"/
      // "proportion" (a statistic, e.g. "שיעור ריבית" = interest rate,
      // "שיעור המס" = tax rate, "שיעור האבטלה" = unemployment rate, "שיעור
      // הצלחה" = success rate), with zero connection to a lesson/class this
      // entity exists to represent. Confirmed empirically via the real
      // HeuristicSpecProvider before fixing: an interest-rate calculator, an
      // unemployment-rate tracker, a tax-rate calculator, and an employee-
      // attrition-rate analyzer each produced a spurious Course entity (with
      // its own schedule/instructor/price fields) via this bare substring,
      // for an app with nothing to do with lessons. Fixed the same way round
      // 890's "ביקורת" fix was: a negative lookahead excluding only the
      // specific rate co-occurrences actually found (`ה?` optional since
      // Hebrew's definite article can attach directly to the following
      // noun, e.g. "שיעור המס"), not a word-boundary (Hebrew has no `\b`).
      // Every real standalone lesson use -- "שיעור פרטי", "שיעור יוגה", "כל
      // שיעור", a bare "שיעור בבית ספר" -- still matches, confirmed
      // empirically after fixing; "שיעורים" (plural) is a separate keyword
      // entry, untouched.
      //
      // Round 2314: this same "שיעור" keyword also collides with the
      // Hebrew "give X a lesson" idiom ("לתת ל-X שיעור" = teach X a
      // lesson/comeuppance, nothing to do with education), the exact
      // same shape as the English "lesson"/"lessons" fix just above.
      // Confirmed live: "הוא רצה לתת לשכן שלו שיעור..." (he wanted to
      // teach his neighbor a lesson) and "אני אתן לו שיעור..." (I'll
      // teach him a lesson) both fabricated Course. The added lookbehind
      // excludes only "<give-verb> ל<object> ... שיעור" (an object
      // between the verb and "שיעור"); a literal lesson always lacks
      // that ל-object ("המורה נתן שיעור" = the teacher gave a lesson,
      // confirmed still matching).
      //
      // Round 2328: round 2314's give-verb alternation
      // (לתת/אתן/תיתן/ייתן/נתן/נתנה/נתנו) covers the infinitive, future
      // (1st/2nd/3rd singular), and 3rd-person past (he/she/they-or-we
      // gave) -- but never 1st-person-singular past ("נתתי" = I gave),
      // 2nd-person-singular past ("נתת" = you gave), or 2nd-person-plural
      // past ("נתתם"/"נתתן" = you-pl gave), the same "missing grammatical
      // person" gap shape already found twice this window in Vendor's
      // רכש guard (round 2326) and Donation's תרם guard (round 2327).
      // Confirmed live: "נתתי לשכן שלי שיעור שהוא לא ישכח..." (I gave my
      // neighbor a lesson he won't forget), "אתה נתת לו שיעור..." (you
      // gave him a lesson), and "אתם נתתם לצוות היריב שיעור..." (you-pl
      // gave the rival team a lesson) all fabricated Course via this
      // same comeuppance idiom. Unlike רכש/תרם (lookahead-gated idioms,
      // where a shared optional-suffix group lets the engine backtrack
      // to a vacuous zero-width alternative and vacuously satisfy the
      // lookahead), this guard is a lookbehind gated by a mandatory,
      // non-optional "ל"+whitespace continuation: a naive merged
      // "נתת(?:י|ם|ן)?" variant was tested and does NOT reintroduce the
      // backtracking pitfall here, since the letter left over after a
      // skipped optional suffix (ם/ן/י) can never itself satisfy that
      // mandatory ל/whitespace gate. Independent alternatives are kept
      // anyway to match this file's established defensive convention.
      //
      // Round 2344: round 2328's give-verb alternation still only ever
      // covered the infinitive, future, and past tense -- PRESENT
      // tense (נותן/נותנת/נותנים/נותנות) and the IMPERATIVE mood
      // (תן/תני/תנו) were never added at all, the same "entire tense/
      // mood missing outright" shape round 2343 just found on
      // Donation's תרם guard. Confirmed live: "הוא נותן לשכן שלו
      // שיעור..." (he's teaching his neighbor a lesson, present tense)
      // and "תן לשכן שלך שיעור..." (teach your neighbor a lesson!,
      // imperative) both fabricated Course via this same comeuppance
      // idiom. The present-tense forms are safe as bare literals the
      // same way נתן/נתנה/נתנו already are: "נותן" ends in the sofit
      // nun (ן) while "נותנת"/"נותנים"/"נותנות" all continue with the
      // ordinary nun (נ), so no branch can prefix-match a longer one.
      // The imperative forms needed their own extra guard, though:
      // bare "תן"/"תני"/"תנו" are each themselves a substring of
      // unrelated, far more common words ("ניתן" = possible/given,
      // "מתן" = giving (noun), "אתנו" = with us, "נתנו" = they gave,
      // "תנור" = oven) whenever a Hebrew letter sits directly before
      // them. Each is gated with "(?<![א-ת])" so it only fires when it
      // actually starts a word, confirmed empirically this excludes
      // all of the above collisions while still catching every "תן/
      // תני/תנו ל-X ... שיעור" idiom sentence.
      //
      // Round 2353: this guard was extended round-by-round (2314, 2328,
      // 2344) for many person/number/gender/tense combinations of
      // "give" but, like Vendor's ספק guard before round 2352 fixed
      // it, never covered the 2nd-person-FEMININE-singular FUTURE form
      // "תתני" ("you[f] will give"). The "-י" suffix makes it a
      // distinct string from "תיתן" (2ms/3fs future) -- and critically,
      // it is NOT already caught by the existing bare "תני" alternative
      // either, because that one is deliberately guarded with
      // "(?<![א-ת])" to require nothing but a word boundary right
      // before it, and "תתני" has a Hebrew letter ("ת") immediately
      // before its own "תני" suffix. Confirmed live: "את תתני לשכן
      // הבעייתי שיעור שהוא לא ישכח" (you[f] will teach the problematic
      // neighbor a lesson he won't forget -- comeuppance idiom, zero
      // educational content) wrongly fabricated Course. Adds "תתני" as
      // a new alternative; confirmed live this doesn't affect the
      // existing "תני"/"תיתן" entries or any genuine lesson sentence.
      //
      // Round 2355: the 1st-person-PLURAL future of לתת ("we will
      // give") is "ניתן" -- but unlike every other missing-form gap
      // found in rounds 2352/2353, this one could not simply be added
      // as a bare literal, because "ניתן" is ALSO an extremely common,
      // unrelated Hebrew word meaning "possible/available" (e.g. "ניתן
      // לרכוש..." = "it's possible to acquire..."). That's almost
      // certainly why it was never added earlier. Confirmed live: "אנחנו
      // ניתן לשכן הבעייתי שיעור שהוא לא ישכח" (we will teach the
      // problematic neighbor a lesson he won't forget, in a neighbor-
      // management app) wrongly fabricated Course. The fix gates on
      // "אנחנו ניתן" (the pronoun "we" immediately before "ניתן") as a
      // single unit: this is unambiguous, since the "possible" sense of
      // "ניתן" is a passive participle that agrees in number with its
      // subject -- a plural subject like "אנחנו" would require the
      // agreeing plural form "ניתנים", never the bare singular "ניתן".
      // Confirmed live this leaves the bare "ניתן" business sentences
      // ("ניתן לרכוש..."/"ניתן להזמין...") and genuine "אנחנו ניתן שיעור"
      // sentences with no ל-object between the verb and שיעור (so the
      // idiom shape doesn't apply) all correctly unaffected, as does
      // "אנחנו ניתנים" (the correctly-agreeing plural form, a different
      // string entirely).
      //
      // Round 2356: this guard still missed the 2nd/3rd-person-PLURAL
      // FUTURE forms of לתת -- "תתנו" ("you-all will give") and "ייתנו"
      // ("they will give"). Neither is a plain oversight nor a
      // homograph-collision case like round 2355's "ניתן" (both strings
      // have no common unrelated meaning); it's simply a gap in the
      // future-plural slice, the same shape rounds 2347 (Vendor ספק)
      // and others already closed for their own guards. Critically,
      // "תתנו" is NOT already caught by the existing bare
      // "(?<![א-ת])תנו" alternative: that alternative requires NO
      // Hebrew letter immediately before "תנו", but in "תתנו" the
      // character right before "תנו" is "ת" -- a Hebrew letter -- so
      // the negative lookbehind blocks it, confirming this is a real,
      // distinct gap. Confirmed live: "אתם תתנו לשכן הבעייתי שיעור שהוא
      // לא ישכח" (you-all will teach the problematic neighbor a lesson
      // he won't forget) and "הם ייתנו לשכן הבעייתי שיעור שהוא לא
      // ישכח" (they will teach him a lesson), same comeuppance idiom,
      // zero educational content, both wrongly fabricated Course.
      /(?<!(?:לתת|אתן|תיתן|תתני|תתנו|ייתן|ייתנו|נותנות|נותנים|נותנת|נותן|נתן|נתנה|נתנו|נתתי|נתתם|נתתן|נתת|אנחנו\s+ניתן|(?<![א-ת])תנו|(?<![א-ת])תני|(?<![א-ת])תן)\s+ל\S*(?:\s+\S+){0,3}\s)שיעור(?!\s*ה?(?:ריבית|מס|אבטלה|הצלחה|נשירה|תחלופה|צמיחה|תמותה|ילודה|החזר|אינפלציה|תפוסה|תגובה|המרה))/,
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
    //
    // Round 888: a THIRD, distinct shape no `\b` boundary or substring fix
    // can touch -- the singular "patient" is also an ordinary English
    // ADJECTIVE ("calm, able to wait"), a correctly-spelled, `\b`-bounded
    // whole word with a completely unrelated meaning from the medical
    // noun this entity is about (e.g. "train reps to be patient with
    // frustrated customers during calls" for a plain support-ticketing
    // app). Unlike pitfall 1b's two-separate-words idiom (Deal's removed
    // "pipeline"), this is the SAME single word carrying two unrelated
    // meanings (grammatical polysemy) -- word boundaries can't help,
    // since the adjective spelling and the noun spelling are identical.
    // The plural "patients" is unambiguous (English adjectives never take
    // an -s plural), so it keeps its own unconditional regex. The
    // singular is narrowed to exclude only the specific idiomatic shapes
    // the adjective actually appears in: directly after a copula/
    // intensifier that's only grammatical before an adjective (be/being/
    // been/stay/staying/remain/remaining/very/so/quite/extremely/
    // incredibly/too), or directly before " with" ("patient with
    // customers/them/each other", the standard "tolerant of" idiom this
    // adjective is almost always used in) -- neither excludes any real
    // medical phrasing ("a patient visit", "patient records", "manage
    // patients"), confirmed empirically before fixing.
    //
    // Round 2247: round 888's own two exclusions only covered the adjective
    // directly after a copula/intensifier, or directly before " with" --
    // they never covered its equally common ATTRIBUTIVE use, directly
    // BEFORE a person/role noun ("a patient tutor", "a patient and friendly
    // piano teacher", "a patient customer support team", "a patient and
    // encouraging coach") -- the single most natural way to use this
    // adjective to describe a person in English. Confirmed live: "We're
    // looking for a patient tutor to help kids with math homework." matched
    // ['Patient'], fabricating a medical-care entity for an ordinary
    // tutoring app with zero connection to healthcare, the identical
    // catch-all-losing severity round 888's own comment above describes.
    // Added a lookahead excluding a short list of common non-medical
    // person/role nouns (optionally preceded by "and" plus more
    // adjectives) appearing shortly after "patient" -- deliberately NOT a
    // blanket "a/an patient" exclusion, which would wrongly kill the real
    // medical noun-adjunct phrasings ("a patient visit", "a patient
    // encounter") this entity must still match.
    //
    // Round 2248: round 2247's own fix only handles "patient" immediately
    // followed by whitespace -- both of its lookaheads need `\s+` right
    // after the word to even attempt matching. When "patient" is instead
    // stacked with a second adjective via a comma, directly before an
    // ABSTRACT noun rather than a person ("a patient, methodical approach
    // to software consulting", "a patient, step-by-step process"), there's
    // no whitespace immediately after "patient" at all, so both existing
    // lookaheads vacuously pass and the keyword matches anyway. Confirmed
    // live: "Our business has a patient, methodical approach to software
    // consulting projects..." matched ['Patient', 'Project'], fabricating a
    // medical entity for a plain consulting-firm description. Added a
    // third lookahead for this specific comma-adjective-abstract-noun
    // shape, deliberately scoped to AT MOST one intervening word between
    // the comma and the noun (matching only the confirmed repro's own
    // shape) rather than an unbounded chain, since a wider bound risks
    // wrongly excluding a genuine medical sentence that happens to mention
    // one of these nouns several words after an unrelated comma (e.g. "a
    // patient, admitted via the triage process, was transferred" --
    // confirmed this one still matches correctly with the tighter bound).
    keywords: [
      /\bpatients\b/,
      /(?<!\b(?:be|being|been|stay|staying|remain|remaining|very|so|quite|extremely|incredibly|too)\s)\bpatient\b(?!\s+with\b)(?!\s+(?:\S+\s+){0,3}(?:tutor|teacher|coach|instructor|mentor|driver|employee|manager|rep|staff|team)\b)(?!,\s*\S+\s+(?:approach|process|method|strategy|way)\b)/,
      "outpatient", "clinic patient",
      // Round 2336: unlike nearly every other Hebrew keyword in this file,
      // "מטופל"/"מטופלת"/"מטופלים" were listed completely unguarded. This
      // is the exact same grammatical-polysemy shape round 888 already
      // fixed for the ENGLISH "patient" (adjective "calm" vs. noun
      // "patient"), never applied to the Hebrew side: "מטופל"/"מטופלת"/
      // "מטופלים" is the passive-participle adjective of טיפל ("to
      // handle/deal with/take care of"), routinely used in ordinary
      // administrative "this request/complaint/case is being handled"
      // phrasing with zero medical connection -- e.g. "הפנייה מטופלת",
      // "התלונה מטופלת", "התיק מטופל", "הבקשה מטופלת", "הנושא מטופל".
      // Confirmed live: a customer-support ticketing app ("כל פנייה
      // מטופלת על ידי נציג שירות..."), a complaints-tracking system
      // ("כל תלונה מטופלת תוך 24 שעות..."), and a legal case-management
      // app ("כל תיק מטופל על ידי עורך דין אחד...") each fabricated a
      // bogus Patient entity (fields name/email/phone/dateOfBirth/notes)
      // with zero medical content.
      //
      // Hebrew has no \b (same reason this file's other guards need
      // lookbehind/lookahead instead), so this excludes the specific
      // administrative cue nouns -- bare or with the ה-definite-article
      // prefix -- immediately before "מטופל"/"מטופלת"/"מטופלים". A
      // genuine medical "מטופל"/"מטופלת" occurrence is unaffected,
      // confirmed including the SAME adjective used in its medical sense
      // ("המטופל מטופל על ידי הרופא לאחר הניתוח" -- the patient is being
      // treated by the doctor after the surgery -- still matches via the
      // leading "המטופל" noun occurrence) and a case where the cue noun
      // follows rather than precedes the keyword ("כל מטופל מקבל תיק
      // רפואי אישי" -- unaffected, since the guard only excludes the cue
      // noun immediately BEFORE the keyword).
      //
      // Deliberately a leaky denylist, not an exhaustive fix, same class
      // as this file's other narrow cue-list guards (e.g. round 2027's
      // ספק guard, round 2334's צדקה guard): confirmed two residual gaps
      // that still leak, both accepted trade-offs for the confirmed-live
      // common cases this closes -- (1) a ב-prefix variant of the cue
      // noun ("בנושא מטופל כרגע") isn't excluded, since the lookbehind
      // only checks for a bare or ה-prefixed cue noun; (2) a cue noun
      // outside this curated list (e.g. "הבעיה מטופלת", problem, rather
      // than case/complaint/request/ticket/topic) also isn't excluded.
      /(?<!(?:^|\s)(?:תיק|תלונה|פנייה|בקשה|נושא|התיק|התלונה|הפנייה|הבקשה|הנושא)\s)מטופל(?:ת|ים)?/,
    ],
    labelHe: "מטופלים",
    descriptionHe: "מי שמקבל טיפול רפואי מהעסק.",
    // Round 1655: same gap as Courier just above (see its own comment) --
    // Patient had no email field or label either, unlike every other
    // person-type entity in this file.
    fieldLabelsHe: { name: "שם", email: "אימייל", phone: "טלפון", dateOfBirth: "תאריך לידה", notes: "הערות רפואיות" },
    entity: {
      name: "Patient",
      description: "A person receiving medical care from the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: false },
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
      //
      // Round 2308: \b-bounding only fixed the "projector" substring --
      // "project"/"projects" is also the ordinary business-English VERB
      // "to project" (forecast/convey), as in "project revenue"/"project
      // cash flow"/"project confidence"/"project earnings", with zero
      // client-work-management content. Confirmed live: "A tool that
      // helps public speakers project confidence..." and three similar
      // forecasting/coaching sentences all fabricated a Project entity,
      // with several losing the app's real domain entirely. Guarded with
      // a lookahead excluding the specific forecasting/coaching objects
      // confirmed to collide, the same bare-overly-broad-word shape
      // rounds 2297/2300-2307 already fixed elsewhere in this file.
      /\bproject(s)?\b(?!\s+(?:revenue|cash\s*flow|growth|confidence|earnings|sales|costs?|authority|an?\s+image|calm(?:ness)?|voice)\b)/,
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
    //
    // Round 2289: "משימה"/"משימות" above cover the bare singular and
    // plural, but not Hebrew's own construct-state ("סמיכות") inflection
    // -- the same pitfall #2 this file's own header warns about, already
    // fixed for Appointment's "פגישת"/"מספרת" (rounds 2287-2288) but
    // missed here. "משימה" (ending ה) becomes "משימת" (ending ת)
    // immediately before a following noun, e.g. "משימת ניקיון" ("cleaning
    // task") or "משימת פיתוח" ("development task") -- an everyday,
    // idiomatic way to describe exactly the to-do item this entity exists
    // for, and "משימת" is not a substring of either bare form, so it
    // silently escaped this hint. Confirmed via the real matchEntities:
    // "אפליקציה לניהול משימת ניקיון לעובדים" (an app to manage employees'
    // cleaning tasks) matched only Employee, with the real Task domain
    // entirely lost, while the bare-plural twin ("...משימות לעובדים")
    // already matched both Employee and Task.
    keywords: [/\btasks?\b/, "todo", "to-do", "action item", "משימה", "משימות", "משימת"],
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
      // Round 1979: "car(s)" is an entirely ordinary synonym for
      // "vehicle(s)" -- a description that only ever says "cars" ("an
      // app for my auto repair shop to track customers and cars") and
      // doesn't happen to also say "vehicle"/"mechanic"/"garage" matched
      // no domain entity at all. \b-bounded with the same "(s)?" plural
      // handling used throughout this file; unlike "garage", "car" has no
      // common idiomatic phrase it needs to be excluded from (confirmed:
      // \bcar\b correctly leaves "NASCAR"/"scar"/"cargo"/"card" untouched,
      // since none of those have a word boundary before the trailing
      // "s"/"e"/"go"/"d" that would make "car" itself a separate token).
      /\bcars?\b/,
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
      //
      // Round 2291: that round-577 fix never added the construct-plural
      // form "מוסכי" (e.g. "מוסכי העיר", "garages of the city") -- the
      // same sofit-letter-reversion defect class round 2290 found for
      // Employee's "מאמן"->"מאמני" (sofit nun), just a different entity
      // and a different sofit letter (kaf). "מוסכי" uses the same regular
      // kaf as "מוסכים" (not the sofit "ך" of the bare singular), so
      // "מוסך" doesn't match it either -- and "מוסכים" (6 letters) can
      // never be a substring of "מוסכי" (5 letters), the longer keyword
      // can't fit inside the shorter snippet. Confirmed via the real
      // matchEntities: "פלטפורמה להשוואת מוסכי האזור ומחירי תיקונים"
      // matched only the generic Item fallback, with the real Vehicle/
      // garage domain entirely lost, while the bare-plural twin ("...
      // מוסכים...") already matched Vehicle correctly.
      "מוסך", "מוסכים", "מוסכי", "מכונאי", "כלי רכב",
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
      "event planning",
      // Bare "conference" is a substring collision of a different shape
      // than the ones below (pitfall 1b, the idiom-co-occurrence shape
      // Deal's removed "pipeline", Appointment's removed "schedule", and
      // Order's narrowed "order"/"in order to" fix all share): "video
      // conference(s)" and "conference call(s)" are both ordinary phrases
      // for a video-meeting/telehealth/sales-call tool that has nothing to
      // do with planning weddings or trade shows, confirmed with a real
      // repro before fixing ("A tool for scheduling and recording video
      // conferences for remote teams" and "An app to manage video
      // conference calls between doctors and patients" both spuriously
      // matched Event). Unlike "pipeline"/"schedule", bare "conference"
      // can't simply be dropped -- it's this rule's only keyword that
      // matches a plain event/conference-planning description with no
      // "wedding"/"trade show" wording at all, so dropping it would lose
      // real recall. Two independent exclusions, not one joint idiom like
      // Order's "in order to" -- "video " immediately before OR " call(s)"
      // immediately after -- so either one alone (not just their
      // combination) is enough to exclude a match, while a bare
      // standalone "conference" (e.g. "organize a conference every year")
      // still matches.
      //
      // Round 2244: the same two exclusions missed an equally common third
      // phrase in this shape -- "conference room(s)", the ordinary term for
      // office meeting-room infrastructure in a room-booking/scheduling
      // app, with zero connection to planning a wedding or trade show.
      // Confirmed live: "A booking system for conference rooms in our
      // office building" matched ['Appointment', 'Event'], and "An app to
      // reserve conference rooms for meetings" matched ONLY ['Event'] --
      // the generated app ended up entirely about wedding/trade-show
      // planning fields (venue/capacity/Planned-Confirmed-Completed) for
      // what should have been a plain room reservation. Added "room(s)"
      // immediately after "conference" as a third, independent exclusion,
      // mirroring the existing "call(s)" one exactly.
      /(?<!\bvideo\s)\bconference(s)?\b(?!\s*(?:calls?|rooms?)\b)/,
      "wedding", "weddings", "trade show",
      "אירוע", "אירועים",
      // Round 2331: Order's own "הזמנה" exclusion guard a few hundred
      // lines above already names "מסיבה"/"מסיבת"/"מסיבות" (party) and
      // "יום הולדת" (birthday) by name -- the same discovery method as
      // round 2330's "חתונת" fix -- but neither word existed as a
      // positive keyword for Event (or any other entity) at all.
      // Confirmed live: "אפליקציה לתכנון מסיבת יום הולדת עם רשימת
      // אורחים ותקציב" and four similar party/birthday-planning
      // sentences all fell through to the generic `Item` entity with
      // Event entirely missing.
      //
      // Unlike round 2330's "חתונת", bare "מסיבה" is NOT safe to add as
      // a plain string: it's also the common "for a[n] ... reason"
      // idiom (מ + סיבה, "reason"), e.g. "ההזמנה בוטלה מסיבה לא ידועה"
      // (the order was cancelled for an unknown reason), "התפטר מסיבה
      // אישית" (resigned for personal reasons) -- confirmed live this
      // idiom is extremely common in ordinary business-app descriptions
      // and would have been a brand-new false positive. "מסיבה"/
      // "מסיבות" each get their own lookahead excluding the specific
      // reason-qualifying words empirically confirmed to follow the
      // "reason" sense; a naive merged "מסיב(?:ה|ות|ת)" variant sharing
      // ONE lookahead was tested and confirmed to reintroduce the
      // classic backtracking pitfall (the plural "שונות"/"אישיות"
      // reason-continuations aren't in the singular-only shared
      // lookahead, so the engine backtracks past the "ות" suffix and
      // vacuously matches) -- independent branches are required here,
      // not just stylistic. "מסיבת" (construct state, e.g. "מסיבת יום
      // הולדת") and bare "יום הולדת" have no equivalent "reason"
      // collision and need no guard.
      /מסיבה(?!\s*(?:לא\s*ידועה|אישית|טכנית|כלכלית|זו|כלשהי|מסוימת|שונה|אחרת|בלתי\s*ידועה))/,
      /מסיבות(?!\s*(?:שונות|אישיות|טכניות|כלכליות|כלשהן|מסוימות|שלא\s*לשליטתנו))/,
      "מסיבת", "יום הולדת",
      // Bare "כנס" (round 562) is a substring of common כ.נ.ס
      // ("to enter"/"to log in") verb conjugations -- "להיכנס" (to log
      // in), "נכנס" (enters/logs in), "תיכנס"/"מתכנס"/"התכנסות" -- so a
      // plain login-flow description spuriously matched Event. Hebrew
      // has no \b (same reason round 518's "מלאי" and round 527's "חיוב"
      // fixes needed lookbehind/lookahead too), so this excludes the
      // specific known verb-conjugation prefixes directly.
      //
      // Round 1918: that list missed the single most ordinary way to
      // phrase a login step -- the plain future-tense "יכנס"/"ייכנס"
      // ("[the user] will log in"), e.g. "המשתמש יכנס למערכת עם שם
      // משתמש וסיסמה". The character right before "כנס" there is just
      // "י", which none of the five existing lookbehinds (נ/תי/להי/מת/
      // הת) cover, so an ordinary task-tracker/inventory description
      // describing its own login flow this way spuriously fabricated an
      // unrelated Event entity (fields: name/date/venue/capacity/
      // status) into the generated spec. A single `(?<!י)` lookbehind
      // covers both "יכנס" and "ייכנס" (the lookbehind only needs to see
      // the ONE character immediately before "כנס", which is "י" in
      // both spellings), without affecting a genuine standalone "כנס"/
      // "הכנס" (conference) match.
      // Round 2332: round 1918's fix covered every OTHER grammatical
      // person of the future tense (ניכנס/תיכנס/יכנס/ייכנס all happen
      // to have "י" immediately before "כנס") but missed 1st-person-
      // singular future "אכנס" ("I will log in"), whose immediately-
      // preceding character is "א" instead. Confirmed live: "...המשתמש
      // אכנס למערכת עם שם משתמש וסיסמה..." (the user will log in to
      // the system with a username and password) fabricated Event. "א"
      // is never itself a prefix of a genuine standalone "כנס"/"הכנס"
      // (conference) usage (the noun only ever takes ב/ל/ה/מ-type
      // prefixes), confirmed empirically including a composite sentence
      // containing both the login verb and a real conference mention.
      // This guard is a flat chain of same-position fixed-length
      // lookbehinds, not an optional-suffix-plus-lookahead shape, so the
      // backtracking pitfall documented elsewhere in this file (Vendor's
      // רכש, Donation's תרם) doesn't apply here -- confirmed empirically
      // that a naive merged single-lookbehind variant behaves
      // identically to the independent chain.
      //
      // Round 2335: the chain above covers ניכנס/תיכנס/יכנס/ייכנס/נכנס/
      // להיכנס/מתכנס/התכנסות/אכנס, but missed the "ktiv chaser" (vowel-
      // letter-dropped) spelling of the 2nd-person future -- "תכנס"
      // (masc. sing.), "תכנסי" (fem. sing.), "תכנסו" (plural), e.g. "...
      // תכנס למערכת עם שם משתמש וסיסמה..." ([you] will log in to the
      // system with a username and password). This spelling drops the
      // extra "י" that "תיכנס" has, so the character immediately before
      // "כנס" is bare "ת", which none of the existing lookbehinds (all
      // either 0 chars, or a specific 2-char sequence ending in something
      // other than bare "ת") catch -- confirmed live this ordinary,
      // arguably more common-in-casual-UI-copy login phrasing spuriously
      // fabricated an Event entity (fields name/date/venue/capacity/
      // status) into specs for unrelated apps (inventory, task tracker).
      // "ת" is never itself a prefix of a genuine standalone "כנס"/"הכנס"
      // (conference) usage -- Hebrew has no noun-prefix "ת" (unlike
      // ב/ל/מ/ה, which do attach directly to nouns) -- so a bare "(?<!ת)"
      // lookbehind is safe, confirmed empirically including composite
      // sentences containing both the login verb and a real conference
      // mention, and confirmed no regression on "מתכנס"/"להתכנס"
      // (convene/assemble senses), which were already excluded by the
      // pre-existing (?<!מת)/(?<!הת) entries (both still immediately
      // preceded by "ת" as well, so this round's new entry changes
      // nothing about their already-correct exclusion).
      /(?<!נ)(?<!תי)(?<!להי)(?<!מת)(?<!הת)(?<!י)(?<!א)(?<!ת)כנס/,
      // Bare "חתונה"/"חתונות" (round 575) are substrings of "תחתונה"/
      // "תחתונות" ("lower [clothing]"/"underwear", e.g. "הלבשה תחתונה"),
      // an unrelated, common clothing/lingerie term -- "תחתונה" is
      // literally "ת" + "חתונה" letter-for-letter. Hebrew has no \b, so a
      // plain underwear-store description spuriously matched Event. This
      // excludes the specific "ת" prefix directly, same approach as the
      // "כנס" fix just above.
      //
      // Round 2330: this keyword list never had a construct-state
      // (סמיכות) "חתונת" entry at all -- unlike "ה"-ending "חתונה"/
      // "חתונות", "חתונת" ends in "ת" so it's not a substring of either
      // and silently escaped matching entirely (the "missing inflection"
      // pitfall this file's own header already warns about, already
      // fixed for "פגישה"->"פגישת" round 2287, "משימה"->"משימת" round
      // 2289, "הזמנה"->"הזמנת" round 2292 -- Order's own "הזמנה" guard a
      // few lines above even already lists "חתונת" by name in its own
      // exclusion lookahead, proving the gap was already known about
      // elsewhere in this file, just never applied here). Confirmed
      // live: "אפליקציה לניהול חתונת החלומות שלנו..." (app for managing
      // our dream wedding) and "אתר לתכנון חתונת האביב..." (site for
      // planning the spring wedding) both lost Event entirely. Adding
      // "חתונת" with the same "(?<!ת)" lookbehind as its siblings closes
      // this (no "תחתונת" collision exists for the unrelated underwear
      // word, confirmed empirically). A naive merged
      // "(?<!ת)חתונ(?:ה|ות|ת)?" variant was tested and behaves
      // identically to the independent fix -- this guard's "(?<!ת)"
      // sits before the matched word, not gating a lookahead after an
      // optional suffix, so there's no shared-optional-suffix
      // backtracking path here (same shape as round 2328's Course/נתן
      // and round 2329's Vendor/ספק lookbehind guards). Independent
      // literals kept anyway for consistency with this file's
      // established defensive convention.
      /(?<!ת)חתונה/, /(?<!ת)חתונות/, /(?<!ת)חתונת/,
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
    // Round 1752: the original keyword list only ever covered the
    // clinic/grooming phrasing of a pet business -- a dog walking, pet
    // sitting, pet boarding, or dog daycare business (an equally common
    // pet-care-service category) had no keyword anywhere matching it, so
    // it fell through matchEntities' zero-match path straight to the
    // degenerate generic "Item" fallback instead of a real Pet entity.
    // Round 1817: the original "pet grooming" keyword (round 1752) only
    // ever covered that exact phrase -- a dog or cat groomer/grooming
    // business (just as common a pet-care-service category, and usually
    // described by the specific animal rather than the generic word "pet")
    // had no keyword anywhere matching it either. Live-confirmed:
    // `matchEntities("a dog grooming business", false)` and
    // `matchEntities("a cat grooming salon", false)` both produced only the
    // degenerate generic Item fallback -- "pet grooming" never matches as a
    // substring of either (neither contains the word "pet" at all). The
    // Hebrew side already had this covered via round 1752's own "טיפוח
    // כלבים" (dog grooming), just never extended to cats; added the
    // matching "טיפוח חתולים" (cat grooming) for the identical reason.
    // Scoped to full "dog/cat groom(ing/er)" phrases rather than a bare
    // "groom" -- confirmed live that "groom" alone is a substring of
    // ordinary unrelated phrases this entity must not match ("the bride
    // and groom", "groom the product backlog").
    keywords: [
      "veterinary", "vet clinic", "pet owner", "pet grooming", "animal clinic",
      "dog walking", "dog walker", "pet sitting", "pet sitter", "pet boarding", "dog daycare",
      "dog grooming", "cat grooming", "dog groomer", "cat groomer", "pet groomer",
      // Round 2298: "חיית מחמד"/"חיות מחמד" (pet/pets) had no definite-
      // article entries. In a Hebrew construct chain (סמיכות), the
      // definite article "ה" attaches to the SECOND noun, not the first
      // -- the same pattern round 2286 found for "בית הארחה"->"בית
      // ההארחה" and round 2291 found for "מוסך"->"מוסכי" -- so the
      // definite forms "חיית המחמד"/"חיות המחמד" ("the pet"/"the pets",
      // e.g. "חיות המחמד של הלקוחות שלנו", an everyday way to say "our
      // customers' pets") are not substrings of the bare indefinite
      // keywords and silently escaped matching entirely. Confirmed live:
      // "אפליקציה לניהול חיות המחמד של הלקוחות שלנו" and "סלון טיפוח
      // לחיות המחמד של השכונה" both lost the real Pet domain (matching
      // only Customer or the generic Item fallback), while the
      // indefinite twin ("...חיות מחמד...") already matched Pet.
      "חיית מחמד", "חיות מחמד", "חיית המחמד", "חיות המחמד",
      "וטרינר", "וטרינרית", "טיפוח כלבים", "טיפוח חתולים",
      "טיול כלבים", "פנסיון לכלבים",
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
      // Round 1812: every existing English keyword above names a specific
      // rental shape ("equipment"/"tool"/"gear" rental, or "rental
      // business") -- the single most generic, natural phrasing for this
      // category ("bike rental", "party rental", "kayak rental shop")
      // matched none of them and fell through to the degenerate generic
      // Item fallback. \b-bounded against "parental" (a real substring
      // collision: "parental".includes("rental") is true, but no word
      // boundary separates "pa" from "rental" inside it), the same pattern
      // this file's other bare-word fixes already use.
      //
      // A bare Hebrew "השכרה" counterpart was considered and rejected: it
      // is a substring of Property's own "...להשכרה" keyword and of this
      // file's existing Vehicle-fleet-for-rental Hebrew test fixture
      // ("ניהול צי רכבים להשכרה"), so adding it would make a plain
      // apartment-for-rent or vehicle-fleet-for-rental description also
      // match Rental, blurring an entity boundary this file deliberately
      // keeps separate (the same reason WorkOrder deliberately avoids
      // Vehicle's own "מוסך"/"מכונאי" keywords above).
      //
      // Round 2280: that last paragraph's own reasoning ("blurring an
      // entity boundary this file deliberately keeps separate") turns out
      // to already be reachable through the ENGLISH noun form too, not
      // just a hypothetical Hebrew one -- "I own a few rental apartments
      // and rent them out to tenants every year." matched only Rental via
      // this exact bare "rental" noun, Property never firing at all.
      // Given the identical "apartment(s)"/"landlord(s)" exclusion this
      // same round adds to the verb-conjugation regex just below (for the
      // identical underlying ambiguity), applying it here too closes the
      // noun-form sibling of that same gap.
      //
      // Round 2282: the lookbehind half of that round-2280 exclusion
      // (`(?<![\s\S]*?marker)`) never actually excluded anything -- a JS
      // lookbehind only matches when its own pattern ends EXACTLY at the
      // assertion point, so this only ever caught "apartment(s)"/
      // "landlord(s)" appearing with literally nothing between it and
      // "rental", not "anywhere earlier in the text" the way the comment
      // above claimed and the way the forward lookahead correctly checks.
      // Confirmed live: "A landlord with several apartments rents them
      // out to tenants every year." (word order the round-2280 test never
      // happened to exercise) still spuriously matched only Rental, the
      // exact regression round 2280 believed it had closed. Corrected to
      // `marker[\s\S]*` (marker THEN wildcard, ending at the assertion
      // point) -- the same order this file's own courier/font exclusion
      // and menu/burger exclusion already use correctly elsewhere.
      /\brental(s)?\b(?![\s\S]*?\b(?:apartments?|landlords?)\b)(?<!\b(?:apartments?|landlords?)\b[\s\S]*)/,
      // Round 2279: round 1812's own fix just above closed the gap for
      // generic NOUN phrasing ("bike rental"/"party rental") but never
      // covered ordinary verb conjugations of "rent" itself -- the only
      // verb-shaped keyword here is the literal "rent out" infinitive,
      // which doesn't match "rents"/"rented"/"renting". "A bike shop that
      // rents bicycles by the hour." and "A company renting out kayaks and
      // paddleboards to tourists." both fell through to the generic Item
      // fallback, which also silently flips the payments recommendation to
      // "No payments" (Rental is one of heuristic.ts's own
      // BILLING_ENTITY_NAMES). \b-bounded on BOTH sides and requiring one
      // of the three suffixes -- deliberately NOT bare "rent" itself,
      // which is genuinely ambiguous with the unrelated landlord/tenant
      // noun ("collect rent from tenants", "pay their rent on time" --
      // this file's own existing "apartment for sale or rent" test
      // fixture), the same kind of real non-commercial/unrelated-concept
      // counter-example this file already declines to fix elsewhere (see
      // Appointment/Service's own bare-word exclusions). The suffixed
      // forms carry no such ambiguity: "rents"/"rented"/"renting" are
      // unambiguously verb conjugations, never the noun. Confirmed live
      // that the leading \b alone (no lookbehind needed) already rejects
      // "parents"/"parenting" -- there is no word boundary between the
      // "pa" and "rent" inside them, so \brents?\b never reaches the
      // "p-a" prefix at all.
      //
      // Round 2280: that same round-2279 fix checked for collision with
      // the bare real-estate NOUN "rent" (money owed) but never checked
      // for collision with the ordinary real-estate VERB sense of
      // "rents"/"renting"/"rented" itself -- a landlord/apartment-
      // management description is exactly as common a use of these verb
      // forms as the equipment/vehicle-rental sense this fix targeted.
      // Since matchEntities returns the union of every matching rule and
      // Property's own keywords require much more specific phrasing
      // ("real estate"/"apartment for rent"/"listing(s)"), a plain "A
      // landlord who rents apartments to multiple tenants." matched ONLY
      // Rental (itemName/renterName/Reserved-Active-Returned fields) and
      // never Property (address/price/rooms/Sold-Rented fields) at all --
      // the real domain entirely lost, strictly worse than the pre-2279
      // behavior of falling through to the honest generic Item fallback.
      // Confirmed live via matchEntities that every one of five realistic
      // landlord/apartment phrasings matched only Rental before this
      // fix. Excluded via the same document-wide bidirectional-lookaround
      // technique this file's own "נכס" (asset vs. property) regex above
      // already uses: never fires when "apartment(s)"/"landlord(s)"
      // appears anywhere in the text, in either order relative to the
      // match. Deliberately NOT "tenant(s)"/"lease"/"property" -- round
      // 2279's own "renting out storage units to tenants" test fixture
      // uses "tenants" for a genuine equipment/self-storage rental
      // business with no real estate involved at all, so excluding on
      // bare "tenant" would have reintroduced the exact same regression
      // this fix closes, just for a different phrasing. Confirmed live
      // that fixture, and the other three round-2279 positive fixtures,
      // still correctly match Rental after this additional exclusion.
      //
      // Round 2282: same lookbehind-direction bug as the noun regex's own
      // identical fix just above -- `(?<![\s\S]*?marker)` never actually
      // excludes anything, since the lookbehind only matches when its own
      // pattern ends EXACTLY at the assertion point. Corrected to
      // `marker[\s\S]*`. Confirmed live: "A landlord with several
      // apartments rents them out to tenants every year." still
      // spuriously matched only Rental before this fix.
      /\brent(?:s|ed|ing)\b(?![\s\S]*?\b(?:apartments?|landlords?)\b)(?<!\b(?:apartments?|landlords?)\b[\s\S]*)/,
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
    // Round 913: bare "תמיכה"/"תמיכת" is the generic Hebrew root for
    // "support" in general, not specifically customer/ticket support --
    // it's the same word used in "קבוצת תמיכה" (peer support group),
    // "תמיכה נפשית" (emotional/mental-health support), "תמיכה כלכלית"
    // (financial support/aid), and "תמיכת גב" (ergonomic back support),
    // none of which have anything to do with a help desk. Confirmed via a
    // real repro against matchEntities directly: a peer-support-group app
    // and a mental-health-support app each got Ticket as their ONLY
    // entity, the same severity rounds 911/912 already fixed for
    // Deal/Expense. Excludes just these confirmed idioms (a lookbehind
    // for "קבוצת " immediately before, a lookahead for "נפשית"/"כלכלית"
    // immediately after "תמיכה", and "גב" immediately after "תמיכת") --
    // the construct-state "תמיכת לקוחות" (customer support) this entry's
    // own existing test already relies on is untouched, since none of
    // those three exclusions match it.
    keywords: [
      "support ticket", "help desk", "helpdesk", "ticketing system", "customer support",
      /(?<!קבוצת )תמיכה(?!\s*(נפשית|כלכלית))/, /תמיכת(?!\s*גב)/, "כרטיסי תמיכה", "פניות תמיכה", "מוקד תמיכה",
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
      // Round 1690: "membership fee" -- the single most natural English
      // phrase for what a gym/studio/co-working-space business actually
      // charges -- was missing, even though "membership plan" and "member
      // management" (round 1007-era fixes for the same underlying gap)
      // already matched. Without it, a description like "members pay a
      // monthly membership fee" fell through to the generic catch-all
      // entity entirely (no Subscription match at all), and separately
      // got the wrong "No payments" recommendation on buildOpenQuestions'
      // own payment question -- even though the Hebrew equivalent ("דמי
      // חבר") already matched correctly.
      //
      // Round 2300: the bare "subscription" keyword that used to sit
      // here had no guard at all, unlike every other keyword in this
      // array. "Subscription" is a genuinely polysemous whole word --
      // "email subscription" (a newsletter), "YouTube subscription" (a
      // channel), "RSS subscription" (a feed), "podcast subscription"
      // (a show) are all ordinary, extremely common phrasings with zero
      // recurring-billing concept, the same "nonprofit"/round-2297 shape
      // (a bare, overly-broad word in a BILLING_ENTITY_NAMES entity's
      // own keyword list). Confirmed live: "An app to manage email
      // subscription preferences for our weekly newsletter." and three
      // other non-billing "subscription" phrasings all fabricated a
      // Subscription entity and wrongly recommended Stripe. Removed --
      // every genuine recurring-billing description already matches via
      // "membership plan"/"membership fee"/"recurring billing"/
      // "subscription plan"/"member management" instead.
      "membership plan", "membership fee", "recurring billing", "subscription plan", "member management",
      // Round 1708: this very file's own built-in "Fitness studio" example
      // description ("managing memberships and classes...") used the plain
      // plural "memberships" -- a word round 1690's "membership fee"/
      // "membership plan" additions didn't cover, since neither is a
      // substring of "memberships". The bare singular "membership" is a
      // substring of "memberships" too, so one addition covers both.
      // Round 2107: that bare word, with no guard at all, is also the
      // ordinary English noun for ANY enrollment/access concept, not just
      // a recurring-billing business -- "reader memberships" (a library
      // loan tracker) and "member memberships" (a community garden's plot
      // access) both spuriously matched Subscription, and since
      // matchEntities suppresses the generic DEFAULT_ENTITY the moment
      // ANY rule matches, the real domain was lost entirely (confirmed
      // live: both examples returned ONLY ['Subscription'], vs. ['Item']
      // once "membership(s)" alone is removed from the same text). Unlike
      // this file's other collisions, no single local phrase cleanly
      // separates the two readings -- round 1690's own business-type list
      // (gym/studio/co-working-space) is the actual signal, just not
      // always adjacent to the word "membership" itself (e.g. the round-
      // 1708 example's own disambiguator, "fitness studio", sits several
      // words away). So this checks the whole description for ANY of
      // those business/billing cues, in either order relative to
      // "membership(s)" itself, via two forward-only lookaheads (one from
      // each side) rather than a single bounded-distance lookaround.
      //
      // Round 2250: round 2107's own cue list reopened the exact bug class
      // it was meant to close. Since the lookahead's "anywhere in the
      // whole description" reach was intentional (see above), the actual
      // defect was six of the chosen cue words being ordinary, extremely
      // common English vocabulary with zero inherent connection to
      // billing -- "plan(s)" (the ordinary verb "we plan to..."), "pay"/
      // "payment"/"paying" (equally ordinary), "monthly" (any recurring
      // non-billing event), "club" (a book/garden/hobby club has no
      // billing connection at all), and "price"/"pricing" (any inventory
      // or product-pricing app). Confirmed live via the real
      // matchEntities: adding one unrelated sentence like "We plan to add
      // a vending machine too." or "Our book club meets every month to
      // discuss novels." to round 2107's own named library/garden
      // counterexamples flipped them from the correct ['Item'] to
      // ['Subscription'] alone, exactly the catch-all-losing failure round
      // 2107's own comment describes, just reached through a different,
      // unrelated sentence elsewhere in the same description. Removed
      // those six words, keeping only the cues round 2107's own actual
      // named example ("fitness studio") and the still-specific business/
      // billing nouns (fees/dues/studio/gym/fitness/yoga/co-working) that
      // have no comparably common everyday use -- confirmed via several
      // invented counterexamples that none of these remaining six is
      // nearly as prone to appearing in unrelated prose.
      /\bmemberships?\b(?=[\s\S]*\b(?:fees?|dues|studio|gym|fitness|yoga|co-?working)\b)|\b(?:fees?|dues|studio|gym|fitness|yoga|co-?working)\b(?=[\s\S]*\bmemberships?\b)/,
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
      "job applicant", "job application", "recruitment", "candidate tracking",
      // Round 2313: bare "hiring" collided with the British/Australian/NZ
      // sense of "hire" = "rent" -- "camera equipment hiring", "a bike
      // hiring shop", "a van hiring company", "hiring out" party
      // equipment/costumes -- all genuinely about equipment/vehicle
      // rental, with zero connection to recruiting job applicants.
      // Confirmed live: each of these fabricated JobApplicant as a
      // spurious entity (sometimes the sole one), losing the real
      // rental domain. This is the grammatical-polysemy shape (like
      // "client"/"patient"), not a simple substring-in-a-longer-word
      // shape, so a bare `\b` bound alone can't fix it -- "hiring" is
      // already its own correct word in both senses.
      //
      // The lookahead deliberately does NOT exclude every "hiring out"
      // -- a staffing/labour-hire agency "hiring out" tradespeople or
      // temporary workers to businesses is genuine recruiting-domain
      // phrasing (confirmed live: "A staffing agency hiring out skilled
      // tradespeople to building sites." and a labour-hire-company
      // equivalent both correctly match JobApplicant today), so a
      // blanket "hiring out" exclusion would wrongly regress those. The
      // fix distinguishes "hiring out <object>" (rental) from "hiring
      // out <people>" (staffing) by requiring a people/labour noun
      // within a short word window after "out" to keep the match.
      /(?<!\b(?:equipment|camera|van|bike|bicycle|car|scooter|costume|tool|tools|boat|kayak|canoe|tent|marquee|chair|chairs|dress|suit|gear|machinery)\s)\bhiring\b(?!\s+out\b(?!\s+(?:\S+\s+){0,3}(?:workers?|staff|employees?|tradespeople|people|temps?|labou?r)\b))/,
      // Round 1818: "recruitment"/"hiring" were already covered, but the
      // equally common gerund/noun forms a real recruiting-app description
      // actually uses -- "recruiting platform", "recruiting software",
      // "our recruiters" -- matched nothing at all, falling through to the
      // generic Item fallback. Confirmed live: "a recruiting app to track
      // candidates and resumes" matched zero entities before this fix.
      // "recruit"/"recruiting"/"recruiter(s)" don't appear anywhere else in
      // this file's keywords or any existing test-fixture description, and
      // unlike "pipeline" (Deal's own documented collision) there's no
      // ordinary idiom that repurposes "recruiting"/"recruiter(s)" for an
      // unrelated meaning.
      "recruiting", "recruiter", "recruiters",
      // Round 2315: bare "מועמד"/"מועמדים" ("candidate(s)") collided
      // with the political/electoral candidate sense ("מועמד לנשיאות"
      // = presidential candidate, "מועמדים לכנסת" = Knesset candidates,
      // "מועמד לראשות העיר" = mayoral candidate) and the academic sense
      // ("מועמד לדוקטורט" = PhD candidate), with zero connection to a
      // job applicant -- the same grammatical-polysemy shape round
      // 2313's English "hiring" fix closed on this very entity, and the
      // reason the English side deliberately only ever uses the phrase
      // "candidate tracking", never bare "candidate" (see its own entry
      // a few lines above). Confirmed live: a presidential-candidates
      // tracker, a PhD-candidates-in-physics app, and a Knesset-
      // candidates site each fabricated JobApplicant, losing or
      // polluting the real domain. The lookahead excludes מועמד/
      // מועמדים only when immediately followed by "ל" + a political-
      // office or academic-candidacy noun; genuine recruiting phrasing
      // ("מועמדים למשרות פתוחות", "מועמד/ת עם תואר ראשון בהנדסה") never
      // has that immediate collocation, confirmed still matching. Also
      // guards the feminine "מועמדת" form (a political candidate is
      // just as often referred to in the feminine, e.g. "מועמדת
      // לראשות העיר") -- the bare "מועמד" keyword already matched
      // inside it as a substring, so it carried the identical bug.
      //
      // Round 2321: that fix never covered Hebrew's construct-state
      // plural "מועמדי" ("candidates-of"), which drops the "ל"
      // preposition entirely -- e.g. "מועמדי הנשיאות" (the presidential
      // candidates) or "מועמדי המפלגה" (the party's candidates).
      // Confirmed live: a site tracking presidential poll results and a
      // description of a party's election-campaign candidates each
      // fabricated JobApplicant, both with zero recruiting content.
      // "מועמדי" is a 6-letter substring prefix sitting inside both the
      // bare "מועמד" branch (whose "(?!ת)(?!ים)" checks never
      // considered a following "י") and the "מועמדים" branch, so it
      // slipped through undetected by either lookahead, which all
      // expect "ל" + a noun rather than the construct state's bare
      // noun. Fixed with "מועמדי"'s own independent branch and its own
      // full lookahead (construct nouns, with the definite article
      // "ה-" and no "ל", unlike the other branches' "ל"+bare-noun
      // lists), plus a "(?!ם)" guard so it can't be mistaken for
      // "מועמדים"'s own prefix, and "(?!י)" added to the bare branch
      // so it stops swallowing the construct form instead. A shared
      // optional "(?:ים|ת|י)?" suffix group placed outside a single
      // lookahead was tested and confirmed to still wrongly match the
      // construct false positives AND reintroduce round 2315's own
      // feminine-political regression -- the same backtracking pitfall
      // rounds 2315/2318/2319/2320 already hit. Genuine recruiting
      // phrasing ("מועמדים למשרות פתוחות", "מועמדי המשרה הפתוחה",
      // "מועמד/ת עם תואר ראשון") and round 2315's own political/
      // academic exclusions all confirmed still correct.
      //
      // Round 2323: round 2321's "מועמדי" branch fixed the construct-
      // state PLURAL ("מועמדי הנשיאות"), but the "מועמד"/"מועמדת"
      // branches themselves still only ever check for "ל"+noun -- they
      // never got the construct-state SINGULAR case, which drops "ל"
      // the exact same way the plural does: "מועמד הנשיאות" (the
      // presidential candidate), "מועמד ראשות העיר" (the mayoral
      // candidate, masc.), "מועמדת ראשות העיר" (the mayoral candidate,
      // fem.) -- ordinary political-journalism phrasing. Confirmed
      // live: a news site following a presidential candidate's
      // campaign, an app tracking a leading mayoral candidate (masc.),
      // and a news site covering a leading mayoral candidate (fem.)
      // each fabricated JobApplicant. Fixed by giving the "מועמדת" and
      // "מועמד" branches each their OWN second, fully self-contained
      // lookahead -- a full copy of "מועמדי"'s own construct-noun list
      // -- appended after their existing "ל"-lookahead, rather than
      // merging the "ל" and construct checks into one shared lookahead
      // (tested and confirmed a merged/shared version misses some
      // construct cases while still passing others, an unreliable
      // partial fix) -- the same backtracking-adjacent pitfall rounds
      // 2315/2318-2322 keep surfacing: each guard needs its own
      // complete, independent check, not a shared/merged one. Genuine
      // recruiting phrasing, round 2315's feminine political
      // exclusion, and round 2321's plural-construct exclusion all
      // confirmed still correct.
      //
      // Round 2324: a FOURTH grammatical variant of this exact same
      // collision -- the feminine-PLURAL form "מועמדות" ("female
      // candidates" / "candidacy"). Neither the bare "מועמד" branch's
      // "(?!ת)(?!ים)(?!י)" checks nor any other branch ever considered
      // a following "ות", so "מועמדות" slipped through every existing
      // lookahead the same way "מועמדי" (round 2321) and the bare
      // construct-singular (round 2323) did before it. Confirmed live:
      // "מועמדות הנשיאות"/"מועמדות ראשות העיר" (construct) and
      // "המועמדות לנשיאות" (ל-form) each fabricated JobApplicant.
      // Fixed with "מועמדות"'s own independent branch carrying its own
      // full pair of lookaheads (ל-list and construct-list, the same
      // pattern as the other branches), plus "(?!ות)" added to the
      // bare branch so it stops swallowing this form. A shared
      // optional "(?:ות)?" suffix placed before the bare branch's
      // lookaheads was tested and confirmed to still wrongly match all
      // three false positives -- the same backtracking pitfall every
      // one of this guard's three prior fixes (rounds 2315/2321/2323)
      // already hit. Genuine recruiting phrasing (including the
      // genuinely idiomatic "הגשת מועמדות למשרה" = "submitting a
      // candidacy for a position", where "מועמדות" means the abstract
      // noun "candidacy") and every prior round's exclusions confirmed
      // still correct. This is the fourth fix to this one collision in
      // four separate rounds (2315/2321/2323/2324) -- a strong signal
      // that this specific guard rewards an unusually thorough
      // grammatical-variant audit; future rounds finding yet another
      // uncovered form here should not be surprising.
      //
      // Round 2325: a FIFTH gap, this time not a new inflected form of
      // "מועמד" itself but a structural one -- every branch's "ל"
      // lookahead assumed "ל" is immediately followed by the office
      // noun (e.g. "לראש העיר"), but ordinary Hebrew political
      // journalism routinely inserts "תפקיד" (position) or "כהונת"
      // (term/tenure) between them: "מועמד לתפקיד ראש העיר" (candidate
      // for the POSITION OF mayor), "מועמדת לתפקיד נשיאות" (candidate
      // for the POSITION OF the presidency). Confirmed live: a news
      // site following a mayoral-position candidate, an article about
      // a prime-ministerial-position candidate, a site following a
      // female presidential-position candidate, and an article about
      // plural mayoral-position candidates each fabricated
      // JobApplicant. Genuine recruiting phrasing that also happens to
      // contain "לתפקיד" for an ORDINARY job role (e.g. "מועמדים
      // לתפקיד מפתח תוכנה" = candidates for the software-developer
      // position) still correctly matches JobApplicant, since "תפקיד"
      // is immediately followed there by a job title, not one of this
      // guard's political/academic office nouns. Fixed by inserting an
      // optional "(?:תפקיד\s*|כהונת\s*)?" group right after "ל" and
      // before the office-noun list, independently in EACH of the four
      // "ל"-lookahead copies (the construct-state lookaheads, which
      // never use "ל", are untouched). Verified that patching only one
      // branch (e.g. only the plural) while leaving the others
      // unpatched still lets sentences matching those other branches
      // slip through -- each branch's lookahead needs its own copy of
      // the fix, continuing the exact independent-branch discipline
      // established in rounds 2315/2321/2323/2324. Genuine recruiting,
      // the "לתפקיד"-for-an-ordinary-job control, and every prior
      // round's own exclusions all confirmed still correct. This is
      // the FIFTH fix to this one collision across five consecutive
      // rounds (2315/2321/2323/2324/2325).
      /מועמדות(?!\s*ל(?:תפקיד\s*|כהונת\s*)?(?:נשיאות|כנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|דוקטורט|תואר\s*שלישי|פרופסורה|בחירות))(?!\s*(?:הנשיאות|הכנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|הדוקטורט|התואר\s*השלישי|הפרופסורה|הבחירות|המפלגה))|מועמדי(?!ם)(?!\s*(?:הנשיאות|הכנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|הדוקטורט|התואר\s*השלישי|הפרופסורה|הבחירות|המפלגה))|מועמדים(?!\s*ל(?:תפקיד\s*|כהונת\s*)?(?:נשיאות|כנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|דוקטורט|תואר\s*שלישי|פרופסורה|בחירות))|מועמדת(?!\s*ל(?:תפקיד\s*|כהונת\s*)?(?:נשיאות|כנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|דוקטורט|תואר\s*שלישי|פרופסורה|בחירות))(?!\s*(?:הנשיאות|הכנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|הדוקטורט|התואר\s*השלישי|הפרופסורה|הבחירות|המפלגה))|מועמד(?!ת)(?!ים)(?!י)(?!ות)(?!\s*ל(?:תפקיד\s*|כהונת\s*)?(?:נשיאות|כנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|דוקטורט|תואר\s*שלישי|פרופסורה|בחירות))(?!\s*(?:הנשיאות|הכנסת|ראשות\s*העיר|ראש\s*העיר|ראשות\s*הממשלה|ראש\s*הממשלה|הדוקטורט|התואר\s*השלישי|הפרופסורה|הבחירות|המפלגה))/,
      // Round 1536: bare "גיוס" is a substring of the equally ordinary
      // fundraising phrases "גיוס כספים"/"גיוס תרומות" ("raising money"/
      // "raising donations") -- Hebrew overloads this root for both
      // "recruiting people" and "recruiting money" (already noted in the
      // Donation entry's own doc comment below, which left "גיוס כספים"
      // out of ITS keyword list for exactly this reason, but never
      // stopped this bare keyword from matching that phrase in the first
      // place). A nonprofit/fundraising description using this
      // completely idiomatic phrasing spuriously fabricated a
      // candidate-tracking JobApplicant entity. The lookahead excludes
      // only the fundraising senses while still matching every real
      // recruitment phrasing ("גיוס עובדים", "תהליך הגיוס", "גיוס
      // מועמדים").
      /גיוס(?!\s*(כספים|תרומות))/,
      "קורות חיים",
    ],
    labelHe: "מועמדים",
    descriptionHe: "מי שהגיש מועמדות למשרה בעסק.",
    fieldLabelsHe: {
      name: "שם",
      email: "אימייל",
      phone: "טלפון",
      appliedFor: "משרה מבוקשת",
      stage: "שלב",
      appliedDate: "תאריך הגשה",
    },
    enumLabelsHe: {
      stage: { Applied: "הוגשה", Interviewing: "בראיונות", Offer: "הצעה נשלחה", Rejected: "נדחה", Hired: "התקבל/ה" },
    },
    entity: {
      name: "JobApplicant",
      description: "A person who applied for a role at the business.",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
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
    // 1. "גיוס כספים" (fundraising) is left out -- "גיוס" is
    //    JobApplicant's own keyword (recruitment), and Hebrew overloads
    //    that root for both "recruiting people" and "recruiting money".
    //    Round 1536 fixed JobApplicant's own "גיוס" to exclude this
    //    phrase via a lookahead, so the underlying collision is now
    //    closed at its source; this entity's own list still leaves the
    //    phrase out since "תרומה"/"תרומות"/"עמותה" below already cover
    //    the same descriptions without needing it.
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
    //
    // Bare "תרומה"/"תרומות" (round 2111) is true polysemy, not a substring
    // collision between two different words like the pitfalls above --
    // "תרומה" is standard Hebrew for BOTH "charitable donation" and the
    // completely unrelated everyday sense "contribution" (an academic,
    // research, or managerial contribution), the same ambiguity English
    // "contribution" has. Confirmed live via matchEntities: descriptions
    // about a researcher's scientific/academic contribution, a manager's
    // contribution to company results, and a wiki tracking writers'
    // contributions each spuriously matched ONLY Donation. No single
    // adjacent word disambiguates it, so this uses the same document-wide
    // bidirectional-lookaround technique rounds 2107/2109/2110 established:
    // excluded unless an actual donor/nonprofit/charity/blood/organ cue
    // co-occurs anywhere in the text. "דם" (blood) is bounded by Hebrew-
    // letter lookaround rather than left bare, since it's a substring of
    // the common unrelated word "אדם" (person) and would otherwise fire
    // on any description mentioning a person alongside unrelated
    // "contribution" phrasing.
    // Round 2281: every keyword above (donor, donation(s), nonprofit,
    // fundraising campaign, תרומה/תרומות, עמותה/עמותות) is a NOUN form --
    // there was no keyword anywhere matching the bare VERB "donate"/
    // "donates"/"donated"/"donating" itself. "Our charity lets visitors
    // donate money to help animals in need." matched no domain entity at
    // all and fell through to the generic Item fallback, even though
    // donating money/clothes/blood/time to a cause is exactly what this
    // entity exists for. Unlike "rent" (ambiguous with the unrelated
    // real-estate noun) or "class"/"service" (ambiguous bare words this
    // file excludes elsewhere), "donate" has no ordinary unrelated English
    // sense -- confirmed \b-bounded against the one real substring
    // collision this file's own comment above already documents for the
    // sibling noun ("condonation of delay"): "condonation" has no word
    // boundary immediately before its own embedded "donat", so \b already
    // rejects it without any extra lookaround. The Hebrew counterpart was
    // deliberately NOT added in that same round, pending its own careful
    // verification pass (the same discipline round 2280 had to apply
    // after round 2279's own verb-conjugation fix introduced a real
    // regression elsewhere in this file by not checking every sibling
    // form carefully enough).
    //
    // Round 2293: that pass, done. "אפליקציה שמאפשרת למשתמשים לתרום כסף
    // למטרות שונות" (an app that lets users donate money to various
    // causes) matched no entity at all via the real matchEntities/
    // generate() -- confirming the deferred gap was real and still open.
    // The fix turned out simpler than it first looked, once the actual
    // Unicode forms were checked rather than assumed: the bare 3rd-person
    // masc. past "תרם" ends in the SOFIT mem ם (U+05DD), but the fem./
    // plural past forms "תרמה"/"תרמו" and the unrelated words "תרמיל"
    // (backpack) and "תרמית" (fraud/deception -- a real risk in this
    // business-app domain, given this very file's Fraud-adjacent
    // entities) all use the ordinary mem מ (U+05DE) instead, since a
    // letter follows it there. That's a genuine character difference, not
    // just a missing suffix, so the plain literal "תרם" (sofit mem) is
    // NOT a substring of any of them -- confirmed empirically, no
    // lookahead/exclusion needed at all. The infinitive "לתרום" also ends
    // in the sofit mem (nothing follows it) but isn't a substring of the
    // bare past-tense form either (it has a vav before the mem), so it
    // needs its own separate literal. "תורם"/"תורמים" (donor, already
    // excluded above for the Appointment-root collision) are also
    // unaffected: their own plain "תרם" substring check already fails
    // for the same sofit-vs-regular-mem reason ("תורם" has a vav between
    // the resh and mem, same shape as the infinitive).
    keywords: [
      /\bdonations?\b/, "donor", "fundraising campaign",
      // Round 2297: bare "nonprofit" alone -- with no donor/donation/
      // fundraising wording anywhere in the description -- fabricated a
      // Donation entity, which this file's own BILLING_ENTITY_NAMES
      // mechanism then turned into a wrongly-recommended "Stripe"
      // payment provider. Plenty of real nonprofit apps have nothing to
      // do with donations (a volunteer-coordination tracker, a free
      // tutoring program, an advocacy/outreach tool), the same bare-
      // overly-broad-word pitfall BILLING_ENTITY_NAMES's own comment
      // below already explains for why Service/Appointment/Pet/Patient/
      // Case stayed out of that set. Confirmed live: "A nonprofit
      // organization tracking volunteer hours and community outreach
      // events." and "Our nonprofit runs a free after-school tutoring
      // program for kids." both matched Donation and recommended
      // "Stripe" on nothing but the word "nonprofit" itself. Removed;
      // every existing test that matched Donation via "nonprofit" also
      // independently contains "donor(s)"/"donation(s)"/"fundraising
      // campaign", so none regress.
      //
      // Round 2306: this round resolves the open question round 2297
      // left -- the Hebrew "עמותה"/"עמותות" counterpart to English
      // "nonprofit" had the identical bare-overly-broad-word collision.
      // Confirmed live: "אפליקציה לניהול מתנדבים בעמותה ללא כל גיוס
      // כספים." (volunteer management, zero fundraising) and "העמותה
      // שלנו מפעילה תוכנית חינמית לשיעורי עזר לילדים אחרי הלימודים."
      // (a free after-school tutoring program) both matched Donation
      // and wrongly recommended Stripe on nothing but the word "עמותה"
      // itself -- the same failure mode round 2297 fixed for English.
      // Removed, resolving the asymmetry round 2297 deliberately left
      // open. This DOES overturn round 576's own precedent (its test
      // required this exact bare-word match with no donor/תרומה
      // wording) -- that test is revised in this same round to require
      // genuine donation wording alongside עמותה/עמותות instead of
      // relying on the bare word alone, preserving its original
      // plural-inflection coverage via the bidirectional regex below.
      /\bdonat(?:e|es|ed|ing)\b/,
      // Round 2359: the cue-word alternation below (added round 2111,
      // tightened round 2306) only ever listed the ABSOLUTE forms
      // "עמותה"/"עמותות" ("nonprofit"/"nonprofits"), never the
      // construct-state (סמיכות) singular "עמותת" (e.g. "עמותת הילדים" =
      // "the children's nonprofit", "עמותת צדקה" = "charity nonprofit").
      // Since "עמותת" ends in ת, not ה, it is not a substring of
      // "עמותה" and so never unlocked the bidirectional תרומה/תרומות
      // lookaround on its own -- the same construct-state gap shape
      // found on other entities' keywords (rounds 912/2287/2288/2289/
      // 2330/2358 etc.), just never applied to this cue list.
      //
      // Round 2363: the identical gap was never fixed on the SUBJECT noun
      // itself. "תרומ(?:ה|ות)" only ever covered the absolute singular
      // ("תרומה") and absolute plural ("תרומות"), never the construct-
      // state singular "תרומת" (e.g. "תרומת דם" = "blood donation",
      // "תרומת איברים" = "organ donation", "תרומת כספים" = "money
      // donation" -- all extremely common, arguably more natural than
      // the absolute "תרומה של דם" phrasing). Since "תרומת" ends in ת,
      // not ה, it is not a substring of either absolute form, so neither
      // branch of the bidirectional lookaround ever fired, and the whole
      // Donation domain was lost. The cue-gating itself (round 2111's
      // reason this is a lookaround at all, not a bare literal) is
      // unaffected: a construct-state "contribution" sentence with no
      // donor/nonprofit/blood/organ cue word still correctly excludes
      // Donation.
      /תרומ(?:ה|ות|ת)(?=[\s\S]*(?:תורם|תורמים|עמותה|עמותות|עמותת|צדקה|(?<![א-ת])דם(?![א-ת])|איברים))|(?:תורם|תורמים|עמותה|עמותות|עמותת|צדקה|(?<![א-ת])דם(?![א-ת])|איברים)(?=[\s\S]*תרומ(?:ה|ות|ת))/,
      // Round 2322: round 2293's bare verb forms "תרם"/"תרמה"/"תרמו"/
      // "לתרום" only checked that they weren't a substring of unrelated
      // NOUNS (תרמיל "backpack", תרמית "fraud") -- it never checked the
      // verb's own primary, extremely common Hebrew sense: these forms
      // equally mean ordinary "contributed" (to a project's success, to
      // an app improvement, to finishing a task), with no money or
      // charity involved at all. Confirmed live: "העובד החדש תרם רבות
      // להצלחת הפרויקט..." (contributed to the project's success),
      // "התכונה החדשה תרמה רבות לשיפור חווית המשתמש..." (the feature
      // contributed to improving UX), "כל חברי הצוות תרמו מאמץ רב
      // להשלמת המשימה..." (the team contributed effort to finishing the
      // task), and the infinitive "כולם מתבקשים לתרום להצלחת האירוע"
      // (asked to contribute to the event's success) each fabricated a
      // Donation entity with zero charitable content -- and since
      // Donation is in BILLING_ENTITY_NAMES, each also wrongly flipped
      // the payment-provider openQuestion's recommendation to "Stripe".
      // Guarded each form with its own independent, self-contained
      // lookahead excluding "ל" + an abstract success/improvement noun,
      // allowing 0-2 intervening words for the adverbial phrase ("רבות",
      // "מאמץ רב", etc.) -- each form is a separate regex entry (not a
      // shared alternation under one outer lookahead), avoiding the
      // backtracking pitfall rounds 2315/2318-2321 already hit, and
      // matching round 2293's own finding that these forms are mutually
      // exclusive literal strings (sofit mem vs. regular mem) with no
      // risk of one swallowing another's prefix. Genuine donation
      // wording for every form (masc. "העובד תרם כסף רב לעמותה...", fem.
      // "התורמת תרמה תרומה נכבדה...", plural "התורמים תרמו בגדים
      // ישנים...", and infinitive "...לתרום כסף למטרות שונות" -- round
      // 2293's own original motivating sentence) confirmed still
      // matches Donation correctly.
      /תרם(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרמה(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרמו(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /לתרום(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      // Round 2327: the fix above only ever covered 3rd-person verb
      // forms (masc./fem. singular, plural, infinitive) -- it never
      // checked the 1st-/2nd-person forms of the identical verb:
      // "תרמתי"/"תרמנו" (I/we donated) and "תרמת"/"תרמתם"/"תרמתן"
      // (you donated, sing./pl.). Unlike round 2326's Vendor "רכש"
      // case, these forms share no accidental substring overlap with
      // the forms above at all (every suffix changes which Unicode
      // mem -- sofit vs. regular -- appears, so there's no risk of a
      // false match the way "רכש" was a prefix of "רכשו"); the bug
      // here is a pure FALSE NEGATIVE, not a false positive: these
      // persons were simply never recognized as Donation at all.
      // Confirmed live: "אני תרמתי כסף רב בכל שנה..." (I donate a lot
      // of money every year), "אנחנו תרמנו ציוד רפואי..." (we donated
      // medical equipment), "אתה תרמת סכום נכבד..." (you donated a
      // considerable sum), and "אתם תרמתם סכום נכבד..." (you-pl
      // donated a considerable sum) all fell through to the generic
      // Item fallback, losing the Donation domain entirely -- and
      // since Donation is in BILLING_ENTITY_NAMES, each also wrongly
      // flipped the payment-provider recommendation from "Stripe" to
      // "no payments". Added each person as its own independent
      // branch with its own full idiom-exclusion lookahead (longest/
      // most-specific literal first, same pattern as round 2326's
      // Vendor fix); "תרמת" excludes a following "ם"/"ן"/"י" so it
      // can't mistake "תרמתם"/"תרמתן"/"תרמתי"'s prefix for itself. A
      // naive merged regex sharing one lookahead across a suffix
      // alternation (e.g. "תרמ(?:ת|תי|תם|תן|נו)(?!...)") was tested
      // and confirmed to wrongly match the idiom-exclusion sentences
      // too (e.g. "תרמתם רבות להשלמת המשימה") -- the same backtracking
      // pitfall round 2326 just reconfirmed for Vendor, here on
      // Donation's own idiom guard.
      /תרמתם(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרמתן(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרמתי(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרמנו(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרמת(?!ם)(?!ן)(?!י)(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      // Round 2333: all of the above only ever covers the PAST-tense
      // verb תרם ("donated"). The entire PRESENT-tense paradigm --
      // תורם/תורמת/תורמים/תורמות -- was never added as a keyword in any
      // form, even though these same four words are also the literal
      // Hebrew nouns "donor"/"female donor"/"donors"/"female donors"
      // (Hebrew present-tense verbs double as agent-noun participles).
      // Tellingly, "תורם"/"תורמים" already appear by name inside this
      // very entity's own "תרומה"/"תרומות" disambiguation regex above
      // (used only as cue words to unlock THAT keyword) but were never
      // themselves promoted to standalone keywords -- the "named but
      // missing as its own positive keyword" shape rounds 2330/2331
      // found via another entity's exclusion list, here found within
      // the same entity instead. Confirmed live: "אפליקציה לניהול
      // התורמים של העמותה שלנו..." (app to manage our nonprofit's
      // donors) and three similar donor-management sentences all fell
      // through to the generic Item/Project fallback, losing Donation
      // entirely -- and since Donation is in BILLING_ENTITY_NAMES, each
      // also wrongly flipped the payment recommendation from Stripe to
      // "no payments".
      //
      // Same idiom collision as the past-tense verb (round 2111/2322):
      // all four present-tense forms are also the ordinary, very common
      // metaphorical "contributes" with zero charitable-giving content
      // ("הכלי תורם לשיפור התפוקה" = the tool contributes to improving
      // output), so each form reuses this entity's own already-tested
      // idiom-exclusion lookahead. Each form is its own independent
      // regex entry, not a shared alternation: "תורם" ends in the SOFIT
      // mem (ם) while "תורמת"/"תורמים"/"תורמות" all continue with the
      // ordinary mem (מ) instead, so "תורמים".includes("תורם") is
      // literally false in JS -- confirmed empirically that a naive
      // merged "תורם(?:ת|ים|ות)?(?!...)" variant doesn't just risk the
      // usual backtracking pitfall, it fails to match three of the four
      // forms outright, since the base literal doesn't even occur as a
      // substring of them (the same sofit-vs-regular-mem fact round
      // 2293 already established for the past-tense תרם/תרמה pair, now
      // reconfirmed for the present-tense paradigm).
      /תורם(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תורמת(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תורמים(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תורמות(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      // Round 2343: rounds 2111/2322/2327 covered the PAST tense (all
      // persons) and round 2333 covered the PRESENT-tense participle
      // (תורם/תורמת/תורמים/תורמות), but neither ever touched the FUTURE
      // tense or the IMPERATIVE mood of the same verb. Since Donation IS
      // a member of BILLING_ENTITY_NAMES below, this wasn't just a missed
      // entity -- a genuine future/imperative donation description wrongly
      // flipped the payment-provider recommendation from "Stripe" to "בלי
      // תשלומים" (no payments). Confirmed live: "אני אתרום כסף רב למען
      // הילדים החולים..." (1st-person future: I will donate) and "תרמי
      // כסף רב עוד היום למען הילדים החולים..." (2nd-person-feminine-
      // singular imperative: donate!) both failed to produce a Donation
      // entity at all -- a pure false NEGATIVE (omission), unlike every
      // other round's idiom-collision false POSITIVE on this file. Each
      // new form reuses this entity's own already-tested idiom-exclusion
      // lookahead verbatim (the same metaphorical "contributes to X"
      // idiom applies in every tense/mood: "הכלי יתרום לקידום המטרה" =
      // the tool will contribute to advancing the goal). Independent
      // branches per form, as always, not a merged suffix group.
      //
      // The bare imperative "תרמי" branch also needed its own
      // collision guard: it is a literal 4-character prefix of BOTH
      // "תרמילים"/"תרמיל" (backpack/backpacks) and "תרמית" (fraud) --
      // caught empirically by this file's own pre-existing collision
      // test for this entity (round 2293's "תרם"/"תרמילים"/"תרמית"
      // guard test), which started failing the moment this branch was
      // added without it. Excludes "ל" and "ת" directly after "תרמי"
      // the same way other branches in this file exclude a longer
      // form's own next letter.
      /אתרום(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תתרום(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תתרמי(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /יתרום(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /נתרום(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרום(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      /תרמי(?!ל)(?!ת)(?!\s+(?:\S+\s+){0,2}ל(?:הצלחת|שיפור|פיתוח|צמיחת|ניצחון|השלמת|קידום|יישום|התפתחות|הישג|הישגי))/,
      // Round 2334: "צדקה" (charity) is named as a cue word inside this
      // entity's own "תרומה"/"תרומות" disambiguation regex above (used
      // only to help disambiguate THAT keyword) but was never itself
      // promoted to a standalone keyword -- the same "named but missing
      // as its own positive keyword" shape rounds 2330/2331/2333 already
      // found elsewhere. Confirmed live: "אנחנו אוספים צדקה למשפחות
      // נזקקות..." (we collect charity for needy families) and "...קופת
      // צדקה עבור יתומים..." (a charity fund for orphans) both fell
      // through to the generic Item fallback, losing Donation entirely
      // and -- since Donation is in BILLING_ENTITY_NAMES -- flipping the
      // payment recommendation from Stripe to "no payments".
      //
      // "צדקה" is NOT safe as a bare substring: it's also the ordinary
      // feminine 3rd-person-singular PAST TENSE of צדק ("to be right"),
      // e.g. "הלקוחה צדקה בטענתה שהמוצר היה פגום" (the customer WAS
      // RIGHT in her claim that the product was defective) -- confirmed
      // live this idiom is unrelated to charity. A blanket "(?!\s*ב)"
      // exclusion is too broad: it would wrongly exclude genuine charity
      // phrasing where an unrelated "ב"-word happens to follow (e.g.
      // "...לצדקה בכל חודש..." = to charity every month), and a blanket
      // "(?!\s*כש)" exclusion would wrongly exclude "...צדקה כשיטת
      // חיים..." (charity as a way of life) -- confirmed both empirically
      // before choosing this fix. Instead, this excludes only the
      // specific "was right in/about X" and "was right when X claimed/
      // feared/..." continuations, naming the claim/stance/suspicion-type
      // nouns the idiom actually takes (same shape as this file's other
      // idiom-exclusion guards, e.g. Donation's own תרם/תורם fixes
      // above). Like round 2027's own ספק guard, this is a deliberately
      // leaky denylist for an idiom with many possible continuations,
      // not an exhaustive fix -- a stance noun outside this list (e.g.
      // "...צדקה בניחושה...") can still slip through; the common,
      // confirmed-live repro cases are what this closes.
      /צדקה(?!\s*ב(?:טענת|טענתה|טענתו|תלונת|תלונתה|תלונתו|עמדת|עמדתה|עמדתו|תביעת|תביעתה|תביעתו|דרישת|דרישתה|דרישתו|חשד|חשדה|חשדו|הערכת|הערכתה|הערכתו|תחזית|תחזיתה|תחזיתו|הנחת|הנחתה|הנחתו|החלטת|החלטתה|החלטתו|גישת|גישתה|גישתו|ניתוח|ניתוחה|ניתוחו|פרשנות|פרשנותה|פרשנותו|קביעת|קביעתה|קביעתו|דעת|דעתה|דעתו|חששות|חששותיה|חששותיו|ציפיית|ציפייתה|ציפייתו)\S*)(?!\s*כ(?:ש|אשר)\s*(?:טענ|אמר|חשש|הזהיר|ציפ|דאג)\S*)/,
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
      // Round 1814: the entity's own name ("Shipment") and the single most
      // natural word for describing it ("track shipments", "create a
      // shipment") was never in its own keyword list -- only the narrower
      // "shipping"/"logistics"/"warehouse management"/"package tracking"/
      // "freight" phrases were. A description naming the entity's own
      // fields directly ("track shipments... with a carrier and
      // destination") matched none of them and fell through to Customer
      // only (via the bare "customer" keyword) or the generic Item
      // fallback. Collision-free: not a substring of "worshipping" (the
      // existing "shipping" collision), "membership", or "dealership" --
      // confirmed live.
      /\bshipments?\b/,
      // Round 2340: bare "שילוח" was listed completely unguarded. Beyond
      // its logistics/freight sense, "שילוח" is also the current, common
      // Hebrew bureaucratic/media term for deportation/expulsion (e.g.
      // "מתווה השילוח" -- the well-known migrant-deportation policy term
      // -- and phrases like "שילוח מהגרים"/"שילוח מסתננים"/"שילוח
      // פליטים"), with zero logistics connection. Confirmed live: "...
      // ניהול הליכי שילוח מהגרים לא חוקיים מהמדינה" (managing deportation
      // proceedings of illegal migrants), "...שילוח מסתננים לארץ
      // שלישית..." (deportation of infiltrators to a third country), and
      // "...תיקי שילוח פליטים מהארץ" (refugee-deportation case files) all
      // matched ONLY Shipment, fabricating trackingNumber/carrier/
      // destination/shipDate fields for apps with zero logistics content.
      //
      // Hebrew has no \b, so this excludes the specific deportation
      // object-nouns that follow the word in this sense (same
      // leaky-denylist convention as round 2339's מספרת guard) --
      // confirmed empirically against both existing test fixtures that
      // genuine shipping/logistics usage, including at the end of a
      // sentence with no following word, still matches. Deliberately a
      // leaky denylist, not an exhaustive fix: a bare abstract usage with
      // no following object noun at all (e.g. "מתווה השילוח" -- the
      // deportation POLICY itself) or an object noun outside this list
      // would still slip through, an accepted trade-off for the
      // confirmed-live common cases this closes.
      /שילוח(?!\s*(?:מהגרים|המהגרים|מסתננים|המסתננים|פליטים|הפליטים|עובדים זרים|העובדים הזרים|אזרחים|תושבים))/,
      "לוגיסטיקה", "ניהול מחסן", "מעקב חבילות",
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
    //
    // Round 2027: that denylist was never exhaustive -- it only covered
    // the "undoubtedly"/"in doubt" idioms, not the equally common "doubt
    // whether" shape ("יש ספק אם"/"קיים ספק אם"/"מטיל ספק"/"מעלה ספק"),
    // so a project description like "יש ספק אם הפרויקט יסתיים בזמן"
    // ("there's doubt whether the project will finish on time" -- nothing
    // about vendors) still spuriously matched and built an unwanted
    // Vendor entity/screen, confirmed live. Adding "מטיל"/"מטילה"/"מעלה"
    // as further unambiguous-doubt-only lookbehinds (no vendor-sense
    // parse exists for "casts/raises a supplier") and a lookahead
    // excluding "ספק" immediately followed by "אם" (the one grammatically
    // reliable "doubt whether" marker -- "supplier if" doesn't parse in
    // Hebrew either) closes the specific repro without excluding genuine
    // singular vendor mentions like "יש לנו ספק טוב" or "קיים ספק אחד
    // בלבד". Other, rarer "doubt" phrasings without "אם" immediately
    // after (e.g. "קיים ספק מסוים") can still slip through -- this
    // remains a leaky denylist for an extremely productive Hebrew word,
    // not an exhaustive fix.
    //
    // Round 2329: round 2027's own warning above proved correct -- the
    // "מטיל"/"מעלה" lookbehinds only covered the 3rd-person-SINGULAR
    // "casts/raises doubt" forms, never the 3rd-person-PLURAL forms
    // "מטילים"/"מטילות" (they cast doubt, masc./fem.) or
    // "מעלים"/"מעלות" (they raise doubt, masc./fem.) -- the same "missing
    // grammatical person/number" gap shape already found three times
    // this window on completely different idiom guards (Vendor's own
    // רכש guard round 2326, Donation's תרם guard round 2327, Course's
    // נתן guard round 2328), this time recurring within Vendor itself on
    // an unrelated root. Confirmed live: "החברים מעלים ספק גדול בנוגע
    // לתוכנית..." (the members raise great doubt about the plan) and
    // "המנהלים מטילים ספק כבד בנוגע לפרויקט..." (the managers cast heavy
    // doubt about the project) both fabricated Vendor with zero
    // procurement content; the existing "(?!\s*אם)" lookahead doesn't
    // depend on the preceding verb's person, so only the "אם"-less
    // plural phrasings slipped through. Adding the four plural
    // lookbehinds closes this without regressing round 2027's own
    // singular exclusions or genuine vendor usage. As in round 2328, a
    // naive merged "(?<!מטיל(?:ה|ים|ות)? )" / "(?<!מעל(?:ה|ים|ות) )"
    // variant was tested and does NOT reintroduce the backtracking
    // pitfall here (same lookbehind-with-mandatory-connector shape) --
    // independent alternatives are kept anyway for consistency with this
    // file's established defensive convention.
    //
    // Round 2341: round 2329's own fix covered the 3rd-person-PLURAL
    // PRESENT-tense forms of these idiom verbs, but neither round 2027
    // nor round 2329 ever covered the corresponding PAST-tense forms --
    // הטיל/הטילה/הטילו ("cast doubt", masc./fem./plural) and
    // העלה/העלתה/העלו ("raised doubt", masc./fem./plural) -- which are at
    // least as common in realistic business prose as the present tense.
    // Confirmed live: "המנכ"ל הטיל ספק רב בהצלחת התוכנית העסקית..." (the
    // CEO cast great doubt on the business plan's success) and "המנהל
    // העלה ספק משמעותי לגבי לוח הזמנים..." (the manager raised
    // significant doubt about the timeline), among four other
    // person/gender/number combinations, all fabricated a Vendor entity
    // with zero procurement content. A second, smaller gap found at the
    // same time: "כל" inserted between the negation word and "ספק"
    // ("ללא כל ספק"/"אין כל ספק"/"בלי כל ספק" -- "without any doubt") was
    // never covered either, since the existing lookbehinds require the
    // idiom word to sit immediately before "ספק". Adding the six missing
    // past-tense lookbehinds plus the three "כל"-inserted negation
    // lookbehinds closes all nine confirmed-live repro cases without
    // regressing any of rounds 2027/2329's existing exclusions or
    // genuine vendor usage. Same unmerged-lookbehind convention as
    // rounds 2328/2329 for consistency.
    //
    // Round 2345: round 2341 covered present and past tense of the
    // "casts/raises doubt" idiom but, just like Donation's תרם (round
    // 2343) and Course's שיעור (round 2344), never covered an entire
    // TENSE outright -- future tense (יטיל/תטיל/נטיל/אטיל ספק = "will
    // cast doubt", יעלה/תעלה/נעלה/אעלה ספק = "will raise doubt") was
    // completely absent. Confirmed live: "המנהל יטיל ספק רב בתוכנית
    // המכירות בשבוע הבא" (the manager will cast great doubt on the
    // sales plan next week) and "הוועדה תעלה ספק משמעותי לגבי התקציב
    // בפגישה הקרובה" (the committee will raise significant doubt about
    // the budget), among five other person combinations, all
    // fabricated Vendor with zero procurement content. Adds the eight
    // missing future-tense lookbehinds (1st/2nd/3rd person singular,
    // both roots).
    //
    // Round 2347: round 2345's own residual-gap note above was closed
    // this round -- future-tense PLURAL forms (יטילו/תטילו/יעלו/תעלו)
    // did still leak, exactly as predicted, since the singular
    // lookbehinds' fixed literals ("יטיל "/"תטיל "/"יעלה "/"תעלה ")
    // can never match the different five/six characters immediately
    // before "ספק" in the plural forms ("טילו "/"עלו " etc.).
    // Confirmed live: "חברי הוועד יטילו ספק רב בהצלחת המיזם בשבוע
    // הבא..." (the committee members will cast great doubt on the
    // project's success) and "הבוחנים יעלו ספק משמעותי לגבי איכות
    // המוצר..." (the examiners will raise significant doubt about the
    // product's quality), among two other person/root combinations,
    // all fabricated Vendor with zero procurement content. Adds the
    // four missing plural-future lookbehinds, same unmerged
    // independent-branch convention as every other guard in this
    // file.
    //
    // Round 2352: round 2345's future-tense fix covered 1st/2nd-masc/
    // 3rd-masc singular (אטיל/תטיל/יטיל/נטיל, אעלה/תעלה/יעלה/נעלה) but
    // never the 2nd-person-FEMININE-singular future forms, which take a
    // distinct "-י" suffix -- "תטילי" ("you[f] will cast doubt") and
    // "תעלי" ("you[f] will raise doubt"). Neither is a substring of the
    // already-listed "תטיל "/"תעלה " (the extra "י" sits before the
    // trailing space), so sentences using them fell straight past the
    // guard. This exact -י suffix form is already handled elsewhere in
    // this file for the same bug class (e.g. Donation's "תתרמי", round
    // 2343) -- it was simply never propagated to this guard. Confirmed
    // live: "את תטילי ספק רב בהצלחת התוכנית בשבוע הבא" (you[f] will
    // cast great doubt on the plan's success) and "את תעלי ספק משמעותי
    // לגבי התוכנית הכספית בפגישה" (you[f] will raise significant doubt
    // about the financial plan) both fabricated Vendor with zero
    // procurement content. Adds the two missing 2fs-future lookbehinds.
    keywords: [
      "vendor", "vendors", "supplier", "suppliers", "procurement",
      /(?<!ללא )(?<!אין )(?<!בלי )(?<!ללא כל )(?<!אין כל )(?<!בלי כל )(?<!מוטל ב)(?<!מטיל )(?<!מטילה )(?<!מטילים )(?<!מטילות )(?<!הטיל )(?<!הטילה )(?<!הטילו )(?<!יטיל )(?<!תטיל )(?<!תטילי )(?<!נטיל )(?<!אטיל )(?<!יטילו )(?<!תטילו )(?<!מעלה )(?<!מעלים )(?<!מעלות )(?<!העלה )(?<!העלתה )(?<!העלו )(?<!יעלה )(?<!תעלה )(?<!תעלי )(?<!נעלה )(?<!אעלה )(?<!יעלו )(?<!תעלו )ספק(?!ות)(?!\s*אם)/,
      "ספקים",
      // Round 2309: bare "רכש" is the correct noun for "procurement"
      // ("ניהול רכש"), but it's also the ordinary 3rd-person-masc. past-
      // tense VERB "acquired", used in extremely common idioms like
      // "רכש ניסיון" (acquired experience), "רכש מיומנויות" (acquired
      // skills), "רכש מוניטין" (acquired a reputation) -- none about
      // buying from a vendor. Confirmed live: an employee-development
      // description using "העובד רכש מיומנויות ניהול חדשות..." and a
      // similar "רכש ניסיון" sentence both fabricated a Vendor entity
      // with zero procurement content. Guarded with a lookahead
      // excluding the specific "acquired-X" idiom objects confirmed to
      // collide (handling both masc. "רכש" and fem. "רכשה" forms),
      // the same bare-overly-broad-word shape rounds 2297/2300-2308
      // already fixed elsewhere in this file.
      //
      // Round 2320: that fix never covered the 3rd-person-PLURAL past-
      // tense form "רכשו" ("they acquired"), e.g. "המתמחים רכשו
      // מיומנויות ניהול חדשות..." (the interns acquired new management
      // skills) or "העובדים רכשו ניסיון רב..." (the employees acquired
      // extensive experience) -- confirmed live, both fabricated Vendor
      // with zero procurement content. Because "רכש" is a 3-letter
      // prefix of "רכשו" too, the masc.-singular branch's "(?!ה)"
      // lookahead only rules out the feminine ending; it says nothing
      // about a following "ו", so it was matching the first 3 letters
      // of "רכשו" as if it were the lone singular verb, with its idiom
      // lookahead starting right after those 3 letters -- where the
      // next character is "ו", not whitespace -- so the idiom object
      // was never seen and the match wrongly went through.
      //
      // Fixed by giving "רכשו" its own independent branch with its own
      // full idiom lookahead, rather than adding "(?:ו)?" as a shared
      // optional group before/outside the masc. branch's lookahead --
      // the same backtracking pitfall rounds 2315/2318/2319 already hit:
      // a shared optional group can backtrack to its zero-width
      // alternative and trivially satisfy the now-irrelevant lookahead,
      // reintroducing the exact bug being fixed (confirmed empirically:
      // "רכש(?:ו)?(?!ה)(?!\s*idiom)" still wrongly matches "רכשו
      // ניסיון..."). The masc.-singular branch also now excludes "ו"
      // directly after "רכש" so it can never again mistake the plural's
      // prefix for itself.
      //
      // Round 2326: the guard still only covered 3rd-person forms
      // (masc./fem. singular, plural). It never checked the OTHER
      // grammatical persons of the same "acquired-X" idiom: 1st-person
      // singular/plural ("רכשתי"/"רכשנו" = I/we acquired) and
      // 2nd-person singular/plural ("רכשת"/"רכשתם"/"רכשתן" = you
      // acquired). Confirmed live: "אנחנו רכשנו ניסיון רב בניהול
      // פרויקטים מורכבים..." (we acquired experience), "במהלך העבודה
      // רכשתי ניסיון רב בתחום שירות הלקוחות..." (I acquired
      // experience), "אתה רכשת ניסיון רב בתפקיד הקודם..." (you
      // acquired experience), and "אתם רכשתם ניסיון רב בעבודת
      // הצוות..." (you-pl acquired experience) all fabricated Vendor
      // with zero procurement content. Each person gets its own
      // independent branch with its own full idiom lookahead (longest/
      // most-specific literal first so e.g. "רכשתם" is tried before
      // the bare "רכשת" prefix matches it). The masc.-singular "רכש"
      // branch now also excludes "ת" and "נ" directly after it (in
      // addition to the existing "ה"/"ו") so it can never mistake any
      // longer inflected form's prefix for itself, and the 2nd-person-
      // singular "רכשת" branch excludes "ם"/"ן"/"י" directly after it
      // for the same reason relative to "רכשתם"/"רכשתן"/"רכשתי". A
      // shared merged regex using one optional suffix group
      // ("רכש(?:תי|תם|תן|נו|ת|ה|ו)?(?!\s*idiom)") was tested and
      // confirmed to not only fail on all four new idiom sentences but
      // also reintroduce TWO already-fixed regressions (rounds 2309's
      // fem. singular and round 2320's plural) -- the same
      // backtracking pitfall this file keeps rediscovering, this time
      // shown to be even more damaging than previously documented.
      //
      // Round 2342: even after round 2326 covered all 8 person/number/
      // gender combinations of the PAST tense, one form was still
      // missing: 2nd-person-feminine-singular with the "י" suffix,
      // which covers BOTH the imperative ("רכשי!" = "acquire!") and the
      // future ("תרכשי" = "you[f] will acquire") when read without the
      // future-tense "ת" prefix stripped. Confirmed live: "רכשי ניסיון
      // רב בתפקיד הקודם..." (imperative: acquire experience) and
      // "...תרכשי ניסיון רב בתחום השירות..." (future: you[f] will
      // acquire experience) both fabricated Vendor with zero
      // procurement content. The gap existed because the bare "רכש"
      // branch's lookahead chain excluded "ה"/"ו"/"ת"/"נ" (to avoid
      // mistaking a longer form's prefix for itself) but never added
      // "י" -- and there was no dedicated "רכשי" branch the way every
      // other person/number form already had one. Fixed the same way
      // as round 2326: an independent "רכשי" branch with its own full
      // idiom lookahead, plus "(?!י)" added to the bare "רכש" branch's
      // existing lookahead chain so it still can't mistake "רכשי"'s
      // prefix for itself. This is the SAME guard being re-patched a
      // second time in this file's history (rounds 2309, 2320, 2326,
      // now 2342) -- reinforcing round 2341's lesson that even a guard
      // already fixed more than once is not guaranteed to have its full
      // grammatical paradigm covered.
      /רכשתם(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכשתן(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכשתי(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכשנו(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכשת(?!ם)(?!ן)(?!י)(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכשי(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכשו(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכשה(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|רכש(?!ה)(?!ו)(?!ת)(?!נ)(?!י)(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))/,
      // Round 2346: the 9 branches above only ever matched the literal
      // 3-letter contiguous substring "רכש" (with various suffixes).
      // True Hebrew future tense of the same root inserts a vav
      // between כ and ש -- ארכוש (I will acquire), תרכוש (you m./she
      // will acquire), ירכוש (he will acquire), נרכוש (we will
      // acquire) -- so "רכוש" is never a substring of "רכש" and these
      // four forms were structurally unreachable by any existing
      // branch. Confirmed live: "נרכוש ציוד משרדי חדש לחברה..." (we
      // will acquire new office equipment), "המנהל ירכוש חומרי גלם
      // נוספים..." (the manager will acquire more raw materials),
      // "אתה תרכוש את הציוד הדרוש בעצמך..." (you will acquire the
      // needed equipment), and "אני ארכוש מכונות חדשות למפעל..." (I
      // will acquire new machines) all matched no Vendor at all, with
      // zero "ספק" substring anywhere, despite being unambiguous
      // future-tense procurement language. (The OTHER future-tense
      // forms -- תרכשי/תרכשו/ירכשו, which drop the vav before a
      // suffix -- already worked by coincidence, since they contain
      // the existing רכשי/רכשו literals as substrings.) The same
      // "acquire-X" idiom collision that motivated rounds
      // 2309/2320/2326/2342's lookaheads on the past-tense forms is
      // equally natural in future tense -- confirmed live, "אני ארכוש
      // ניסיון רב..."/"אתה תרכוש ניסיון רב..."/"העובד ירכוש ניסיון
      // רב..."/"אנחנו נרכוש ניסיון רב..." all read as genuine Hebrew
      // idiom sentences with zero procurement content -- so each new
      // branch gets its own full idiom lookahead, same unmerged-
      // branch convention as every other guard in this file.
      // Substring-collision checked against the standalone noun
      // "רכוש" (property/assets, e.g. "ניהול רכוש", "רכוש רב") and the
      // existing "לרכוש" (infinitive) fixture -- no collision, since
      // none of these phrasings ever put א/ת/י/נ directly, with no
      // space, before "רכוש".
      /ארכוש(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|תרכוש(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|ירכוש(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))|נרכוש(?!\s*(?:ניסיון|ידע|מיומנויות|מוניטין|תארים|הרגלים|השכלה|ביטחון))/,
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
    // "הוצאה"/"הוצאות" (expense/expenses). The entry's own original
    // comment only ever checked this against every OTHER keyword's root
    // for a substring collision (pitfall 1) -- it never checked pitfall
    // 1b, the idiom-co-occurrence shape rounds 869-871/888-890/911 each
    // found a new instance of. "הוצאה" is a real, correctly-spelled
    // standalone word, but it's also the first half of two unrelated,
    // extremely common Hebrew idioms: "הוצאה לאור" (publishing house,
    // literally "bringing to light") and "הוצאה לפועל" (the debt-
    // collection/enforcement office, "Hotza'a LaPo'al"). Confirmed via a
    // real repro against matchEntities directly: a publishing-house app
    // description got Expense as its ONLY entity (the real domain
    // entirely lost, round 880's own "menu" severity), and a debt-
    // collection-office app got a bogus Expense alongside the real Case
    // entity. Round 912's fix: exclude "הוצאה"/"הוצאות" when immediately
    // followed by " לאור"/" לפועל" (JS's own `\b` doesn't recognize
    // Hebrew word characters at all, so this file's other Hebrew
    // exclusions -- e.g. "תפריט"/"שליח" above -- use a bare lookahead the
    // same way, not a `\b`-bounded one).
    //
    // Round 2358: this keyword list only ever covered the absolute
    // singular/plural "הוצאה"/"הוצאות", never the construct-state
    // (סמיכות) singular "הוצאת" ("the expenditure/outlay of ..."),
    // used in ordinary phrasing like "הוצאת הכספים"/"הוצאת התקציב"/
    // "הוצאת המשכורות" -- the same construct-suffix-inflection gap this
    // file has found many times on other entities (עמותה, פוליסת
    // ביטוח, and others). Confirmed live: "אפליקציה למעקב אחר הוצאת
    // הכספים של העסק שלנו" and "המערכת עוזרת לנו לתעד את הוצאת התקציב
    // החודשי" both lost the Expense entity entirely (fell through to
    // the generic Item fallback). A bare "הוצאת" literal is NOT safe to
    // add, though: this root (י-צ-א) is unusually polysemous, and
    // "הוצאת X" very commonly means something unrelated to a business
    // expense -- "הוצאת ספרים" (publishing house, the construct-form
    // sibling of the already-excluded "הוצאה לאור" idiom), "הוצאת
    // דיבה"/"הוצאת לשון הרע" (defamation/slander), "הוצאת צו" (issuance
    // of a court order), "הוצאת רישיון" (issuance of a license), "הוצאת
    // ילד מהבית" (child-protective-services removal). Fixed instead by
    // allowlisting only the specific money/budget/payroll nouns that
    // actually co-occur with the expense sense, with an optional
    // definite-article "ה" on the second noun in the construct chain.
    // Confirmed live this closes the 3 bug sentences above without
    // reopening any of the 5 idiom collisions just listed, nor
    // affecting the existing "הוצאה לאור"/"הוצאה לפועל" exclusions or
    // the bare-plural control.
    keywords: [
      "expense", "expenses", "expense tracking", "business expenses",
      /הוצאה(?!\s*לאור|\s*לפועל)/, /הוצאות(?!\s*לאור|\s*לפועל)/, "מעקב הוצאות",
      /הוצאת\s+(?:ה)?(?:כספים|כסף|תקציב|משכורות|משכורת)/,
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
    //
    // Round 890: "ביקורת"/"ביקורות" are true Hebrew homographs, the same
    // grammatical-polysemy shape rounds 888/889 fixed for "patient"/
    // "client" -- the identical spelling also means "audit" (an internal/
    // financial/regulatory-compliance process, e.g. "ביקורת פנים" =
    // internal audit, "ביקורת חשבונות" = accounting audit, "ביקורת
    // תקנים"/"ביקורת איכות"/"ביקורת בטיחות" = standards/quality/safety
    // audit), with zero connection to customer feedback. An unguarded
    // bare substring match fired on the audit sense exactly as readily
    // as the review sense (confirmed empirically before fixing: a
    // company-internal-audit description, an accounting-audit
    // description, and a regulatory/standards-audit description all
    // produced only `[Review]`, fabricating a star-rating/moderation
    // entity for an app with nothing to do with customer reviews). Fixed
    // with a single regex covering both the singular and plural root
    // (the plural replaces the final ת with ות, so "ביקורת" is NOT a
    // substring of "ביקורות" -- same ת→ות shape round 576's "עמותה"/
    // "עמותות" fix needed, confirmed these are two separate keyword
    // strings in the pre-fix code above), excluding only the specific
    // audit co-occurrences actually found. "ביקור" (visit) alone, with
    // neither the ת nor ות suffix, still correctly never matches.
    //
    // Round 1982: bare "משוב" is itself a literal 4-letter prefix of the
    // ordinary, extremely common Hebrew adjective "משובח"/"משובחת"/
    // "משובחים"/"משובחות" ("excellent"/"praised" -- as in "מוצרים
    // משובחים", "שירות משובח", "יינות משובחים"), an unrelated word used
    // constantly in product/quality/marketing descriptions with zero
    // connection to collecting customer feedback. Hebrew has no `\b` (the
    // same reason round 518's "מלאי" and this same block's own "ביקורת"
    // fix above needed a lookahead/lookbehind too), so an unguarded bare
    // substring match fired on the "excellent" sense exactly as readily
    // as the real feedback sense -- confirmed empirically before fixing:
    // "אתר המציג יינות משובחים מהיקב שלנו" (a site presenting our
    // winery's excellent wines) produced only `[Review]` via the real
    // matchEntities, the same "real domain entirely lost" severity round
    // 880's own "menu" finding and this block's own "ביקורת" audit fix
    // above already document. A single `(?!ח)` lookahead excludes exactly
    // the "excellent" inflections (all four start with "משובח") while
    // still matching every real standalone use ("משוב מלקוחות", "איסוף
    // משוב", the plural "משובים"), confirmed empirically after fixing.
    // Round 2109: bare "דירוג" ("ranking/rating") is ordinary Hebrew for
    // ANY ranking -- a sports/tournament leaderboard, a credit rating, an
    // SEO/search-engine ranking, an employee-performance ranking -- none
    // of which have anything to do with customer feedback. Confirmed
    // empirically via the real matchEntities: "אפליקציה לניהול טבלת
    // דירוג של שחקנים בטורניר" (a tournament leaderboard app) and
    // "אפליקציה לדירוג אשראי של לווים" (a borrower credit-rating app)
    // both returned ONLY [Review], the real domain entirely lost -- the
    // same severity as this block's own "ביקורת"/"משוב" audits above.
    // Unlike those two, no single local lookaround separates the
    // readings (a bare ranking has no one adjacent word that always
    // marks it as customer feedback), so this requires a customer/
    // product/service/star-rating cue to co-occur ANYWHERE in the text,
    // the same document-wide technique round 2107 used for the English
    // "membership" collision -- "דירוג לקוחות"/"דירוג כוכבים למוצרים"/
    // "דירוג שירות" still match correctly either way around.
    keywords: [
      "customer review", "customer feedback", "product review",
      // Round 2310: bare "testimonial" is the correct word for a
      // customer testimonial, but it's also standard legal/courtroom
      // jargon for a category of evidence ("testimonial evidence" vs.
      // documentary/physical evidence) or a type of statement
      // ("testimonial statements" from confrontation-clause doctrine),
      // with nothing to do with customer feedback. Confirmed live: "A
      // courtroom case-management app to track testimonial evidence
      // versus physical evidence for each case." and a similar
      // deposition-tracking sentence both fabricated Review as the
      // SOLE entity, entirely losing the app's real case-management
      // domain. Not a bare deletion: "A landing page to showcase
      // testimonials from our clients." depends solely on this word,
      // with no other Review keyword present. Guarded with a lookahead
      // excluding the specific legal collocations confirmed to
      // collide, the same bare-overly-broad-word shape rounds
      // 2297/2300-2309 already fixed elsewhere in this file.
      /\btestimonials?\b(?!\s+(?:evidence|statements?|privilege|immunity))/,
      /ביקור(?:ות|ת)(?!\s*(?:פנים|פנימית|חשבונות|תקנים|תקן|איכות|בטיחות|מס|רגולטורית|חוקית))/,
      "חוות דעת", /משוב(?!ח)/,
      // Round 2360: the cue-word alternation below (added round 2109) only
      // ever listed the absolute singular "מסעדה" ("restaurant"), missing
      // both its construct-state singular "מסעדת" (e.g. "מסעדת הדגים" =
      // "the fish restaurant") and its plain plural "מסעדות" -- "מסעדה" is
      // a substring of neither (ה vs ת in construct state, ה vs ו in the
      // plural), so the cue search never recognized them. Same gap shape
      // as round 2359's Donation fix, found on a different disambiguation
      // guard's cue-word list.
      /דירוג(?=[\s\S]*(?:לקוח|מוצר|שירות|כוכב|מסעדה|מסעדות|מסעדת))|(?:לקוח|מוצר|שירות|כוכב|מסעדה|מסעדות|מסעדת)(?=[\s\S]*דירוג)/,
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
      "קריאת שירות", "קריאות שירות", "עבודת תחזוקה",
      // Round 2303: bare "טכנאי" had the identical collision its English
      // sibling /\btechnician(s)?\b/ (fixed in this same round, see the
      // comment below) did -- "טכנאי רפואי" (medical technician), "טכנאי
      // מעבדה" (lab technician), "טכנאי שיניים" (dental technician) are
      // all common, genuinely unrelated clinical/lab professions. In
      // Hebrew the qualifying word follows "טכנאי" rather than preceding
      // it as in English, so a lookahead exclusion is used instead of a
      // lookbehind one -- confirmed live against the same false-positive
      // shape, and confirmed the existing bare-"טכנאי" test (round 1811,
      // "קריאות שירות לטכנאי מזגנים") still passes via its other keyword
      // "קריאות שירות", unaffected by this guard.
      /טכנאי(?!(?:ם)?\s?(?:רפואי|רפואית|רפואיים|מעבדה|מעבדתי|שיניים|קול|שידור|וטרינרי|וטרינריים))/,
      "אינסטלטור", "חשמלאי",
      // Round 1931: a locksmith is the exact same kind of licensed
      // field-service trade this block's own round-1811 doc comment already
      // names ("plumbers, electricians, appliance/AC technicians,
      // handymen"), but was never added -- "a locksmith business tracking
      // jobs and customers" matched no WorkOrder keyword at all and fell
      // through to the generic Customer fallback. "locksmith"/"מנעולן" have
      // no other common meaning (unlike "gym"/"clinic"/"service"), so this
      // is not the bare-ambiguous-word pitfall this file's header warns
      // against.
      "מנעולן", "מנעולנים",
      // "עבודת תחזוקה" (maintenance job) had no plural entry (round 581).
      // Its plural "עבודות תחזוקה" swaps the word-final ה for ות mid-word,
      // the same construct-state gap shape rounds 576-580 already found
      // for "עמותה", "פוליסת ביטוח", and "דירה למכירה"/"דירה להשכרה". A
      // plural-only phrasing matched no WorkOrder-specific keyword at all.
      "עבודות תחזוקה",
      // Round 1811: the entity's own design intent (see the comment above)
      // explicitly names "plumbers, electricians, appliance/AC technicians,
      // handymen", but only their Hebrew nouns ("טכנאי"/"אינסטלטור"/
      // "חשמלאי") were ever added -- the identical business described in
      // English ("an app for a plumber to track jobs") matched no
      // WorkOrder keyword at all and fell through to the generic Item/
      // Customer fallback. \b-bounded with the same "(s)?" plural handling
      // used throughout this file (e.g. /\bmechanic(s)?\b/ above).
      /\bplumber(s)?\b/, /\belectrician(s)?\b/,
      // Round 2303: bare /\btechnician(s)?\b/ collided with the generic
      // word for many clinical/lab/broadcast professions that have
      // nothing to do with a repair/maintenance trade business --
      // "medical technician", "lab technician", "dental technician",
      // "vet technician", "sound technician" are all common, genuinely
      // unrelated phrasings. Confirmed live: "An app for a hospital to
      // track emergency medical technicians and their shift schedules."
      // and three similar sentences all fabricated a WorkOrder entity
      // and wrongly recommended Stripe for apps with no repair business
      // or money involved. Not a bare deletion -- "a technician to
      // schedule visits and bill customers" and "a general repair
      // technician business" depend SOLELY on this bare word with no
      // other WorkOrder keyword matching, so a lookbehind-guarded
      // regex is used instead (same approach as this file's own
      // Invoice/"חיוב" lookahead exclusion), excluding only the
      // specific clinical/lab/broadcast qualifiers confirmed to collide.
      /\b(?<!(?:medical|dental|lab|laboratory|vet|veterinary|pharmacy|surgical|radiology|nursing|sound|audio|broadcast|ultrasound)\s)technician(s)?\b/,
      /\bhandyman\b/, /\bhandymen\b/,
      /\blocksmith(s)?\b/,
      "hvac",
      // Round 2302: bare "plumbing" was deliberately NOT like "hvac" (an
      // unambiguous acronym) -- it has a very common metaphorical/tech-
      // jargon sense ("the plumbing" of a system, "backend plumbing",
      // "plumbing of a deployment pipeline") with nothing to do with the
      // trade, the same bare-noun-collision shape this file's own
      // "tailor"/"mover"/"landscaping" comments above already document.
      // Confirmed live: "An internal dashboard for engineers to
      // visualize the plumbing of our microservices deployment pipeline
      // and trace requests between services." fabricated a WorkOrder
      // entity and wrongly recommended Stripe for a pure internal
      // engineering tool with no customers or money involved. Replaced
      // with phrase-only keywords, mirroring the adjacent conventions --
      // "An app to manage scheduled plumbing jobs and customer requests
      // for a small plumbing company" (previously matched ONLY via the
      // bare word) still matches via "plumbing company"/"plumbing jobs".
      "plumbing business", "plumbing company", "plumbing jobs", "plumbing service", "plumbing services",
      // Round 1816: a tailoring/alterations shop is an equally common
      // small-business vertical as the daycare/salon/spa ones rounds
      // 1700-1800 already covered, but it had no WorkOrder keyword at all --
      // "an app for a tailor to manage alterations" fell through to the
      // generic Item fallback. WorkOrder's own shape (technician =
      // tailor/seamstress, scheduledDate = pickup date) already fits.
      // Deliberately NOT a bare "tailor": that collides with the common
      // app-description idiom "tailor X to Y" ("lets admins tailor
      // workflows to their team") and "tailor-made", confirmed live --
      // the same verb-collision shape this file's Deal-entity comment
      // documents for why bare "lead(s)" was never added. Phrase-only
      // keywords avoid that false positive while still closing the
      // realistic cases.
      "tailor shop", "tailoring shop", "tailoring business", "alterations shop",
      /\bclothing alterations?\b/, /\bgarment alterations?\b/, "seamstress", "dressmaker",
      "חייט", "חייטת", "חייטים", "תיקוני בגדים",
      // Round 1827: a moving/relocation company is an equally common small-
      // business vertical as the tailoring shop round 1816 added -- same
      // shape (technician = moving crew, scheduledDate = moving day), but
      // had no WorkOrder keyword at all, so "a moving company tracking
      // jobs and crews" fell through to the generic Item fallback.
      // Deliberately NOT a bare "mover(s)": that collides with the common
      // idiom "movers and shakers" (confirmed live), the same bare-noun
      // pitfall round 1816's own comment documents for "tailor". Phrase-
      // only keywords avoid that false positive while still closing the
      // realistic cases. Hebrew "מוביל"/"מובילים" deliberately excluded
      // too -- that word doubles as the ordinary adjective "leading"
      // ("החברה המובילה בתחום" = "the leading company in the field",
      // confirmed live), an even more common false-positive source than
      // the English "mover(s)" case.
      "moving company", "moving business", "moving service", "moving services",
      "relocation company", "relocation service", "relocation services", "relocation business",
      "movers and packers", /\blocal movers\b/,
      "חברת הובלות", "חברת הובלה", "שירותי הובלה", "הובלת דירות",
      // Round 1886: house/office cleaning, pest control, and landscaping/
      // lawn care are equally common "scheduled technician visits a
      // customer's property" small-business verticals as the plumber/
      // tailor/mover ones already covered above, but had no WorkOrder
      // keyword at all -- "a house cleaning service tracking clients and
      // scheduled jobs" fell through to the generic Customer/Service
      // fallback, which isn't in BILLING_ENTITY_NAMES below, so
      // buildOpenQuestions wrongly recommended "No payments" for a
      // textbook paid business. WorkOrder IS already in
      // BILLING_ENTITY_NAMES, so these same keywords fix both the missing
      // entity and the wrong payment recommendation together. Deliberately
      // phrase-only for "cleaning"/"landscaping" -- mirrors round 1816's
      // own bare-noun-collision caution ("tailor X to Y"): "landscape"/
      // "landscaping" is a common business-jargon metaphor ("the
      // competitive landscape"), confirmed live, so only the unambiguous
      // multi-word business-name phrases are included. "pest control" and
      // "lawn care" are themselves specific enough to include as bare
      // phrases -- neither has a metaphorical/idiomatic alternate meaning.
      "cleaning service", "cleaning services", "cleaning company", "cleaning business",
      "house cleaning", "office cleaning", "janitorial service", "janitorial services",
      "janitorial company", "maid service", "maid services",
      "pest control", "exterminator", "exterminators",
      "landscaping company", "landscaping business", "landscaping service", "landscaping services",
      "lawn care", "lawn mowing service", "lawn maintenance",
      "חברת ניקיון", "שירותי ניקיון", "ניקיון בתים", "ניקיון משרדים",
      "חברת הדברה", "שירותי הדברה", "מדביר",
      "חברת גינון", "שירותי גינון", "גינון ותחזוקה",
      // Round 1932: roofing, house painting, and carpentry contractors are
      // the same "scheduled trade visits a customer's property" vertical
      // as plumbers/electricians/tailors/movers/cleaners above, but had no
      // WorkOrder keyword at all -- "a roofing company dashboard" fell
      // through to the generic Item fallback (confirmed live), which isn't
      // in BILLING_ENTITY_NAMES below, so buildOpenQuestions wrongly
      // recommended "No payments" for a textbook paid trade business.
      // Bare "roofer(s)" is unambiguous enough to include (no other common
      // meaning, confirmed live). Deliberately NOT bare "painter" or
      // "carpenter": both collide with the visual-artist/craftsman sense
      // ("a portfolio site for a painter to showcase artwork", "a
      // carpenter's portfolio website for custom furniture art", both
      // confirmed live to describe a non-repair-job business) -- the same
      // bare-noun-collision caution round 1816's own comment documents for
      // "tailor". Phrase-only keywords for those two avoid the false
      // positive while still closing the realistic repair-contractor cases.
      "roofing company", "roofing contractor", "roofing service", "roofing services",
      /\broofer(s)?\b/,
      "painting contractor", "painting company", "house painting", "house painter", "house painters",
      "carpentry business", "carpentry shop", "carpenter shop", "carpentry company",
      "קבלן גגות", "איטום גגות", "חברת צביעה", "צבעי בתים", "נגריה",
      // Round 1949: the entity's own design intent (see the comment above)
      // explicitly names "plumbers, electricians, appliance/AC technicians,
      // handymen" alongside the trades round 1811 already added keywords
      // for, but "appliance" itself was never added -- "an app for an
      // appliance repair business to manage customers and jobs" matched no
      // WorkOrder keyword at all and fell through to the generic Customer
      // fallback. Deliberately NOT bare "appliance(s)": confirmed live it
      // collides with "virtual appliance"/"network appliance" (common IT
      // infrastructure jargon) and a "kitchen appliance store" (a retail
      // business, not a repair job tracker) -- the same bare-noun-collision
      // caution round 1816's own comment documents for "tailor". Phrase-
      // only keywords avoid that false positive while still closing the
      // realistic cases; bare /\btechnician(s)?\b/ above already covers
      // "appliance technician(s)" phrasing on its own.
      "appliance repair", "appliance repair shop", "appliance repair company",
      "appliance repair business", "appliance repair service", "appliance repair services",
      "תיקון מכשירי חשמל", "תיקון מוצרי חשמל", "טכנאי מוצרי חשמל",
      // Round 1978: the entity's own design intent (see the comment above)
      // explicitly names "plumbers, electricians, appliance/AC
      // technicians, handymen" -- round 1811 closed plumbers/electricians/
      // handymen and round 1949 closed appliance repair, but the "AC"
      // (air conditioning) half of that same phrase was never closed on
      // its own terms. The existing bare "hvac" keyword only matches a
      // description that literally uses the acronym -- "an app for an air
      // conditioning repair business to manage customers and jobs" (the
      // far more common way a non-technical person actually describes
      // this exact trade) matched no WorkOrder keyword at all and fell
      // through to the generic Customer fallback, which isn't in
      // BILLING_ENTITY_NAMES below, so buildOpenQuestions wrongly
      // recommended "No payments" for a textbook paid trade business --
      // the same failure shape every prior round in this block already
      // fixed for a different vertical. Phrase-only, mirroring this
      // block's own established caution: "air conditioning" alone has no
      // common false-positive collision the way "tailor"/"mover"/
      // "painter"/"appliance" do, but these are kept as multi-word
      // phrases for consistency with that same convention.
      "air conditioning repair", "air conditioning company", "air conditioning service",
      "air conditioning services",
      // Round 1981: "ac" is only two characters, so as a bare substring it
      // false-positive-matched any word ending in "...ac" immediately
      // followed by " repair" (e.g. "tarmac repair", "iMac repair") --
      // mirrors this same file's own /\broofer(s)?\b/ (round 1932) and
      // /\bcars?\b/ (round 1979) word-boundary convention, which this
      // round's own original phrase-only reasoning never applied to these
      // two unusually short, unusually risky strings.
      /\bac repair\b/, /\bac repair company\b/,
      "hvac repair", "hvac technician", "hvac company",
      "תיקון מזגנים", "טכנאי מזגנים", "חברת מזגנים",
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
    // Round 2108: bare "volunteer" collides with the extremely common
    // everyday VERB sense ("offer something unprompted") -- "volunteer a
    // phone number", "volunteer their email address", "volunteer
    // information" -- with zero connection to a nonprofit's donate-your-
    // time Volunteer entity. Confirmed live: an ordinary generic signup-
    // form description ("...can optionally volunteer a phone number
    // too.") matched ONLY ['Volunteer'], fabricating a nonprofit entity
    // and losing even the generic catch-all. Excluded the clean,
    // unambiguous direct-object-complement cases (a/an/their/his/her/its/
    // my/your + noun, or "information") the same verb sense always uses.
    // Deliberately NOT excluding "volunteer to VERB" or "volunteer for
    // X" -- those genuinely overlap with the real nonprofit sense ("sign
    // up to volunteer for the food bank", "volunteers who want to tutor
    // kids") with no single guard separating the two readings, the same
    // judgment call round 1722 already made for "lead"/"leads".
    //
    // Round 2131: the possessive-determiner list above was missing "our" --
    // the exact same direct-object-complement shape as "their"/"his"/"my"/
    // etc, just first-person-plural ("volunteer our building as a
    // shelter", "volunteer our office space for community events"), with
    // zero connection to the nonprofit Volunteer entity. Confirmed live:
    // "During emergencies, we volunteer our building as a shelter for
    // displaced residents." matched ONLY ['Volunteer'], the identical
    // catch-all-losing failure round 2108 already fixed for every other
    // possessive determiner.
    //
    // Round 2150: round 2108's own "volunteer information" exclusion
    // bounded the gap before "information" to AT MOST one intervening word
    // (`{0,1}`) -- the exact same fixed-word-window defeat class round
    // 2149 already fixed for the Courier font-exclusion regex just above
    // in this file. A signup form naming what kind of information (e.g.
    // "volunteer some additional contact information") puts two or more
    // words before "information", escapes the window, and matches
    // Volunteer anyway. Confirmed live: "...can optionally volunteer some
    // additional contact information too." matched ONLY ['Volunteer'],
    // the identical catch-all-losing failure round 2108's own comment
    // above describes. Widened to an unbounded `(?:\S+\s+)*` repetition --
    // any number of words before "information" now still excludes the
    // match, the same unbounded remedy round 2149 applied.
    //
    // Round 2242: round 2108's determiner-guard only covers a direct
    // object introduced by a/an/our/their/his/her/its/my/your -- the same
    // everyday verb sense phrased with a bare plural/mass noun (no
    // determiner at all), as in "volunteer email addresses", "volunteer
    // contact details", "volunteer feedback", "volunteer suggestions",
    // slips past that guard entirely and still matches. Confirmed live:
    // "...can optionally volunteer email addresses too." (and the
    // contact-details/feedback/suggestions variants) each matched ONLY
    // ['Volunteer'], the identical catch-all-losing failure every prior
    // round on this keyword already describes. Extended the
    // "information"-style exclusion (which already covers a bare noun
    // with no determiner) to the handful of other common nouns people
    // "volunteer" in this everyday sense -- info/details/feedback/
    // suggestions/comments/addresses/numbers/contacts -- while leaving
    // genuine nonprofit compound nouns ("volunteer hours", "volunteer
    // shift", "volunteer coordinators") and the plain subject usage
    // ("volunteers and their shifts") unaffected, since none of those are
    // in this short, deliberately narrow list.
    //
    // Round 2357: this determiner-exclusion list, incrementally extended
    // across rounds 2108/2131/2242, still missed the three single most
    // common English determiners that introduce the exact same
    // direct-object-complement construction -- "the", "some", "any".
    // Confirmed live: "During emergencies, hosts volunteer the building
    // as a shelter for displaced residents" (emergency-shelter app),
    // "We volunteer some office space for local community events"
    // (community events app), and "We volunteer any extra desks for the
    // pop-up clinic" (disaster-relief logistics app) all wrongly
    // fabricated a Volunteer entity with zero nonprofit-volunteering
    // content. Adds "the"/"some"/"any" to the determiner alternation.
    // Deliberately does NOT add "every"/"each"/"all"/"no" -- unlike
    // a/an/the/our/some/any, those commonly introduce a genuine
    // time-adverbial in authentic volunteering sentences (e.g. "they
    // volunteer each weekend at the soup kitchen"), not a direct object,
    // so adding them risks a different regression (false-excluding
    // genuine sentences); left as a residual gap needing its own
    // disambiguation design. Confirmed live this doesn't affect any
    // existing excluded case (rounds 2108/2131/2242's own) or any
    // genuine match ("manage our volunteers and their shifts",
    // "volunteers sign up for shifts", "volunteer for the food bank",
    // "volunteer hours and shift assignments"), nor sentences where the
    // determiner precedes "volunteer(s)" as the sentence's subject
    // rather than following it as an idiom trigger ("the volunteers
    // arrived early", "some volunteers prefer morning shifts", "any
    // volunteers available this weekend") -- the lookahead only checks
    // what follows "volunteer(s)", never what precedes it.
    keywords: [
      /\bvolunteers?\b(?!\s+(?:a|an|the|our|their|his|her|its|my|your|some|any)\s+\S+)(?!\s+(?:\S+\s+)*(?:information|info|details?|feedback|suggestions?|comments?|addresses?|numbers?|contacts?)\b)/,
      "volunteer management", "volunteer shift",
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
      //
      // Round 2299: all four of those forms are construct chains
      // (סמיכות) whose definite article attaches to the SECOND noun
      // ("דין"->"הדין"), not the first -- the same pattern round 2298
      // found for Pet's "חיית המחמד" and round 2286 found for lodging's
      // "בית ההארחה". "עורך הדין שלנו" ("our lawyer") and "עורכי הדין
      // במשרד" ("the lawyers at the firm") are at least as natural as
      // the bare forms, but none of "עורך הדין"/"עורכי הדין"/"עורכת
      // הדין"/"עורכות הדין" is a substring of its own indefinite
      // keyword, so all four silently fell through to the generic Item
      // fallback. Confirmed live: "אפליקציה לניהול יומן של עורך הדין
      // שלנו" matched only Item, with the real legal-case domain
      // entirely lost, while the bare-noun twin ("...עורך דין עמוס...")
      // already matched Case correctly.
      "עורך דין", "עורכי דין", "עורכת דין", "עורכות דין",
      "עורך הדין", "עורכי הדין", "עורכת הדין", "עורכות הדין",
      // Round 1813: the Hebrew side already has the bare profession nouns
      // above, but the English side only ever got the specific phrases
      // "legal case"/"law firm"/"case management"/"legal matter" -- the
      // single most natural phrasing a real solo lawyer/attorney would
      // type ("an app for a divorce lawyer", "a personal injury attorney")
      // matched none of them and fell through to Customer-only or the
      // degenerate Item fallback. Plain substrings (not \b-bounded regexes
      // like this file's other bare-word fixes) because "lawyer"/"attorney"
      // aren't substrings of any other common English word or any other
      // entity's keyword in this file, unlike "case" itself (never added
      // bare for that reason) -- "lawyers"/"attorneys" already match via
      // the singular being a prefix of the plural.
      "lawyer", "attorney",
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
  // Round 2361: the `י?ת?` alternation above can produce only "", "י",
  // "ת", or "ית" -- it can never produce "ות" (no "ו" anywhere in the
  // pattern), so the fourth, equally common inflection "מנהלות מערכת"
  // ("female system administrators", feminine plural) was never covered
  // and still slipped through as a spurious Manager match. Replaced with
  // an explicit `(?:י|ת|ות)?` alternation covering all four suffix shapes,
  // while still matching a real standalone "מנהלות" (e.g. "מנהלות חנות",
  // real store managers, feminine plural).
  Manager: { keywords: ["manager", /\bmanagement\b/, /מנהל(?!(?:י|ת|ות)?\s*מערכת)/, "ניהול"], labelHe: "מנהל/ת" },
  // Same bare-substring collision as the Employee entity rule above
  // ("coworker" contains "worker") -- \b-bounded here too. Also same
  // pu'al "מעובד" collision (round 565) as the Employee entity rule's own
  // Hebrew keywords -- lookbehind-bounded here too. Also same "staff"/
  // "Staffordshire" collision (round 574) as the Employee entity rule's
  // own fix above -- \b-bounded here too. Also same bare "צוות"/"מצוות"
  // collision (round 825) as the Employee entity rule's own fix above --
  // lookbehind-bounded here too. Also same "עובדה"/"עובדות" (fact(s))
  // collision (round 1919) as the Employee entity rule's own fix above --
  // kept in sync here too.
  Employee: {
    keywords: [
      "employee", /\bstaff\b/, /\bworkers?\b/, "team member",
      // Round 1720: kept in sync with the Employee entity rule's own
      // "trainer"/"מאמן" addition above.
      //
      // Round 2290: kept in sync with that same entity rule's own
      // construct-state "מאמני" addition (see its comment above).
      //
      // Round 2362: kept in sync with that same entity rule's own
      // feminine-plural "מאמנות" addition (see its comment above).
      /\btrainers?\b/, "מאמן", "מאמנת", "מאמנים", "מאמני", "מאמנות",
      /(?<!מ)עובד(?!ה)(?!ות\s*(?:על|מעניינ|מרתק|מדהימ|משעשע|סקרני|אקראי))/,
      /(?<!מ)עובדת/, /(?<!מ)עובדים/, /(?<!מ)צוות/,
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
