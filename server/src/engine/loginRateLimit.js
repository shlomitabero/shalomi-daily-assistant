// A brute-force guard for the single /login endpoint. verifyOwnerPassword
// already uses a constant-time comparison (timingSafeEqual) to prevent a
// timing attack, but nothing stopped an unlimited number of guesses per
// second otherwise - this is a personal console reachable on the open
// internet with a single password and no username to even slow a guesser
// down. In-memory only (not persisted) is an accepted tradeoff: this app
// redeploys roughly hourly, so a restart resets an attacker's count, but
// it still meaningfully throttles an automated guessing script within any
// given deploy window, and never locks the real owner out for longer than
// windowMs.
// maxTrackedKeys bounds failuresByKey itself, separately from maxAttempts
// (which only bounds how many timestamps one key can hold). Without it,
// this map had no ceiling at all: every distinct req.ip that ever failed
// once stayed in it, with nothing ever removing a key whose own failures
// had long since aged out of the window - the real bug isn't the memory a
// genuine attacker leaves behind (this app redeploys roughly hourly,
// clearing it), it's that this endpoint is reachable by anyone on the open
// internet, including the constant background noise of scanners/bots
// probing random paths with wrong-looking requests, each one a distinct
// IP that would sit in this map doing nothing until the next restart.
export function createLoginRateLimiter({ maxAttempts = 10, windowMs = 5 * 60 * 1000, maxTrackedKeys = 1000 } = {}) {
  const failuresByKey = new Map();

  function recentFailures(key, now) {
    const timestamps = (failuresByKey.get(key) ?? []).filter((t) => now - t < windowMs);
    // A key whose failures have all aged out no longer blocks anything -
    // keeping it in the map anyway (the previous behavior) only grows
    // failuresByKey forever for a client that never comes back for a
    // second look.
    if (timestamps.length === 0) failuresByKey.delete(key);
    else failuresByKey.set(key, timestamps);
    return timestamps;
  }

  return {
    isBlocked(key, now = Date.now()) {
      return recentFailures(key, now).length >= maxAttempts;
    },
    recordFailure(key, now = Date.now()) {
      // A brand-new key about to be tracked, with the map already at its
      // cap, evicts the single oldest entry first - Map iterates in
      // insertion order and re-setting an existing key never changes its
      // position, so the first key here is genuinely the longest-tracked
      // one, a reasonable stand-in for "least likely to still be the
      // attacker mid-attack" when there's no real way to know which key
      // is safe to drop.
      if (!failuresByKey.has(key) && failuresByKey.size >= maxTrackedKeys) {
        failuresByKey.delete(failuresByKey.keys().next().value);
      }
      const timestamps = recentFailures(key, now);
      timestamps.push(now);
      failuresByKey.set(key, timestamps);
    },
    // A correct password immediately clears this key's failure history -
    // without this, a few mistyped attempts followed by the right password
    // would still silently count toward locking the owner out of their
    // next real mistake, for no reason once they've actually proven who
    // they are.
    recordSuccess(key) {
      failuresByKey.delete(key);
    },
    // Exposes the current tracked-key count for tests (and, in principle,
    // a future ops/health signal) without exposing the map itself.
    trackedKeyCount() {
      return failuresByKey.size;
    },
  };
}
