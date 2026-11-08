// Thin wrapper around Paddle's REST API for one-time digital-product sales
// (not a subscription — the owner's product is bought once per customer).
function paddleApiBase() {
  return process.env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}

function paddleHeaders() {
  return { authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'content-type': 'application/json' };
}

const FETCH_TIMEOUT_MS = 10_000;

// Without a timeout, an unresponsive Paddle API (an outage, a hung
// connection) would leave the owner's "פרסם מוצר" click pending
// indefinitely — in the one path that actually moves toward real money,
// that's worse than a clear error.
async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // Reaches the owner verbatim via routes/opportunities.js's publish
    // route (`הפרסום נכשל: ${err.message}`) on "פרסם מוצר" - the one
    // action that actually moves toward real money in this app. A plain
    // network-layer failure (the other branch, an ENOTFOUND/connection
    // reset) is deliberately NOT wrapped here (see this file's own test
    // "propagates a real network failure as-is, not mislabeled as a
    // timeout") - showing the real underlying error is more useful to
    // the owner than a generic message, and this app's whole philosophy
    // is never to disguise a real failure as something else. A timeout
    // has no such "real" message to preserve, so it's safe - and more
    // honest - to give it a clean Hebrew one instead of this file's own
    // English wording.
    if (err.name === 'AbortError') throw new Error('הבקשה ל-Paddle לא קיבלה מענה בזמן');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  return res;
}

// All three must be set, not just the two that let a checkout open.
// Without PADDLE_WEBHOOK_SECRET, verifyPaddleSignature always returns
// false (it treats a missing secret the same as a missing signature), so
// a real customer could pay through a real checkout and the webhook that
// confirms it would be silently rejected — the sale never gets recorded
// as revenue and the customer never receives their guide. "Configured"
// has to mean the whole path works end to end, not just that checkout
// can be opened.
export function isPaddleConfigured() {
  return Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN && process.env.PADDLE_WEBHOOK_SECRET);
}

export function paddleClientConfig() {
  return {
    clientToken: process.env.PADDLE_CLIENT_TOKEN || null,
    sandbox: process.env.PADDLE_ENV === 'sandbox',
  };
}

export async function createOneTimePrice({ name, amountCents, currencyCode = 'USD', timeoutMs = FETCH_TIMEOUT_MS }) {
  const productRes = await fetchWithTimeout(`${paddleApiBase()}/products`, {
    method: 'POST',
    headers: paddleHeaders(),
    body: JSON.stringify({ name, tax_category: 'standard' }),
  }, timeoutMs);
  // The lead-in text is this file's own wording, translated; Paddle's own
  // response body stays as-is (real third-party diagnostic content, not
  // ours to translate — same reasoning as the network-failure case above).
  if (!productRes.ok) throw new Error(`יצירת מוצר ב-Paddle נכשלה: ${await productRes.text()}`);
  const { data: product } = await productRes.json();

  const priceRes = await fetchWithTimeout(`${paddleApiBase()}/prices`, {
    method: 'POST',
    headers: paddleHeaders(),
    body: JSON.stringify({
      product_id: product.id,
      description: name,
      unit_price: { amount: String(amountCents), currency_code: currencyCode },
    }),
  }, timeoutMs);
  if (!priceRes.ok) throw new Error(`יצירת מחיר ב-Paddle נכשלה: ${await priceRes.text()}`);
  const { data: price } = await priceRes.json();
  return { productId: product.id, priceId: price.id };
}
