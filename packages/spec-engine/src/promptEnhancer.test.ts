import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicPromptEnhancer, ENHANCE_SYSTEM_PROMPT, HeuristicPromptEnhancer, selectEnhancer } from "./promptEnhancer.js";
import { enhancePrompt } from "./index.js";

test("ENHANCE_SYSTEM_PROMPT instructs the model to expand, not replace, the user's idea", () => {
  assert.match(ENHANCE_SYSTEM_PROMPT, /entities/i);
  assert.match(ENHANCE_SYSTEM_PROMPT, /roles/i);
  assert.match(ENHANCE_SYSTEM_PROMPT, /same language/i);
});

test("selectEnhancer falls back to heuristic when no API key is configured", () => {
  const enhancer = selectEnhancer({});
  assert.equal(enhancer.name, "heuristic");
});

test("selectEnhancer picks Anthropic when an API key is configured", () => {
  const enhancer = selectEnhancer({ ANTHROPIC_API_KEY: "test-key" } as NodeJS.ProcessEnv);
  assert.equal(enhancer.name, "anthropic");
});

test("HeuristicPromptEnhancer rejects an empty idea", async () => {
  const enhancer = new HeuristicPromptEnhancer();
  await assert.rejects(() => enhancer.enhance(""), /must not be empty/);
  await assert.rejects(() => enhancer.enhance("   "), /must not be empty/);
});

test("HeuristicPromptEnhancer expands a short English idea with detected entities, fields, and roles", async () => {
  const enhancer = new HeuristicPromptEnhancer();
  const enhanced = await enhancer.enhance("a booking app for a hair salon with customers and appointments");
  assert.match(enhanced, /Customer/);
  assert.match(enhanced, /Appointment/);
  assert.match(enhanced, /Admin/);
  // The original idea's substance should still be present, not discarded.
  assert.match(enhanced, /hair salon/);
  assert.ok(enhanced.length > "a booking app for a hair salon with customers and appointments".length);
});

test("HeuristicPromptEnhancer expands a short Hebrew idea in Hebrew, mentioning detected entities", async () => {
  const enhancer = new HeuristicPromptEnhancer();
  const enhanced = await enhancer.enhance("אפליקציה למספרה עם לקוחות ותורים");
  assert.match(enhanced, /לקוחות/);
  assert.match(enhanced, /תורים/);
  assert.doesNotMatch(enhanced, /[A-Za-z]{4,}/); // no stray English words leaking into the Hebrew output
});

test("HeuristicPromptEnhancer falls back to the generic entity when nothing recognizable is mentioned", async () => {
  const enhancer = new HeuristicPromptEnhancer();
  const enhanced = await enhancer.enhance("something totally unrecognizable and abstract");
  assert.match(enhanced, /Item/);
});

test("AnthropicPromptEnhancer returns the model's rewritten text", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: "  A detailed rewritten idea.  " }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: fakeFetch });
  const result = await enhancer.enhance("a rough idea");
  assert.equal(result, "A detailed rewritten idea.");
});

test("AnthropicPromptEnhancer rejects an empty idea before calling the API", async () => {
  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: (async () => {
    throw new Error("should not be called");
  }) as unknown as typeof fetch });
  await assert.rejects(() => enhancer.enhance(""), /must not be empty/);
});

test("AnthropicPromptEnhancer throws a descriptive error on API failure", async () => {
  const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => enhancer.enhance("x"), /429/);
});

test("AnthropicPromptEnhancer throws when the response has no usable text", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "   " }] }), { status: 200 })) as unknown as typeof fetch;
  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => enhancer.enhance("x"), /no text content/);
});

test("AnthropicPromptEnhancer throws a descriptive error when the response body isn't valid JSON, instead of an unwrapped SyntaxError -- same fix as anthropic.ts/debug.ts", async () => {
  const fakeFetch = (async () => new Response("not json at all {", { status: 200 })) as unknown as typeof fetch;
  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => enhancer.enhance("x"), /Anthropic API response/);
});

test("AnthropicPromptEnhancer throws a specific error on a safety refusal (stop_reason: refusal), not the generic 'no text content' message -- same fix as anthropic.ts/debug.ts", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [], stop_reason: "refusal" }), { status: 200 })) as unknown as typeof fetch;
  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => enhancer.enhance("x"), /refus/i);
});

test("enhancePrompt returns providerName alongside the enhanced text", async () => {
  const { enhanced, providerName } = await enhancePrompt("a shop with customers and orders");
  assert.equal(providerName, "heuristic");
  assert.ok(enhanced.length > 0);
});

test("enhancePrompt falls back to the heuristic enhancer when a non-heuristic enhancer throws", async () => {
  const failingEnhancer = {
    name: "anthropic",
    enhance: async () => {
      throw new Error("simulated model failure");
    },
  };
  const { enhanced, providerName } = await enhancePrompt("a shop with customers and orders", failingEnhancer);
  assert.equal(providerName, "anthropic-fallback");
  assert.ok(enhanced.length > 0);
});

test("enhancePrompt still throws when the heuristic enhancer itself fails (no further fallback to hide behind)", async () => {
  const failingHeuristic = {
    name: "heuristic",
    enhance: async () => {
      throw new Error("should propagate, not loop");
    },
  };
  await assert.rejects(() => enhancePrompt("x", failingHeuristic), /should propagate/);
});

/**
 * AnthropicPromptEnhancer.enhance() used to call fetchImpl directly with no
 * timeout -- a stalled network call (TCP connects, response never arrives)
 * would hang forever. Confirms the fix is actually wired through: a
 * fetchImpl that only resolves once its AbortSignal fires still makes
 * enhance() reject, via the injectable timeoutMs option (see
 * anthropicFetch.ts).
 */
test("AnthropicPromptEnhancer.enhance() times out instead of hanging forever when the network call stalls", async () => {
  const stalledFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: stalledFetch, timeoutMs: 10 });
  await assert.rejects(() => enhancer.enhance("x"), /timed out/);
});

test("enhancePrompt falls back to the heuristic enhancer when the Anthropic call stalls and times out, not just on an explicit error response", async () => {
  const stalledFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const enhancer = new AnthropicPromptEnhancer({ apiKey: "test-key", fetchImpl: stalledFetch, timeoutMs: 10 });
  const { enhanced, providerName } = await enhancePrompt("a shop with customers and orders", enhancer);
  assert.equal(providerName, "anthropic-fallback");
  assert.ok(enhanced.length > 0);
});
