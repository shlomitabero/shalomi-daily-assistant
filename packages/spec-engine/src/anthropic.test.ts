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

/**
 * Round 708: without an explicit pin, the model infers the output language
 * from the raw description text itself, per the system prompt's own "same
 * language... the user's description was written in" rule -- which breaks
 * down when the description is a concatenation of a project's own
 * established text plus brand-new, unrelated text (/refine's instruction,
 * /answers' clarifying-question response): one stray Hebrew/English word
 * in just the new part can tip the model's own inference for the WHOLE
 * spec. Confirms isHebrewOverride appends an explicit directive pinning
 * the language, and that omitting it sends the description unchanged
 * (the exact prior behavior, so a caller generating a brand-new project
 * with no established language yet is unaffected).
 */
test("generate() appends an explicit language directive to the request when isHebrewOverride is given, and sends the description unchanged when it's omitted", async () => {
  let capturedContent: string | undefined;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    capturedContent = (JSON.parse(init!.body as string) as { messages: { content: string }[] }).messages[0].content;
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SPEC) }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });

  await provider.generate("a CRM for my business", false);
  assert.match(capturedContent!, /Write every.*in English/i, "isHebrewOverride: false must pin English explicitly");
  assert.match(capturedContent!, /^a CRM for my business/, "the original description text must still lead the message");

  await provider.generate("a CRM for my business", true);
  assert.match(capturedContent!, /Write every.*in Hebrew/i, "isHebrewOverride: true must pin Hebrew explicitly");

  await provider.generate("a CRM for my business");
  assert.equal(capturedContent, "a CRM for my business", "omitting isHebrewOverride must send the description exactly as before this round, with no directive appended");
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

test("generate() correctly parses a clean JSON response whose own entity description contains a markdown code fence, instead of the fence regex matching inside the string value", async () => {
  const specWithFenceInDescription = {
    ...VALID_SPEC,
    entities: [
      {
        name: "Snippet",
        fields: [{ name: "description", type: "longtext", required: false }],
        description: "Use ```js\ncode\n``` for formatting",
      },
    ],
  };
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(specWithFenceInDescription) }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("a code-snippet sharing app");
  assert.equal(spec.entities[0]!.name, "Snippet");
});

test("generate() correctly parses JSON preceded by prose that itself contains a brace, instead of indexOf grabbing the prose's own brace", async () => {
  const withBracyProse =
    "Note: the schema format uses {} for objects. " + JSON.stringify(VALID_SPEC);
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: withBracyProse }] }), { status: 200 })) as unknown as typeof fetch;

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

/**
 * generate() used to call fetchImpl directly with no timeout -- a stalled
 * network call (TCP connects, response never arrives) would hang this
 * forever. Confirms the fix is actually wired through: a fetchImpl that
 * never resolves still makes generate() reject, via the injectable
 * timeoutMs option (see anthropicFetch.ts).
 */
test("generate() times out instead of hanging forever when the network call stalls", async () => {
  const stalledFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: stalledFetch, timeoutMs: 10 });
  await assert.rejects(() => provider.generate("x"), /timed out/);
});

/**
 * Round 1031: the system prompt above asks the model to freely emit its
 * own "screens" array, with no code-level validation of its shape or
 * count -- unlike heuristic.ts's buildScreens and templates.ts's
 * screensFor (round 1028), which both deterministically produce
 * Dashboard + a List+Form pair per entity. Since `screens` has zero
 * effect on what's actually built (it's pure Time Machine/History
 * display metadata), a real LLM response that returns a differently-
 * shaped screens array -- fewer entries, missing Form screens, an extra
 * one, whatever that specific prompt happened to produce -- silently
 * made "N screens" mean something different depending on which generator
 * built a given project. Confirms generate() discards the model's own
 * screens guess entirely and replaces it with the same deterministic
 * shape the other two generators already produce.
 */
test("generate() normalizes screens to the Dashboard-plus-List+Form-pair-per-entity convention, discarding whatever arbitrary shape the model itself returned", async () => {
  const specWithWrongScreens = {
    ...VALID_SPEC,
    entities: [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
    ],
    // Deliberately wrong shape: only one screen total, no Form screens,
    // and no screen at all for "Order" -- a plausible real model response
    // that still passes ProductSpecSchema (ScreenSchema imposes no
    // count/shape constraint).
    screens: [{ name: "Everything", type: "dashboard" }],
  };
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(specWithWrongScreens) }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("a CRM with orders");

  assert.equal(spec.screens.length, 2 * spec.entities.length + 1, "must match heuristic.ts/templates.ts's own Dashboard-plus-List+Form-pair convention, not the model's own 1-screen guess");
  assert.equal(spec.screens[0]!.type, "dashboard");
  for (const entity of spec.entities) {
    assert.ok(spec.screens.some((s) => s.type === "list" && s.entity === entity.name), `expected a list screen for ${entity.name}`);
    assert.ok(spec.screens.some((s) => s.type === "form" && s.entity === entity.name), `expected a form screen for ${entity.name}`);
  }
});
