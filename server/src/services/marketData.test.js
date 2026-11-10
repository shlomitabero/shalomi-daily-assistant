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

test('fetchQuote wraps a raw network-layer failure in a Hebrew message instead of surfacing it as-is', () => {
  // A DNS failure, connection reset, or TLS error throws its own English
  // message straight from the fetch implementation — fine for the Railway
  // log viewer (still logged via console.error), but not fit to show the
  // owner directly on the Financial page like every other error here.
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  console.error = () => {};
  return fetchQuote('AAPL').then(
    () => assert.fail('expected fetchQuote to reject'),
    (err) => assert.match(err.message, /נכשלה מסיבה לא צפויה/)
  ).finally(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  });
});

test('fetchQuote times out instead of hanging forever when the provider never responds', async () => {
  // Without an explicit timeout, a hung connection to the provider would
  // leave this (and the watchlist's "refresh all", which awaits each
  // symbol in turn) pending indefinitely with no feedback to the owner.
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, { signal } = {}) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    await assert.rejects(() => fetchQuote('AAPL', { timeoutMs: 5 }), /לא קיבלה מענה בזמן/);
  } finally {
    globalThis.fetch = originalFetch;
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
});

test('fetchQuote throws a clean Hebrew error, not a raw JSON.parse SyntaxError, when the provider returns a 2xx with a non-JSON body', async () => {
  // res.json() was the one call in this function left outside any
  // try/catch - a 200 with a malformed body (a gateway error page, a
  // truncated response) would throw its own raw English SyntaxError,
  // reaching the owner verbatim via routes/financial.js's
  // `לא ניתן היה לקבל מחיר: ${err.message}` on both "add to watchlist"
  // and "refresh" - untranslated English dropped into an otherwise
  // all-Hebrew error line.
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
  console.error = () => {};
  try {
    await assert.rejects(() => fetchQuote('AAPL'), /מקור נתוני השוק החזיר תגובה שאינה JSON תקין/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
});

test('fetchQuote propagates a malformed-price error instead of returning a NaN quote', async () => {
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  const restore = stubFetchOnce({ body: { price: 'N/A' } });
  try {
    await assert.rejects(() => fetchQuote('AAPL'), /מחיר שאינו מספר/);
  } finally {
    restore();
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
});
