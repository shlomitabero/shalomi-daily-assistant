import type { ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { SpecProvider } from "./provider.js";
import { fetchAnthropic } from "./anthropicFetch.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const SYSTEM_PROMPT = `You are the Product Manager Agent inside Forge AI, an AI software creation platform.
Given a plain-language business description, output ONLY a single JSON object (no prose, no markdown fences)
matching exactly this shape:

{
  "summary": string,
  "personas": string[],
  "roles": string[],
  "entities": [{ "name": string, "label"?: string, "description"?: string, "fields": [{ "name": string, "label"?: string, "type": "text"|"longtext"|"number"|"boolean"|"date"|"enum"|"relation", "required"?: boolean, "enumValues"?: string[], "relationTo"?: string }] }],
  "screens": [{ "name": string, "type": "list"|"form"|"dashboard", "entity"?: string }],
  "assumptions": string[],
  "openQuestions": [{ "question": string, "options": string[], "recommendation"?: string }]
}

Rules:
- Build a THOROUGH spec that genuinely covers everything the description implies. Do not silently trim the
  request down to a bare-minimum CRUD skeleton. If the description names or implies multiple entities,
  workflows, roles, or fields (even in passing), include all of them — a fuller, more complete app is the
  goal, not a smaller one. Only leave something out if the description gives no basis for it at all; when in
  doubt, include it rather than omit it.
- Every entity needs at least one field, and every entity should have enough fields to actually be usable
  (not just a single "name" field) unless the description is genuinely that sparse.
- "roles" must never be an empty array. Every app has at least one role: the person who owns/runs it. For a
  single-user app with no distinct user types, still include one role for that owner (e.g. "Admin" or
  "Owner") rather than returning no roles at all.
- "enum" fields must include enumValues. "relation" fields must include relationTo naming another entity.
- State genuine assumptions you made instead of asking unnecessary questions.
- Only ask openQuestions for decisions with no reasonable default (e.g. which payment provider) — and when
  you do supply a "recommendation", default to the option that covers MORE of what the user is likely to
  need, not the option that does the least.
- Every entity/field "name" MUST stay a plain ASCII identifier (e.g. "Customer", "dueDate") no matter what
  language the user wrote in — these become real SQL table/column names. Write "summary", "roles",
  "assumptions", "openQuestions", and every entity/field "label" in the SAME language and script the user's
  description was written in (e.g. Hebrew in, Hebrew labels and summary out). "label" is the only place
  non-ASCII text belongs.
- Output raw JSON only.`;

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Real LLM-backed spec generator using the Anthropic Messages API directly
 * (no SDK dependency). Used whenever ANTHROPIC_API_KEY is configured; falls
 * back to HeuristicSpecProvider otherwise (see index.ts).
 */
export class AnthropicSpecProvider implements SpecProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-5";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  async generate(description: string): Promise<ProductSpec> {
    const response = await fetchAnthropic(
      this.fetchImpl,
      ANTHROPIC_API_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: description }],
        }),
      },
      this.timeoutMs,
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
      throw new Error("Anthropic API refused to generate a spec for this request (stop_reason: refusal)");
    }

    const text = payload.content?.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new Error("Anthropic API response contained no text content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (err) {
      // A response cut off by hitting max_tokens mid-JSON is a distinct,
      // actionable failure (raise max_tokens) from the model genuinely
      // returning malformed JSON -- surface which one this was instead of
      // a generic parse error that looks the same either way.
      if (payload.stop_reason === "max_tokens") {
        throw new Error("Anthropic API response was truncated (stop_reason: max_tokens) before completing valid JSON");
      }
      throw new Error(`Anthropic API response was not valid JSON: ${(err as Error).message}`);
    }

    const result = ProductSpecSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Anthropic API response did not match ProductSpec schema: ${result.error.message}`);
    }
    return result.data;
  }
}

/**
 * Strips markdown code fences and any surrounding prose if the model wrapped
 * or introduced its JSON despite instructions. The fence regex is not
 * anchored to the whole string, so a fenced block preceded/followed by prose
 * (e.g. "Here's the spec:\n```json\n{...}\n```") still gets unwrapped
 * instead of being handed to JSON.parse as-is. If there's no fenced block at
 * all, falls back to the substring between the first "{" and the last "}".
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}
