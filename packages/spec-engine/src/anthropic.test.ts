import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicSpecProvider, SYSTEM_PROMPT } from "./anthropic.js";

const VALID_SPEC = {
  summary: "A CRM.",
  personas: ["Owner"],
  roles: ["Admin"],
  entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  screens: [{ name: "Dashboard", type: "dashboard" }],
  assumptions: [],
  openQuestions: [],
};

test("SYSTEM_PROMPT explicitly tells the model roles must never be empty, matching ProductSpecSchema's roles.min(1)", () => {
  // The schema requires at least one role, but nothing in the prompt said
  // so -- a reasonable model response for a single-user app (roles: [])
  // would otherwise pass every stated rule yet still fail schema
  // validation, silently downgrading a correct LLM spec to the heuristic
  // fallback. This just checks the prompt text carries the instruction;
  // it can't observe real model behavior from this sandbox.
  assert.match(SYSTEM_PROMPT, /roles.*must never be an empty array/i);
});

test("generate() returns the parsed spec on a clean JSON response", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SPEC) }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("a CRM for my business");
  assert.equal(spec.entities[0]!.name, "Customer");
});

test("generate() strips markdown fences when the model's response is exactly one fenced block", async () => {
  const fenced = "```json\n" + JSON.stringify(VALID_SPEC) + "\n```";
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: fenced }] }), { status: 200 })) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("a CRM for my business");
  assert.equal(spec.entities[0]!.name, "Customer");
});

test("generate() still extracts the JSON when the model adds prose around a fenced block, despite the 'no prose' instruction", async () => {
  const withProse = "Here's the spec:\n```json\n" + JSON.stringify(VALID_SPEC) + "\n```\nLet me know if you'd like changes!";
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: withProse }] }), { status: 200 })) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("a CRM for my business");
  assert.equal(spec.entities[0]!.name, "Customer");
});

test("generate() throws a descriptive error when the response body isn't valid JSON, instead of an unwrapped SyntaxError", async () => {
  const fakeFetch = (async () => new Response("not json at all {", { status: 200 })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /Anthropic API response/);
});

test("generate() throws a descriptive error on an HTTP failure", async () => {
  const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /429/);
});

test("generate() throws a descriptive error when the response has no usable text", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "" }] }), { status: 200 })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /no text content/);
});

test("generate() throws a descriptive error when the model's JSON doesn't match ProductSpecSchema", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ summary: "x" }) }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /did not match ProductSpec schema/);
});

test("generate() names truncation specifically when JSON parsing fails and stop_reason is max_tokens, instead of a generic parse error", async () => {
  // A response cut off mid-JSON by hitting the token limit is a different,
  // actionable failure from the model genuinely returning malformed JSON --
  // the fix is raising max_tokens, not debugging a parsing bug. Both throw
  // from the same JSON.parse call, so this is only distinguishable by
  // looking at stop_reason, which the prior code never inspected.
  const truncated = JSON.stringify(VALID_SPEC).slice(0, 40);
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: truncated }], stop_reason: "max_tokens" }), {
      status: 200,
    })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /truncated.*max_tokens/i);
});

test("generate() throws a specific error on a safety refusal (stop_reason: refusal), not the generic 'no text content' message", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [], stop_reason: "refusal" }), { status: 200 })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /refus/i);
});

test("generate() still reports a genuinely malformed (non-truncated) JSON response with the original generic message", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "{not: valid json}" }], stop_reason: "end_turn" }), {
      status: 200,
    })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /Anthropic API response was not valid JSON/);
});
