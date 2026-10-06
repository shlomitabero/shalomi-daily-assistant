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

/**
 * Round 374: a 429 ("rate_limit_error") or 529 ("overloaded_error") response
 * -- the two status codes Anthropic's own API documents as transient and
 * safe to retry -- used to be treated identically to a genuine 400/401 by
 * every one of this file's three callers, since none of them retried at
 * all. For AnthropicSpecProvider/AnthropicPromptEnhancer that's merely
 * wasteful (their own callers already fall back to the heuristic provider
 * on ANY failure), but requestSpecFix (the Debug Agent's own call, see
 * debug.ts's doc comment) has no offline fallback whatsoever -- a single
 * transient hiccup on this one call used to kill the whole Debug step, and
 * with it the whole multi-agent build pipeline, even though the underlying
 * error it was trying to fix may have been perfectly fixable. Every other
 * 4xx/5xx status is a real request/configuration problem retrying can't
 * fix, so only these two are retried.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 529]);

/** Delays between retries, in ms, mirroring apps/web/src/wakeRetry.ts's own injectable-sleep convention. */
const DEFAULT_RETRY_DELAYS_MS = [500, 1500];

async function fetchAnthropicOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
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

export async function fetchAnthropic(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = ANTHROPIC_REQUEST_TIMEOUT_MS,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchAnthropicOnce(fetchImpl, url, init, timeoutMs);
    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= retryDelaysMs.length) {
      return response;
    }
    await sleep(retryDelaysMs[attempt]);
  }
}
