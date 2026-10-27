import type { ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import { fetchAnthropic } from "./anthropicFetch.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `You are the Debug Agent inside Forge AI, an AI software creation platform.
You will be given a JSON object with two fields: "spec" (a ProductSpec that failed to build) and
"error" (the exact error message a real SQLite database gave when applying it).

Return ONLY a corrected ProductSpec JSON object — the exact same shape as "spec" — that fixes
whatever caused the error, changing as little as possible. Do not add prose, do not wrap it in
markdown fences. Every entity/field "name" must stay a plain ASCII identifier (these become real
SQL table/column names). Output raw JSON only.`;

export interface RequestSpecFixOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Strips markdown code fences and any surrounding prose if the model wrapped
 * or introduced its JSON despite instructions. First tries the whole
 * response as-is, skipping every heuristic below when it's already valid
 * JSON, and falls back to scanning each "{" in turn (not just the first)
 * paired with the last "}" (see the identical fix and its rationale in
 * anthropic.ts -- round 568).
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // not valid JSON as-is; fall through to the heuristics below
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];

  const end = trimmed.lastIndexOf("}");
  if (end !== -1) {
    for (let start = trimmed.indexOf("{"); start !== -1 && start < end; start = trimmed.indexOf("{", start + 1)) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // this "{" wasn't the real start; try the next one
      }
    }
  }
  return trimmed;
}

/**
 * The Debug Agent's only real capability: given a spec that failed to build
 * and the actual error SQLite raised, ask Claude for a corrected spec, and
 * validate the result against the same schema every other spec goes
 * through. Only ever called when ANTHROPIC_API_KEY is configured — there is
 * no offline/heuristic equivalent, because "diagnose an arbitrary error and
 * propose a fix" genuinely needs a model, not a keyword match. Callers
 * should say so plainly when no key is configured rather than pretending to
 * repair anything.
 */
export async function requestSpecFix(
  spec: ProductSpec,
  errorMessage: string,
  options: RequestSpecFixOptions,
): Promise<ProductSpec> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchAnthropic(
    fetchImpl,
    ANTHROPIC_API_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: options.model ?? "claude-sonnet-5",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify({ spec, error: errorMessage }) }],
      }),
    },
    options.timeoutMs,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API request failed (${response.status}): ${body}`);
  }

  let payload: { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`Anthropic API response body was not valid JSON: ${(err as Error).message}`);
  }

  if (payload.stop_reason === "refusal") {
    throw new Error("Anthropic API refused to generate a spec fix for this request (stop_reason: refusal)");
  }

  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("Anthropic API response contained no text content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    if (payload.stop_reason === "max_tokens") {
      throw new Error("Anthropic API response was truncated (stop_reason: max_tokens) before completing valid JSON");
    }
    throw new Error(`Anthropic API response was not valid JSON: ${(err as Error).message}`);
  }

  const result = ProductSpecSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Anthropic API response did not match ProductSpec schema: ${result.error.message}`);
  }
  // Round 1113: same override anthropic.ts's AnthropicSpecProvider.generate
  // already applies (round 1031) -- the Debug Agent is a fresh model call
  // with the identical "screens" freedom the system prompt above never
  // constrains (ScreenSchema only requires a name/type/optional entity, no
  // count/shape), and pipeline.ts's own comment on this function says
  // outright that it "is free to rename/add/remove entities and fields
  // while resolving the error." Without this, a repaired spec's screens
  // can be stale or mismatched against whatever entities the repair
  // actually produced -- the exact "count/shape means something different
  // depending on which generator happened to build a given project"
  // problem round 1031 fixed for the other three generators, just never
  // extended to this fourth one.
  return { ...result.data, screens: screensFor(result.data.entities) };
}

/**
 * Mirrors anthropic.ts's own screensFor (and heuristic.ts's buildScreens,
 * templates.ts's screensFor) exactly -- the per-module small-duplication
 * convention this codebase already uses for this exact helper.
 */
function screensFor(entities: ProductSpec["entities"]): ProductSpec["screens"] {
  const screens: ProductSpec["screens"] = [{ name: "Dashboard", type: "dashboard" }];
  for (const entity of entities) {
    screens.push({ name: `${entity.name} List`, type: "list", entity: entity.name });
    screens.push({ name: `${entity.name} Form`, type: "form", entity: entity.name });
  }
  return screens;
}
