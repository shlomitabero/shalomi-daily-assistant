import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { AnthropicSpecProvider, SYSTEM_PROMPT } from "./anthropic.js";
import { selectProvider, generateSpec, mergeRefinedSpec } from "./index.js";

function baseSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    summary: "base",
    personas: [],
    roles: ["Admin"],
    entities: [],
    screens: [],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}

test("the Product Manager Agent's system prompt tells the model to be thorough, not to minimize", () => {
  // Direct product feedback: the platform should not default to recommending
  // a stripped-down spec -- it should try to cover everything the user's
  // description implies. Lock this in as a real regression test so a future
  // prompt edit can't silently reintroduce "infer the minimum viable set...
  // do not over-engineer" style language.
  assert.doesNotMatch(SYSTEM_PROMPT, /minimum viable/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /do not over-engineer/i);
  assert.match(SYSTEM_PROMPT, /thorough/i);
});

test("selectProvider falls back to heuristic when no API key is configured", () => {
  const provider = selectProvider({});
  assert.equal(provider.name, "heuristic");
});

test("selectProvider picks Anthropic when an API key is configured", () => {
  const provider = selectProvider({ ANTHROPIC_API_KEY: "test-key" } as NodeJS.ProcessEnv);
  assert.equal(provider.name, "anthropic");
});

test("AnthropicSpecProvider parses a well-formed model response", async () => {
  const fakeSpec = {
    summary: "A tiny CRM",
    personas: ["Admin user"],
    roles: ["Admin"],
    entities: [
      {
        name: "Lead",
        fields: [{ name: "name", type: "text", required: true }],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fakeSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("a tiny CRM");
  assert.equal(spec.summary, "A tiny CRM");
  assert.equal(spec.entities[0].name, "Lead");
});

test("AnthropicSpecProvider strips markdown fences before parsing", async () => {
  const fakeSpec = {
    summary: "Fenced",
    personas: [],
    roles: ["Admin"],
    entities: [{ name: "Thing", fields: [{ name: "name", type: "text", required: true }] }],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fenced = "```json\n" + JSON.stringify(fakeSpec) + "\n```";
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: fenced }] }), { status: 200 })) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("fenced case");
  assert.equal(spec.summary, "Fenced");
});

