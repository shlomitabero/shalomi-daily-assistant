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
    if (err.name === 'AbortError') throw new Error('market data request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`market data request failed with status ${res.status}`);
  const data = await res.json();
  return { price: parseQuotePrice(data), fetchedAt: new Date().toISOString() };
}
