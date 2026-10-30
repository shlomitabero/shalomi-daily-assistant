import assert from "node:assert/strict";
import { test } from "node:test";
import { ELITE_SYSTEM_PROMPT, applyPatch, generateEliteCodeResponse, parseAgentResponse, parsePatchHunks } from "./eliteAgent.js";

test("parseAgentResponse extracts a single <thought> block, trimmed", () => {
  const actions = parseAgentResponse("<thought>\n  Plan: add a button.\n</thought>");
  assert.deepEqual(actions, [{ type: "thought", content: "Plan: add a button." }]);
});

test("parseAgentResponse extracts a single <file> block with its full raw content, untouched", () => {
  const text = '<file path="src/components/Button.tsx">export function Button() {\n  return <button>Click</button>;\n}\n</file>';
  const actions = parseAgentResponse(text);
  assert.deepEqual(actions, [
    { type: "file", path: "src/components/Button.tsx", content: "export function Button() {\n  return <button>Click</button>;\n}\n" },
  ]);
});

test("parseAgentResponse extracts a <shell> block, trimmed", () => {
  const actions = parseAgentResponse("<shell>\n  npm install sonner\n</shell>");
  assert.deepEqual(actions, [{ type: "shell", command: "npm install sonner" }]);
});

/**
 * The real-world shape: a thought, then a brand-new file, then a patch to
 * an existing one, then a shell command to install a new dependency --
 * all interleaved in the order the model actually streamed them. Confirms
 * parseAgentResponse preserves that order rather than grouping by tag
 * type, since a later action can depend on an earlier one (e.g. the
 * package the shell command installs being used by the file right above
 * it).
 */
test("parseAgentResponse preserves the real document order of a mixed thought/file/patch/shell response", () => {
  const text = [
    "<thought>Add a Card component, wire it into the dashboard, and install date-fns.</thought>",
    '<file path="src/components/Card.tsx">export function Card() { return <div className="rounded-lg border p-4" />; }</file>',
    '<patch path="src/pages/Dashboard.tsx">',
    "<<<<<<< SEARCH",
    "import { Button } from",
    "=======",
    "import { Card } from \"../components/Card\";\nimport { Button } from",
    ">>>>>>> REPLACE",
    "</patch>",
    "<shell>npm install date-fns</shell>",
  ].join("\n");

  const actions = parseAgentResponse(text);
  assert.deepEqual(
    actions.map((a) => a.type),
    ["thought", "file", "patch", "shell"],
    "actions must come back in the exact order the model streamed them",
  );
  assert.equal((actions[1] as { path: string }).path, "src/components/Card.tsx");
  assert.equal((actions[2] as { path: string }).path, "src/pages/Dashboard.tsx");
  assert.equal((actions[3] as { command: string }).command, "npm install date-fns");
});

test("parseAgentResponse ignores stray prose outside any recognized tag, per the system prompt's own 'never write prose outside a thought block' rule", () => {
  const text = 'Sure, here you go!\n<file path="a.ts">export const a = 1;</file>\nHope that helps!';
  const actions = parseAgentResponse(text);
  assert.deepEqual(actions, [{ type: "file", path: "a.ts", content: "export const a = 1;" }]);
});

test("parsePatchHunks extracts a single SEARCH/REPLACE hunk", () => {
  const body = ["<<<<<<< SEARCH", "const x = 1;", "=======", "const x = 2;", ">>>>>>> REPLACE"].join("\n");
  assert.deepEqual(parsePatchHunks(body), [{ search: "const x = 1;", replace: "const x = 2;" }]);
});

/**
 * The system prompt explicitly allows a single <patch> block to carry
 * several independent edits to the same file -- confirms both hunks are
 * extracted, in order, from one patch body.
 */