test("AnthropicSpecProvider rejects a field named 'id' or 'createdAt' (both are built-in columns every generated table already has)", async () => {
  const fakeSpec = {
    summary: "A tiny CRM",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Lead",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "createdAt", type: "date", required: false },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fakeSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("a tiny CRM"), /collides with a built-in column/);
});

test("AnthropicSpecProvider rejects two entities whose names collide when compared case-insensitively (SQLite table names are case-insensitive, so 'Order' and 'order' would silently share one table)", async () => {
  const fakeSpec = {
    summary: "A tiny logistics app",
    personas: [],
    roles: ["Admin"],
    entities: [
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      { name: "order", fields: [{ name: "status", type: "text", required: false }] },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fakeSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("a tiny logistics app"), /collide when compared case-insensitively/);
});

test("a model response with two case-colliding entity names falls back to the heuristic provider end to end, instead of ever reaching the database layer with two entities mapped to one SQLite table", async () => {
  const caseCollidingSpec = {
    summary: "A tiny logistics app",
    personas: [],
    roles: ["Admin"],
    entities: [
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      { name: "ORDER", fields: [{ name: "status", type: "text", required: false }] },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(caseCollidingSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });

  const { spec, providerName } = await generateSpec("a tiny logistics app", provider);
  assert.equal(providerName, "anthropic-fallback");
  const lowerNames = spec.entities.map((e) => e.name.toLowerCase());
  assert.equal(new Set(lowerNames).size, lowerNames.length);
});

test("a model response with a field named 'id' falls back to the heuristic provider end to end, instead of ever reaching the database layer with a colliding column name", async () => {
  const badFieldSpec = {
    summary: "A tiny CRM",
    personas: [],
    roles: ["Admin"],
    entities: [{ name: "Lead", fields: [{ name: "id", type: "text", required: true }] }],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(badFieldSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });

  const { spec, providerName } = await generateSpec("a tiny CRM", provider);
  assert.equal(providerName, "anthropic-fallback");
  // The real heuristic output, not the rejected spec -- no entity in it ever
  // has a field literally named "id" (that's the whole point).
  for (const entity of spec.entities) {
    assert.ok(!entity.fields.some((f) => f.name.toLowerCase() === "id"));
  }
});

test("AnthropicSpecProvider throws a descriptive error on API failure", async () => {
  const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /429/);
});

test("generateSpec returns providerName alongside the spec", async () => {
  const { spec, providerName } = await generateSpec("customers and invoices");
  assert.equal(providerName, "heuristic");
  assert.ok(spec.entities.length > 0);
});

/**
 * Round 708: generateSpec's own new third parameter must actually reach
 * the provider's generate() call -- both on the normal path and on the
 * fallback-to-heuristic path, since a /refine or /answers call whose real
 * provider fails must not silently lose the language pin and fall back to
 * re-deriving it from the (potentially mixed-language) description text.
 */
test("generateSpec forwards isHebrewOverride to the provider, including the fallback heuristic call when the primary provider throws", async () => {
  let capturedOverride: boolean | undefined;
  const failingProvider = {
    name: "anthropic",
    generate: async (_description: string, isHebrewOverride?: boolean) => {
      capturedOverride = isHebrewOverride;
      throw new Error("simulated model failure");
    },
  };
  const { spec, providerName } = await generateSpec("a shop with customers and orders", failingProvider, false);
  assert.equal(providerName, "anthropic-fallback");
  assert.equal(capturedOverride, false, "the primary provider must receive the real override before it fails");
  // The fallback's own heuristic call must have received the same override
  // too -- confirmed indirectly: an English-pinned fallback must not carry
  // a Hebrew label even if it somehow would have otherwise.
  assert.equal(spec.entities[0]?.label, undefined, "the fallback heuristic call must have received the same English pin");
});

test("generateSpec falls back to the heuristic provider when a non-heuristic provider throws, instead of surfacing a raw error", async () => {
  const failingProvider = {
    name: "anthropic",
    generate: async () => {
      throw new Error("simulated model failure (e.g. schema mismatch or rate limit)");
    },
  };
  const { spec, providerName } = await generateSpec("a shop with customers and orders", failingProvider);
  assert.equal(providerName, "anthropic-fallback");
  assert.ok(spec.entities.length > 0);
});

test("generateSpec still throws when the heuristic provider itself fails (no further fallback to hide behind)", async () => {
  const failingHeuristic = {
    name: "heuristic",
    generate: async () => {
      throw new Error("should propagate, not loop");
    },
  };
  await assert.rejects(() => generateSpec("x", failingHeuristic), /should propagate/);
});

/**
 * Round 1714: a live-tested repro found that /refine's own candidate spec
 * (generateSpec's return value, with zero awareness of the project's
 * CURRENT spec) can silently drop whole entities the current spec already
 * has -- e.g. the Sales CRM template's Contact entity vanished outright on
 * the very first refine of a Templates-Gallery project. mergeRefinedSpec
 * is the safety net: the CURRENT spec's entities/fields/roles always
 * survive; the candidate only ever ADDS what it introduces that doesn't
 * already exist.
 */
test("mergeRefinedSpec keeps an entity the candidate dropped entirely", () => {
  const current = baseSpec({
    entities: [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Contact", fields: [{ name: "name", type: "text", required: true }] },
    ],
    screens: [
      { name: "Dashboard", type: "dashboard" },
      { name: "Customer List", type: "list", entity: "Customer" },
      { name: "Customer Form", type: "form", entity: "Customer" },
      { name: "Contact List", type: "list", entity: "Contact" },
      { name: "Contact Form", type: "form", entity: "Contact" },
    ],
  });
  // The candidate re-derived only Customer -- Contact is gone, exactly the
  // live-repro'd failure. candidate.screens reflects this: it was computed
  // (screensFor/buildScreens) from candidate.entities BEFORE the merge ever
  // restores Contact, so it only has Customer's own screens.
  const candidate = baseSpec({
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
    screens: [
      { name: "Dashboard", type: "dashboard" },
      { name: "Customer List", type: "list", entity: "Customer" },
      { name: "Customer Form", type: "form", entity: "Customer" },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(
    merged.entities.map((e) => e.name).sort(),
    ["Contact", "Customer"],
  );
  // Round 1753: the restored Contact entity must also get its screens
  // back, not just the entity record itself -- otherwise the merged spec
  // has an entity with zero screens, baked permanently into the resulting
  // checkpoint.
  assert.deepEqual(
    merged.screens.map((s) => s.name).sort(),
    ["Contact Form", "Contact List", "Customer Form", "Customer List", "Dashboard"],
  );
});

test("mergeRefinedSpec still adds a genuinely new entity the candidate introduces", () => {
  const current = baseSpec({ entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({
    entities: [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Invoice", fields: [{ name: "amount", type: "number", required: true }] },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(
    merged.entities.map((e) => e.name).sort(),
    ["Customer", "Invoice"],
  );
});

test("mergeRefinedSpec adds a new field to an existing entity, but keeps that entity's current fields too", () => {
  const current = baseSpec({
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "notes", type: "longtext", required: false },
        ],
      },
    ],
  });
  // The candidate re-derived Customer without "notes" at all, but introduced a new "phone" field.
  const candidate = baseSpec({
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "phone", type: "text", required: false },
        ],
      },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  const customer = merged.entities.find((e) => e.name === "Customer")!;
  assert.deepEqual(
    customer.fields.map((f) => f.name).sort(),
    ["name", "notes", "phone"],
  );
});

test("mergeRefinedSpec matches entity/role names case-insensitively, so a mere casing difference doesn't duplicate", () => {
  const current = baseSpec({ roles: ["Admin"], entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({ roles: ["admin"], entities: [{ name: "customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const merged = mergeRefinedSpec(current, candidate);
  assert.equal(merged.roles.length, 1);
  assert.equal(merged.entities.length, 1);
});

test("mergeRefinedSpec unions roles the same way as entities", () => {
  const current = baseSpec({ roles: ["Admin"] });
  const candidate = baseSpec({ roles: ["Admin", "Manager"] });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(merged.roles, ["Admin", "Manager"]);
});

test("mergeRefinedSpec takes the candidate's own summary, not the current spec's", () => {
  const current = baseSpec({ summary: "old summary" });
  const candidate = baseSpec({ summary: "new summary reflecting the refine instruction" });
  const merged = mergeRefinedSpec(current, candidate);
  assert.equal(merged.summary, "new summary reflecting the refine instruction");
});
