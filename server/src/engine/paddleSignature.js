import { createHmac, timingSafeEqual } from 'node:crypto';

// Parses Paddle's "Paddle-Signature" header (`ts=...;h1=...`) and verifies it
// against the raw request body using the webhook's secret key, so a forged
// request can't fake a payment.
export function verifyPaddleSignature({ rawBody, signatureHeader, secret }) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(';').map((pair) => pair.split('=')));
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  const computed = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(h1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