test("parsePatchHunks extracts multiple hunks from a single patch body, in order", () => {
  const body = [
    "<<<<<<< SEARCH",
    "import React from \"react\";",
    "=======",
    "import React, { useState } from \"react\";",
    ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    "export function App() {}",
    "=======",
    "export function App() { const [open, setOpen] = useState(false); }",
    ">>>>>>> REPLACE",
  ].join("\n");
  const hunks = parsePatchHunks(body);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].search, 'import React from "react";');
  assert.equal(hunks[1].replace, "export function App() { const [open, setOpen] = useState(false); }");
});

test("parsePatchHunks returns an empty array for a patch body with no real hunks", () => {
  assert.deepEqual(parsePatchHunks("no markers here at all"), []);
});

/**
 * Round 1095: an empty search/replace block is a legitimate hunk shape --
 * "insert this, no surrounding context needed" -- but the old
 * implementation's single regex required a full extra newline between
 * each marker line and its neighboring capture, which structurally
 * cannot exist when that capture is empty. The hunk was silently
 * dropped (parsePatchHunks returned []) with no error, no signal.
 */
test("parsePatchHunks still extracts a hunk whose search text is genuinely empty", () => {
  const body = ["<<<<<<< SEARCH", "=======", "new content here", ">>>>>>> REPLACE"].join("\n");
  assert.deepEqual(parsePatchHunks(body), [{ search: "", replace: "new content here" }]);
});

test("parsePatchHunks still extracts a hunk whose replace text is genuinely empty", () => {
  const body = ["<<<<<<< SEARCH", "delete this line", "=======", ">>>>>>> REPLACE"].join("\n");
  assert.deepEqual(parsePatchHunks(body), [{ search: "delete this line", replace: "" }]);
});

test("parsePatchHunks returns no hunks for a SEARCH block with no closing markers at all, rather than guessing", () => {
  const body = ["<<<<<<< SEARCH", "foo", "bar"].join("\n");
  assert.deepEqual(parsePatchHunks(body), []);
});

test("applyPatch replaces a single hunk's search text with its replace text", () => {
  const result = applyPatch("const x = 1;\nconst y = 2;", [{ search: "const x = 1;", replace: "const x = 100;" }]);
  assert.equal(result.content, "const x = 100;\nconst y = 2;");
  assert.equal(result.appliedCount, 1);
  assert.equal(result.failedHunkIndex, null);
});

test("applyPatch applies several hunks in order, each against the content the previous hunk already produced", () => {
  const result = applyPatch("line1\nline2\nline3", [
    { search: "line1", replace: "LINE_ONE" },
    { search: "line3", replace: "LINE_THREE" },
  ]);
  assert.equal(result.content, "LINE_ONE\nline2\nLINE_THREE");
  assert.equal(result.appliedCount, 2);
});

/**
 * A patch written against a version of the file that has since changed
 * (the model's own context went stale) must fail clearly rather than
 * silently no-op or corrupt unrelated content -- the caller can then
 * re-request a fresh patch instead of ending up with a file that looks
 * edited but wasn't.
 */
test("applyPatch fails a hunk whose search text isn't found, and stops there without touching the rest", () => {
  const result = applyPatch("const x = 1;", [
    { search: "const x = 1;", replace: "const x = 2;" },
    { search: "this text does not exist", replace: "whatever" },
  ]);
  assert.equal(result.appliedCount, 1, "the first, valid hunk must still have been applied");
  assert.equal(result.content, "const x = 2;");
  assert.equal(result.failedHunkIndex, 1);
  assert.equal(result.failedHunkReason, "not_found");
});

/**
 * The same "must match exactly once" discipline this codebase's own
 * Artifact-edit tooling already enforces for the identical reason:
 * guessing which of several identical occurrences was meant is how a
 * patch silently edits the wrong one.
 */
test("applyPatch refuses an ambiguous hunk whose search text appears more than once, rather than guessing which occurrence was meant", () => {
  const result = applyPatch("return 1;\nreturn 1;\n", [{ search: "return 1;", replace: "return 2;" }]);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.content, "return 1;\nreturn 1;\n", "content must be left completely untouched when a hunk is ambiguous");
  assert.equal(result.failedHunkIndex, 0);
  assert.equal(result.failedHunkReason, "ambiguous");
});

