import { createHmac, timingSafeEqual } from 'node:crypto';

// Paddle's own docs describe ts as Unix time (seconds) when the webhook was
// sent - reusing a correctly-signed-but-old request (e.g. one captured from
// a compromised log, or before TLS termination) stays validly signed
// forever without this, since nothing else about the signature depends on
// when it's replayed. billing.js's own externalId check already blocks a
// replayed transaction.completed from recording duplicate revenue, so this
// isn't the only thing standing between a captured request and a real
// effect - but it's still a standard, defense-in-depth webhook practice
// (the same approach Stripe and others document) not to accept on
// signature validity alone. 5 minutes comfortably covers normal network/
// clock variance without meaningfully widening a real replay window.
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

// Parses Paddle's "Paddle-Signature" header (`ts=...;h1=...`) and verifies it
// against the raw request body using the webhook's secret key, so a forged
// request can't fake a payment.
export function verifyPaddleSignature({ rawBody, signatureHeader, secret, now = Date.now(), maxAgeSeconds = MAX_SIGNATURE_AGE_SECONDS }) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(';').map((pair) => pair.split('=')));
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  // Number('') is 0 and Number('abc') is NaN - either would otherwise let a
  // malformed ts slip through the age check below as either "always too
  // old" (harmless, just a confusing rejection reason) or, worse for NaN,
  // "age is NaN", and NaN > maxAgeSeconds is false, which would silently
  // defeat this check entirely for a non-numeric ts.
  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds)) return false;
  const ageSeconds = Math.abs(now / 1000 - tsSeconds);
  if (ageSeconds > maxAgeSeconds) return false;

  const computed = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(h1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
