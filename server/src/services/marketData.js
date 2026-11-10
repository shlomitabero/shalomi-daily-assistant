import { parseQuotePrice } from '../engine/marketQuote.js';

// Real market data only — never a fabricated price. Returns null when no
// provider is configured so the caller can show "not connected" honestly.
export function isMarketDataConnected() {
  return Boolean(process.env.MARKET_DATA_API_KEY);
}

const FETCH_TIMEOUT_MS = 10_000;

// Without a timeout, an unresponsive provider (an outage, a hung TCP
// connection) would leave this request pending indefinitely — and since
// the "refresh all" watchlist action awaits each symbol's refresh one at a
// time, a single stuck request would freeze that button forever with no
// feedback, not just this one symbol's refresh.
export async function fetchQuote(symbol, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(
      `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${process.env.MARKET_DATA_API_KEY}`,
      { signal: controller.signal }
    );
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('הבקשה למקור נתוני השוק לא קיבלה מענה בזמן');
    // A raw network-layer failure (DNS, connection reset, TLS) comes with
    // its own English message from the fetch implementation itself — not
    // fit to show the owner directly, but worth keeping in Railway's own
    // log viewer for anyone actually debugging "the price feed stopped
    // working", the same split every other service-level failure in this
    // app already uses (a clean Hebrew message to the owner, the raw
    // technical detail to console.error).
    console.error('fetchQuote: network request to market data provider failed', err);
    throw new Error('הבקשה למקור נתוני השוק נכשלה מסיבה לא צפויה — בדוק את לוגי השרת');
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`הבקשה למקור נתוני השוק נכשלה עם קוד סטטוס ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch (err) {
    // A 2xx response with a body that isn't valid JSON (a gateway error
    // page, a truncated response) would otherwise throw a raw English
    // SyntaxError straight from res.json() - unlike every other failure in
    // this function, this one wasn't caught at all, so it reached the
    // owner verbatim via routes/financial.js's `לא ניתן היה לקבל מחיר:
    // ${err.message}` on both the "add to watchlist" and "refresh" actions.
    console.error('fetchQuote: market data provider returned a non-JSON response', err);
    throw new Error('מקור נתוני השוק החזיר תגובה שאינה JSON תקין');
  }
  return { price: parseQuotePrice(data), fetchedAt: new Date().toISOString() };
}
