import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicSpecProvider, SYSTEM_PROMPT } from "./anthropic.js";
import { selectProvider, generateSpec } from "./index.js";

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
