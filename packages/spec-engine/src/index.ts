import type { ProductSpec } from "@forge/shared";
import { AnthropicSpecProvider } from "./anthropic.js";
import { HeuristicSpecProvider } from "./heuristic.js";
import type { SpecProvider } from "./provider.js";

export type { SpecProvider } from "./provider.js";
export { HeuristicSpecProvider } from "./heuristic.js";
export { AnthropicSpecProvider } from "./anthropic.js";
export { isHebrewText } from "./domainEntities.js";
export { requestSpecFix, type RequestSpecFixOptions } from "./debug.js";
export {
  enhancePrompt,
  selectEnhancer,
  HeuristicPromptEnhancer,
  AnthropicPromptEnhancer,
  type PromptEnhancer,
} from "./promptEnhancer.js";

/**
 * Picks the best available provider: a real Claude model call when
 * ANTHROPIC_API_KEY is set, otherwise the deterministic offline heuristic.
 * This is the seam the Model Router (Forge AI vision, section 31) will grow
 * from — today it's a two-way choice, not a full router.
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): SpecProvider {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new AnthropicSpecProvider({ apiKey, model: env.ANTHROPIC_MODEL });
  }
  return new HeuristicSpecProvider();
}

/**
 * If a real model call fails at runtime -- network error, rate limit, or the
 * model's output not matching ProductSpecSchema -- this falls back to the
 * deterministic heuristic provider instead of surfacing a raw 500 to the
 * user, who has no way to act on "Internal server error". The real failure
 * is still logged server-side for diagnosis. `providerName` comes back
 * tagged "<name>-fallback" so this is never silently mistaken for a normal
 * heuristic (no-API-key) response.
 */
export async function generateSpec(
  description: string,
  provider: SpecProvider = selectProvider(),
): Promise<{ spec: ProductSpec; providerName: string }> {
  try {
    const spec = await provider.generate(description);
    return { spec, providerName: provider.name };
  } catch (err) {
    if (provider.name === "heuristic") throw err;
    // eslint-disable-next-line no-console
    console.error(`spec provider "${provider.name}" failed, falling back to heuristic:`, err);
    const spec = await new HeuristicSpecProvider().generate(description);
    return { spec, providerName: `${provider.name}-fallback` };
  }
}
