import type { ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { SpecProvider } from "./provider.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `You are the Product Manager Agent inside Forge AI, an AI software creation platform.
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
- Infer the minimum viable set of entities and roles a working CRUD app needs; do not over-engineer.
- Every entity needs at least one field.
- "enum" fields must include enumValues. "relation" fields must include relationTo naming another entity.
- State genuine assumptions you made instead of asking unnecessary questions.
- Only ask openQuestions for decisions with no reasonable default (e.g. which payment provider).
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

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-5";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(description: string): Promise<ProductSpec> {
    const response = await this.fetchImpl(ANTHROPIC_API_URL, {
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
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Anthropic API request failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = payload.content?.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new Error("Anthropic API response contained no text content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (err) {
      throw new Error(`Anthropic API response was not valid JSON: ${(err as Error).message}`);
    }

    const result = ProductSpecSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Anthropic API response did not match ProductSpec schema: ${result.error.message}`);
    }
    return result.data;
  }
}

/** Strips markdown code fences if the model wrapped its JSON despite instructions. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
