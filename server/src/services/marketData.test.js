import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMarketDataConnected, fetchQuote } from './marketData.js';

function stubFetchOnce(response) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    globalThis.__lastFetchUrl = url;
    return { ok: response.ok ?? true, status: response.status ?? 200, json: async () => response.body };
  };
  return () => { globalThis.fetch = original; };
}

test('isMarketDataConnected is false when no API key is set', () => {
  // This is what the Financial page's "connected" dot and watchlist refresh
  // button are gated on — it must never read as connected without a real
  // key configured, or the owner would see a live-looking price feed that
  // isn't actually hitting any provider.
  const original = process.env.MARKET_DATA_API_KEY;
  delete process.env.MARKET_DATA_API_KEY;
  try {
    assert.equal(isMarketDataConnected(), false);
  } finally {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
  }
});

test('isMarketDataConnected is true once an API key is set', () => {
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'some-key';
  try {
    assert.equal(isMarketDataConnected(), true);
  } finally {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
});

test('fetchQuote requests the given symbol with the configured API key and returns a real price', async () => {
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  const restore = stubFetchOnce({ body: { price: '192.53' } });
  try {
    const quote = await fetchQuote('AAPL');
    assert.equal(quote.price, 192.53);
    assert.ok(quote.fetchedAt);
    assert.match(globalThis.__lastFetchUrl, /symbol=AAPL/);
    assert.match(globalThis.__lastFetchUrl, /apikey=test-key/);
  } finally {
    restore();
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
});

test('fetchQuote throws with the HTTP status when the provider request itself fails', async () => {
  // A non-2xx here (rate limit, outage, bad symbol at the transport level)
  // must surface as a clear error, not silently flow into parseQuotePrice
  // against a non-JSON or empty error-page body.
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  const restore = stubFetchOnce({ ok: false, status: 429, body: {} });
  try {
    await assert.rejects(() => fetchQuote('AAPL'), /429/);
  } finally {
    restore();
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
});

test('fetchQuote propagates a malformed-price error instead of returning a NaN quote', async () => {
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  const restore = stubFetchOnce({ body: { price: 'N/A' } });
  try {
    await assert.rejects(() => fetchQuote('AAPL'), /non-numeric price/);
  } finally {
    restore();
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
});
