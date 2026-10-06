export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface WakeRetryOptions {
  /** Delays between retries, in ms. Defaults to a ~101s backoff -- see DEFAULT_DELAYS_MS's own comment for why this is well past Render's documented "50 seconds or more" cold-start warning. */
  delaysMs?: number[];
  fetchImpl?: FetchFn;
  /** Called with `true` once a retry starts, and `false` once the request finally succeeds or gives up. */
  onWaking?: (waking: boolean) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The original five delays here summed to ~49s, deliberately matching
 * Render's own documented "50 seconds or more" cold-start warning -- with
 * zero margin above it. A real, repeated report from שלומי ("it never
 * loads, always says the server is old") confirmed that a real cold start
 * regularly takes longer than Render's own stated minimum, especially
 * with no keep-alive ping running (the platform's default branch points
 * at an unrelated repo, so the .github/workflows/keep-alive.yml built for
 * this never actually fires -- see docs/roadmap.md), which means this app
 * is cold-starting on every single visit rather than occasionally. Giving
 * up right at the documented floor turned an occasional slow load into a
 * reliable, total failure. These seven delays sum to ~101s -- roughly
 * double Render's own stated worst case -- while staying comfortably
 * under fetchApi's own REQUEST_TIMEOUT_MS outer ceiling (see api.ts's own
 * comment for that budget's full math).
 *
 * This array is a backoff *shape*, not a hard retry ceiling: once it's
 * exhausted, a caller that supplied its own AbortSignal (every real call
 * through api.ts does) keeps retrying using this array's last delay,
 * repeated, until that signal itself fires -- see the loop below. A fixed
 * small array that silently became the real ceiling is exactly the bug
 * שלומי reported again after this file was already widened once before:
 * the server has grown a lot since round 163 (auth, the build pipeline,
 * WhatsApp/baileys), so a cold boot occasionally runs past this array's
 * own ~101s sum while still comfortably inside api.ts's 220s budget --
 * and the old code threw a hard failure right there instead of using the
 * budget it was actually given.
 */
export const DEFAULT_DELAYS_MS = [3000, 5000, 8000, 12000, 18000, 25000, 30000];

/**
 * Render's free tier spins a service down after inactivity; the next
 * request can take 50+ seconds to connect while it wakes back up. A plain
 * `fetch()` in that window doesn't get an HTTP error response back -- the
 * connection itself fails, which browsers surface as a generic network
 * error ("Load failed" in Safari, "Failed to fetch" elsewhere) well before
 * the server ever gets a chance to answer. Retrying is safe here because a
 * connection failure means the request was never received by the server at
 * all -- nothing to duplicate. Only fetch() throwing (a network-level
 * failure) triggers a retry; an actual HTTP error response (4xx/5xx) is
 * returned immediately, unchanged, for the caller's normal error handling.
 */
export async function fetchWithWakeRetry(
  input: string,
  init?: RequestInit,
  options: WakeRetryOptions = {},
): Promise<Response> {
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Whether the caller handed us its own deadline. When it did (every real
  // call through api.ts does, via fetchApi's REQUEST_TIMEOUT_MS
  // AbortController), that deadline -- not this file's own fixed delay
  // array -- is the real retry ceiling; see DEFAULT_DELAYS_MS's own
  // comment for why a caller-less exhaustion still has to give up on its
  // own (nothing else ever would).
  const hasCallerDeadline = init?.signal != null;
  let waking = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchImpl(input, init);
      } catch (err) {
        // A caller-supplied AbortSignal already firing (e.g. a client-side
        // request timeout in api.ts) is a deliberate cancellation, not a
        // transient cold-start hiccup -- retrying it is pointless (the
        // signal stays aborted, so every retry would fail identically) and
        // would burn through the whole retry backoff sleeping for no
        // reason, on top of whatever the caller's own timeout already was.
        if (init?.signal?.aborted) throw err;
        if (attempt >= delays.length && !hasCallerDeadline) throw err;
        if (!waking) {
          waking = true;
          options.onWaking?.(true);
        }
        // Past the array's own last entry, keep retrying at that same
        // cadence -- the caller's own AbortSignal (checked above, every
        // time around this loop) is what actually ends this, not running
        // out of array entries.
        await sleep(delays[attempt] ?? delays[delays.length - 1]);
      }
    }
  } finally {
    if (waking) options.onWaking?.(false);
  }
}
