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
export function createLoginRateLimiter({ maxAttempts = 10, windowMs = 5 * 60 * 1000 } = {}) {
  const failuresByKey = new Map();

  function recentFailures(key, now) {
    const timestamps = (failuresByKey.get(key) ?? []).filter((t) => now - t < windowMs);
    failuresByKey.set(key, timestamps);
    return timestamps;
  }

  return {
    isBlocked(key, now = Date.now()) {
      return recentFailures(key, now).length >= maxAttempts;
    },
    recordFailure(key, now = Date.now()) {
      recentFailures(key, now).push(now);
    },
    // A correct password immediately clears this key's failure history -
    // without this, a few mistyped attempts followed by the right password
    // would still silently count toward locking the owner out of their
    // next real mistake, for no reason once they've actually proven who
    // they are.
    recordSuccess(key) {
      failuresByKey.delete(key);
    },
  };
}