/**
 * Round 1095: before this fix, String.prototype.indexOf("") === 0 made an
 * empty search text look like it was "found at index 0" of any content,
 * and every later indexOf("", 1) call also "finds" it again -- so this
 * used to be misreported as "ambiguous" rather than refused for what it
 * actually is: a contextless insertion this format has no line number or
 * anchor to place correctly.
 */
test("applyPatch refuses a hunk whose search text is empty, rather than guessing where to insert", () => {
  const result = applyPatch("hello world", [{ search: "", replace: "inserted" }]);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.content, "hello world", "content must be left completely untouched");
  assert.equal(result.failedHunkIndex, 0);
  assert.equal(result.failedHunkReason, "empty_search");
});

test("applyPatch with zero hunks returns the original content unchanged", () => {
  const result = applyPatch("unchanged", []);
  assert.equal(result.content, "unchanged");
  assert.equal(result.appliedCount, 0);
  assert.equal(result.failedHunkIndex, null);
});

test("generateEliteCodeResponse sends the elite system prompt and the caller's own request, and returns both the raw text and its parsed actions", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (_input, init) => {
    capturedBody = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: '<thought>Plan.</thought>\n<file path="a.ts">export const a = 1;</file>' }],
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await generateEliteCodeResponse("Build me a todo app", { apiKey: "test-key", fetchImpl: fakeFetch });

  assert.equal(capturedBody?.system, ELITE_SYSTEM_PROMPT, "the real elite system prompt must be sent as its own top-level field");
  assert.deepEqual(capturedBody?.messages, [{ role: "user", content: "Build me a todo app" }]);
  assert.match(result.rawText, /Plan\./);
  assert.deepEqual(result.actions, [
    { type: "thought", content: "Plan." },
    { type: "file", path: "a.ts", content: "export const a = 1;" },
  ]);
});

test("generateEliteCodeResponse throws a clear error when the API responds with a non-ok status", async () => {
  const fakeFetch: typeof fetch = async () => new Response("rate limited", { status: 429 });
  await assert.rejects(
    () => generateEliteCodeResponse("Build me a todo app", { apiKey: "test-key", fetchImpl: fakeFetch, timeoutMs: 100 }),
    /Anthropic API request failed \(429\)/,
  );
});

test("generateEliteCodeResponse throws when the model refuses the request", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "" }], stop_reason: "refusal" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    () => generateEliteCodeResponse("something disallowed", { apiKey: "test-key", fetchImpl: fakeFetch }),
    /refused to generate code/,
  );
});

/**
 * Round 1318: mirrors anthropic.ts's own max_tokens check (AnthropicSpecProvider),
 * but unconditional rather than only inside a JSON.parse catch -- unlike that
 * function, parseAgentResponse's regex never throws on a truncated response,
 * it just silently has no closing tag to match for whichever <file>/<patch>/
 * <shell> block the model was still writing when it got cut off, so that
 * block vanishes from `actions` with no error at all. A real response cut off
 * mid <file> block (no closing </file> tag) is used here, not a hypothetical,
 * to prove the silent-data-loss failure mode this fix closes: without the
 * fix, this exact response would resolve successfully with `actions`
 * containing only the thought, silently missing the in-progress file.
 */
test("generateEliteCodeResponse throws when the response was truncated by hitting max_tokens, instead of silently dropping the in-progress file", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: '<thought>Plan.</thought>\n<file path="src/components/Dashboard.tsx">export function Dashboard() {' }],
        stop_reason: "max_tokens",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    () => generateEliteCodeResponse("Build me a dashboard", { apiKey: "test-key", fetchImpl: fakeFetch }),
    /truncated \(stop_reason: max_tokens\)/,
  );
});
