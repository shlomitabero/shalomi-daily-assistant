import { parseQuotePrice } from '../engine/marketQuote.js';

// Real market data only — never a fabricated price. Returns null when no
// provider is configured so the caller can show "not connected" honestly.
export function isMarketDataConnected() {
  return Boolean(process.env.MARKET_DATA_API_KEY);
}

export async function fetchQuote(symbol) {
  const res = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${process.env.MARKET_DATA_API_KEY}`);
  if (!res.ok) throw new Error(`market data request failed with status ${res.status}`);
  const data = await res.json();
  return { price: parseQuotePrice(data), fetchedAt: new Date().toISOString() };
}
