import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe's well-known convention; Paddle doesn't publish an exact number,
// but a webhook delivery claiming to be 5+ minutes old is never a live
// one - only ever a captured-and-replayed tuple (a compromised log, a
// MITM, or simply resending an old legitimate delivery).
const DEFAULT_TOLERANCE_SECONDS = 300;

// Parses Paddle's "Paddle-Signature" header (`ts=...;h1=...`) and verifies it
// against the raw request body using the webhook's secret key, so a forged
// request can't fake a payment.
//
// Paddle signs the timestamp into the HMAC specifically so a receiver can
// reject stale deliveries - without checking that, a valid (ts, body,
// signature) tuple verifies forever, and replaying one later would pass
// this check exactly as if it just arrived. `now`/`toleranceSeconds` are
// injectable only for tests; real callers use the defaults.
export function verifyPaddleSignature({ rawBody, signatureHeader, secret, now = Date.now(), toleranceSeconds = DEFAULT_TOLERANCE_SECONDS }) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(';').map((pair) => pair.split('=')));
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds) || Math.abs(now / 1000 - tsSeconds) > toleranceSeconds) return false;

  const computed = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(h1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
