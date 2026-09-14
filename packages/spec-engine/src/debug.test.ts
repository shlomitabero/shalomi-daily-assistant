import assert from "node:assert/strict";
import { test } from "node:test";
import { requestSpecFix } from "./debug.js";

const brokenSpec = {
  summary: "test",
  personas: [],
  roles: ["Admin"],
  entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  screens: [],
  assumptions: [],
  openQuestions: [],
};

test("requestSpecFix returns a validated corrected spec on success", async () => {
  const fixedSpec = {
    ...brokenSpec,
    entities: [{ name: "Customer", fields: [{ name: "fullName", type: "text", required: true }] }],
  };
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    // The Debug Agent must send both the failing spec and the real error.
    assert.equal(body.messages[0].content.includes('"error"'), true);
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fixedSpec) }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await requestSpecFix(brokenSpec, 'duplicate column name: name', {
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.entities[0].fields[0].name, "fullName");
});

test("requestSpecFix throws when the model's response fails schema validation", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () => requestSpecFix(brokenSpec, "some error", { apiKey: "test-key", fetchImpl: fakeFetch }),
    /ProductSpec schema/,
  );
});

test("requestSpecFix throws a descriptive error on a non-2xx response", async () => {
  const fakeFetch = (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch;
  await assert.rejects(
    () => requestSpecFix(brokenSpec, "some error", { apiKey: "test-key", fetchImpl: fakeFetch }),
    /529/,
  );
});
