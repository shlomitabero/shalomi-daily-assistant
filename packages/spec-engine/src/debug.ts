import type { ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";

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
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
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
  const response = await fetchImpl(ANTHROPIC_API_URL, {
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
