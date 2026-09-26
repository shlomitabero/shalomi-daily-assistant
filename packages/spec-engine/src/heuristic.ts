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

const PAYMENT_KEYWORDS = [
  "payment", "invoice", "billing", "subscription", "checkout", "stripe",
  "תשלום", "תשלומים", "חשבונית", "חיוב", "מנוי",
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
 */
const BILLING_ENTITY_NAMES = new Set(["Invoice", "Order", "Donation", "Subscription"]);

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

export function matchEntities(text: string, isHebrew: boolean): Entity[] {
  const lower = text.toLowerCase();
  const matched: Entity[] = [];
  for (const rule of DOMAIN_ENTITY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
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
    if (rule.keywords.some((kw) => lower.includes(kw))) {
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
  const mentionsPayments = PAYMENT_KEYWORDS.some((kw) => lower.includes(kw));
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
      "יש כרגע סביבת עבודה אחת פרטית לחשבון שלך; אין עדיין שיתוף בין כמה משתמשים על אותו פרויקט.",
      "כל אינטגרציה שהוזכרה בתיאור (תשלומים, הודעות וכו') עדיין לא מחוברת בפועל — ראו את השאלות הפתוחות למטה.",
    ];
  }
  return [
    "Using a generic schema-driven CRUD engine backed by SQLite for this Phase 1 slice, not a dedicated generated codebase per project yet.",
    "Single demo workspace; multi-user authentication is not implemented yet.",
    "Any integrations mentioned in the description (payments, messaging, etc.) are not wired up yet — see open questions and the product roadmap.",
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

  async generate(description: string): Promise<ProductSpec> {
    if (!description || description.trim().length === 0) {
      throw new Error("description must not be empty");
    }
    const isHebrew = isHebrewText(description);
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
