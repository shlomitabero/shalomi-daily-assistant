export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface WakeRetryOptions {
  /** Delays between retries, in ms. Defaults to a ~49s backoff, matching Render's free-tier "50 seconds or more" cold-start warning. */
  delaysMs?: number[];
  fetchImpl?: FetchFn;
  /** Called with `true` once a retry starts, and `false` once the request finally succeeds or gives up. */
  onWaking?: (waking: boolean) => void;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_DELAYS_MS = [2000, 4000, 8000, 15000, 20000];

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
  let waking = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchImpl(input, init);
      } catch (err) {
        if (attempt >= delays.length) throw err;
        if (!waking) {
          waking = true;
          options.onWaking?.(true);
        }
        await sleep(delays[attempt]);
      }
    }
  } finally {
    if (waking) options.onWaking?.(false);
  }
}
