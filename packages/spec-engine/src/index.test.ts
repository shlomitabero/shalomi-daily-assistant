import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicSpecProvider } from "./anthropic.js";
import { selectProvider, generateSpec } from "./index.js";

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
