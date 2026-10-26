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
  "entities": [{ "name": string, "label"?: string, "description"?: string, "fields": [{ "name": string, "label"?: string, "type": "text"|"longtext"|"number"|"boolean"|"date"|"enum"|"relation"|"file", "required"?: boolean, "enumValues"?: string[], "relationTo"?: string }] }],
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
- Use "file" for a field that is a genuine document/image/attachment (a resume, ID photo, invoice, contract
  scan) the description implies someone uploads -- not for anything that's really just text (a URL, a name).
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

  async generate(description: string, isHebrewOverride?: boolean): Promise<ProductSpec> {
    // See SpecProvider.generate's own doc comment: when the caller already
    // knows the project's real, established language (a /refine instruction
    // or /answers response concatenated onto the original description),
    // this pins the model's output language explicitly instead of letting
    // it infer one from the mixed text -- the system prompt's own "same
    // language as the user's description" rule can't tell an established
    // project's language apart from a single Hebrew/English word that only
    // the newly-appended text happened to contain.
    const languageDirective =
      isHebrewOverride === undefined
        ? ""
        : isHebrewOverride
          ? "\n\n[Write every \"label\", \"summary\", \"roles\", \"assumptions\", and \"openQuestions\" entry in Hebrew, regardless of what language any part of the request below is written in.]"
          : "\n\n[Write every \"label\", \"summary\", \"roles\", \"assumptions\", and \"openQuestions\" entry in English, regardless of what language any part of the request below is written in.]";
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
          messages: [{ role: "user", content: `${description}${languageDirective}` }],
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
    // Round 1031: the model is free to emit whatever "screens" shape it
    // wants per the system prompt above, and real LLM output doesn't
    // reliably follow the Dashboard-plus-List+Form-pair-per-entity
    // convention heuristic.ts's buildScreens and templates.ts's screensFor
    // both already enforce deterministically (round 1028 fixed templates.ts
    // to match heuristic.ts for exactly this reason). Since `screens` has
    // zero effect on what's actually built (grep apps/api/src/pipeline.ts
    // apps/api/src/codegen.ts for "screens" -- no matches; it's purely
    // Time Machine/History display metadata read by HistoryPanel.tsx/
    // checkpointDiff.ts), overriding the model's own guess with the same
    // deterministic shape the other two generators already produce is
    // free -- nothing downstream depends on its content, only this
    // count/shape being consistent across every generator so "N screens"
    // means the same thing regardless of which one built the project.
    return { ...result.data, screens: screensFor(result.data.entities) };
  }
}

/**
 * Mirrors heuristic.ts's own buildScreens and templates.ts's own
 * screensFor exactly (Dashboard, then a List+Form pair per entity) --
 * the per-module small-duplication convention this codebase already
 * uses for this exact helper (and plenty of others, e.g. keyFor,
 * recordDisplayLabel), rather than introducing a new shared module for
 * a three-line function.
 */
function screensFor(entities: ProductSpec["entities"]): ProductSpec["screens"] {
  const screens: ProductSpec["screens"] = [{ name: "Dashboard", type: "dashboard" }];
  for (const entity of entities) {
    screens.push({ name: `${entity.name} List`, type: "list", entity: entity.name });
    screens.push({ name: `${entity.name} Form`, type: "form", entity: entity.name });
  }
  return screens;
}

/**
 * Strips markdown code fences and any surrounding prose if the model wrapped
 * or introduced its JSON despite instructions. First tries the whole
 * response as-is: when it's already valid JSON, every heuristic below is
 * skipped, which matters because the fence regex otherwise has no way to
 * tell a real wrapping fence from a markdown fence that merely appears
 * inside a genuine JSON string value (e.g. an entity description containing
 * a code sample) -- round 568, found by fuzzing but misfiled in round 533 as
 * a duplicate of this same function's copy in debug.ts, which was never
 * actually fixed either. The fence regex is not anchored to the whole
 * string, so a fenced block preceded/followed by prose (e.g. "Here's the
 * spec:\n```json\n{...}\n```") still gets unwrapped instead of being handed
 * to JSON.parse as-is. If there's no fenced block at all, falls back to
 * scanning each "{" in turn (not just the first) paired with the last "}",
 * so prose preceding the real JSON and containing its own brace (also round
 * 568) is skipped in favor of whichever "{" actually yields valid JSON.
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
