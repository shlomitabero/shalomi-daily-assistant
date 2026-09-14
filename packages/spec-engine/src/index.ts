import type { ProductSpec } from "@forge/shared";
import { AnthropicSpecProvider } from "./anthropic.js";
import { HeuristicSpecProvider } from "./heuristic.js";
import type { SpecProvider } from "./provider.js";

export type { SpecProvider } from "./provider.js";
export { HeuristicSpecProvider } from "./heuristic.js";
export { AnthropicSpecProvider } from "./anthropic.js";
export { isHebrewText } from "./domainEntities.js";
export { requestSpecFix, type RequestSpecFixOptions } from "./debug.js";

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

export async function generateSpec(
  description: string,
  provider: SpecProvider = selectProvider(),
): Promise<{ spec: ProductSpec; providerName: string }> {
  const spec = await provider.generate(description);
  return { spec, providerName: provider.name };
}
