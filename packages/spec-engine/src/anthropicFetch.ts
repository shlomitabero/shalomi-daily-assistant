/**
 * All three Anthropic-backed callers in this package (AnthropicSpecProvider,
 * AnthropicPromptEnhancer, requestSpecFix) called fetchImpl(...) directly
 * with no timeout. If api.anthropic.com accepts the TCP connection but
 * never responds (a network stall or an upstream hang), that call never
 * resolves or rejects -- which defeats the fallback-to-heuristic design
 * enhancePrompt/index.ts's selectProvider build around a caught rejection,
 * and for requestSpecFix (no offline fallback at all), hangs the whole
 * multi-agent build pipeline indefinitely with no way out. This wraps any
 * fetchImpl call with a real timeout via AbortController.
 */
export const ANTHROPIC_REQUEST_TIMEOUT_MS = 60_000;

export async function fetchAnthropic(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = ANTHROPIC_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Anthropic API request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
