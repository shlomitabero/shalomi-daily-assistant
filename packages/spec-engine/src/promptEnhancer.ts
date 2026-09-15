import { isHebrewText } from "./domainEntities.js";
import { matchEntities, matchRoles } from "./heuristic.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const ENHANCE_SYSTEM_PROMPT = `You are the Prompt Architect Agent inside Forge AI, an AI software creation platform.
A user gave a short, rough idea for a business application. Rewrite it into a single detailed paragraph
that a Product Manager Agent can turn directly into a complete app spec.

Rules:
- Explicitly name the entities/data this app should track, the user roles, and the key workflows the rough
  idea implies -- expand and clarify what is already implied, do not invent an unrelated business.
- Write the rewritten paragraph in the SAME language and script the user's idea was written in (e.g. Hebrew
  in, Hebrew out).
- Output ONLY the rewritten paragraph as plain text: no JSON, no markdown, no headings, no quotes around it,
  no preamble like "Here is...".`;

export interface PromptEnhancer {
  readonly name: string;
  enhance(rawIdea: string): Promise<string>;
}

/**
 * Deterministic, offline "prompt enhancer" fallback -- reuses the same
 * keyword-matched domain library the heuristic spec generator uses (see
 * heuristic.ts / domainEntities.ts) to turn a short idea into a fuller
 * paragraph naming the entities, their fields, and the roles it detected.
 * Always available, zero configuration, no model call.
 */
export class HeuristicPromptEnhancer implements PromptEnhancer {
  readonly name = "heuristic";

  async enhance(rawIdea: string): Promise<string> {
    if (!rawIdea || rawIdea.trim().length === 0) {
      throw new Error("rawIdea must not be empty");
    }
    const isHebrew = isHebrewText(rawIdea);
    const entities = matchEntities(rawIdea, isHebrew);
    const roles = matchRoles(rawIdea, isHebrew);
    const entityPhrases = entities.map((e) => {
      const label = e.label ?? e.name;
      const fields = e.fields.map((f) => f.label ?? f.name).join(isHebrew ? ", " : ", ");
      return `${label} (${fields})`;
    });

    const trimmedIdea = rawIdea.trim().replace(/[.!?]+$/, "");
    if (isHebrew) {
      return (
        `${trimmedIdea}. האפליקציה תנהל את הישויות הבאות: ${entityPhrases.join("; ")}. ` +
        `תהיה הרשאת גישה לפי תפקיד עבור: ${roles.join(", ")}. ` +
        `לכל ישות יהיה מסך רשימה ומסך טופס ליצירה ועריכה של רשומות.`
      );
    }
    return (
      `${trimmedIdea}. The application will manage the following entities: ${entityPhrases.join("; ")}. ` +
      `Role-based access will be available for: ${roles.join(", ")}. ` +
      `Each entity gets a list screen and a create/edit form screen.`
    );
  }
}

export interface AnthropicPromptEnhancerOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Real LLM-backed prompt enhancer using the Anthropic Messages API directly
 * (no SDK dependency, same approach as AnthropicSpecProvider). Used whenever
 * ANTHROPIC_API_KEY is configured; falls back to HeuristicPromptEnhancer
 * otherwise (see selectEnhancer below).
 */
export class AnthropicPromptEnhancer implements PromptEnhancer {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicPromptEnhancerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-5";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async enhance(rawIdea: string): Promise<string> {
    if (!rawIdea || rawIdea.trim().length === 0) {
      throw new Error("rawIdea must not be empty");
    }
    const response = await this.fetchImpl(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: ENHANCE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: rawIdea }],
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
    if (!text || text.trim().length === 0) {
      throw new Error("Anthropic API response contained no text content");
    }
    return text.trim();
  }
}

/**
 * Picks the best available enhancer: a real Claude model call when
 * ANTHROPIC_API_KEY is set, otherwise the deterministic offline heuristic --
 * mirrors selectProvider in index.ts.
 */
export function selectEnhancer(env: NodeJS.ProcessEnv = process.env): PromptEnhancer {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new AnthropicPromptEnhancer({ apiKey, model: env.ANTHROPIC_MODEL });
  }
  return new HeuristicPromptEnhancer();
}

export async function enhancePrompt(
  rawIdea: string,
  enhancer: PromptEnhancer = selectEnhancer(),
): Promise<{ enhanced: string; providerName: string }> {
  const enhanced = await enhancer.enhance(rawIdea);
  return { enhanced, providerName: enhancer.name };
}
