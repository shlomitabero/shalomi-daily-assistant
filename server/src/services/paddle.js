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
//
// onResponse reads the body (res.text()/res.json(), via parsePaddleJson)
// while the SAME timeout is still running, not after it's already been
// cleared - fetch() itself only resolves once response HEADERS arrive, not
// once the body has actually been read, so a Paddle response that starts
// promptly but then stalls or drip-feeds its body used to have zero
// timeout protection at that stage, reproducing the exact "owner's publish
// click pending indefinitely" failure mode this comment already warns
// about, just one stage later. Keeping the timer alive across both fetch()
// and onResponse(), clearing it only once in the shared finally below,
// means the same abort signal still fires and cancels a stall during body
// reading too.
async function fetchWithTimeout(url, options, onResponse, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return await onResponse(res);
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
    // English wording. onResponse's own !res.ok / non-JSON errors are
    // plain Errors (name 'Error', never 'AbortError'), so they fall
    // through to the rethrow below unchanged either way.
    if (err.name === 'AbortError') throw new Error('הבקשה ל-Paddle לא קיבלה מענה בזמן');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
  // The lead-in text in each !res.ok branch below is this file's own
  // wording, translated; Paddle's own response body stays as-is (real
  // third-party diagnostic content, not ours to translate — same
  // reasoning as the network-failure case in fetchWithTimeout above).
  const productJson = await fetchWithTimeout(`${paddleApiBase()}/products`, {
    method: 'POST',
    headers: paddleHeaders(),
    body: JSON.stringify({ name, tax_category: 'standard' }),
  }, async (res) => {
    if (!res.ok) throw new Error(`יצירת מוצר ב-Paddle נכשלה: ${await res.text()}`);
    return parsePaddleJson(res, 'מוצר');
  }, timeoutMs);
  const product = productJson.data;

  const priceJson = await fetchWithTimeout(`${paddleApiBase()}/prices`, {
    method: 'POST',
    headers: paddleHeaders(),
    body: JSON.stringify({
      product_id: product.id,
      description: name,
      unit_price: { amount: String(amountCents), currency_code: currencyCode },
    }),
  }, async (res) => {
    if (!res.ok) throw new Error(`יצירת מחיר ב-Paddle נכשלה: ${await res.text()}`);
    return parsePaddleJson(res, 'מחיר');
  }, timeoutMs);
  const price = priceJson.data;

  return { productId: product.id, priceId: price.id };
}

// A 2xx response whose body isn't valid JSON (unexpected from Paddle, but
// possible from a gateway/proxy error in front of it) threw a raw English
// SyntaxError straight from res.json() - unlike the !res.ok branches above,
// which deliberately keep Paddle's own raw diagnostic text as-is (this
// file's own documented exception, since that's real third-party content
// worth showing verbatim), a JSON-parsing artifact isn't "the real error
// from Paddle" at all. It reached the owner verbatim via
// routes/opportunities.js's publish route (`הפרסום נכשל: ${err.message}`) -
// the one path in this app that actually moves toward real money.
async function parsePaddleJson(res, labelHebrew) {
  try {
    return await res.json();
  } catch (err) {
    // A stall during body reading throws the same AbortError res.json()
    // would throw for any other reason - mislabeling it as "not valid
    // JSON" here would hide the real cause (a timeout) from
    // fetchWithTimeout's own catch, which is what actually turns it into
    // the correct, clean "לא קיבלה מענה בזמן" message.
    if (err.name === 'AbortError') throw err;
    console.error(`createOneTimePrice: Paddle returned a non-JSON response for the ${labelHebrew} call`, err);
    throw new Error(`Paddle החזיר תגובה שאינה JSON תקין בעת יצירת ${labelHebrew}`);
  }
}
