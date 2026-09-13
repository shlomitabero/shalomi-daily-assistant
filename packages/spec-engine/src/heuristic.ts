import type { Entity, OpenQuestion, ProductSpec, Screen } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { SpecProvider } from "./provider.js";
import { DEFAULT_ENTITY, DOMAIN_ENTITY_RULES, ROLE_KEYWORDS } from "./domainEntities.js";

const PAYMENT_KEYWORDS = ["payment", "invoice", "billing", "subscription", "checkout", "stripe"];

function matchEntities(text: string): Entity[] {
  const lower = text.toLowerCase();
  const matched: Entity[] = [];
  for (const rule of DOMAIN_ENTITY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      matched.push(rule.entity);
    }
  }
  return matched.length > 0 ? matched : [DEFAULT_ENTITY];
}

function matchRoles(text: string): string[] {
  const lower = text.toLowerCase();
  const roles = new Set<string>();
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      roles.add(role);
    }
  }
  roles.add("Admin");
  if (roles.size === 1) {
    roles.add("Member");
  }
  return Array.from(roles);
}

function buildScreens(entities: Entity[], roles: string[]): Screen[] {
  const screens: Screen[] = [];
  if (roles.includes("Admin") || roles.includes("Manager")) {
    screens.push({ name: "Dashboard", type: "dashboard" });
  }
  for (const entity of entities) {
    screens.push({ name: `${entity.name} List`, type: "list", entity: entity.name });
    screens.push({ name: `${entity.name} Form`, type: "form", entity: entity.name });
  }
  return screens;
}

function buildOpenQuestions(text: string, entities: Entity[]): OpenQuestion[] {
  const lower = text.toLowerCase();
  const questions: OpenQuestion[] = [];
  const mentionsPayments = PAYMENT_KEYWORDS.some((kw) => lower.includes(kw));
  const hasBillingEntity = entities.some((e) => e.name === "Invoice" || e.name === "Order");
  if (mentionsPayments || hasBillingEntity) {
    questions.push({
      question: "Which payment provider should this use?",
      options: ["Stripe", "PayPal", "No payments", "Decide for me"],
      recommendation: "Stripe",
    });
  } else {
    questions.push({
      question: "Does this application need to accept payments?",
      options: ["Stripe", "PayPal", "No payments", "Decide for me"],
      recommendation: "No payments",
    });
  }
  return questions;
}

function summarize(text: string, entities: Entity[], roles: string[]): string {
  const entityNames = entities.map((e) => e.name).join(", ");
  return `A business application managing ${entityNames} with role-based access for ${roles.join(", ")}, generated from: "${text.trim()}"`;
}

/**
 * Deterministic, offline product-spec generator. Matches recognizable
 * business nouns (customers, appointments, invoices, ...) against a small
 * domain library instead of calling a model. This is Forge AI's fallback
 * provider — always available, zero configuration, fully testable — used
 * when no LLM credentials are configured. It is intentionally simpler than
 * the Anthropic provider and never claims to understand nuance it doesn't.
 */
export class HeuristicSpecProvider implements SpecProvider {
  readonly name = "heuristic";

  async generate(description: string): Promise<ProductSpec> {
    if (!description || description.trim().length === 0) {
      throw new Error("description must not be empty");
    }
    const entities = matchEntities(description);
    const roles = matchRoles(description);
    const screens = buildScreens(entities, roles);
    const openQuestions = buildOpenQuestions(description, entities);

    const spec: ProductSpec = {
      summary: summarize(description, entities, roles),
      personas: roles.map((r) => `${r} user`),
      roles,
      entities,
      screens,
      assumptions: [
        "Using a generic schema-driven CRUD engine backed by SQLite for this Phase 1 slice, not a dedicated generated codebase per project yet.",
        "Single demo workspace; multi-user authentication is not implemented yet.",
        "Any integrations mentioned in the description (payments, messaging, etc.) are not wired up yet — see open questions and the product roadmap.",
      ],
      openQuestions,
    };

    return ProductSpecSchema.parse(spec);
  }
}
