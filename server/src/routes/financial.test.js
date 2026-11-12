import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import {
  listWatchlist, addToWatchlist, refreshWatchlistEntry, deleteWatchlistEntry,
  createPaperTrade, listPaperTrades,
} from './financial.js';

function makeRes() {
  const res = { statusCode: null, body: null, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

function stubFetchOnce(response) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: response.ok ?? true, status: response.status ?? 200, json: async () => response.body });
  return () => { globalThis.fetch = original; };
}

function withMarketDataKey(fn) {
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  return fn().finally(() => {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  });
}

test('addToWatchlist rejects a missing or non-string symbol instead of storing a value that would crash the Financial page render', async () => {
  __resetForTests();
  const resMissing = makeRes();
  await addToWatchlist({ body: {} }, resMissing);
  assert.equal(resMissing.statusCode, 400);
  assert.match(resMissing.body.error, /סימבול הוא שדה חובה/);

  const resBadType = makeRes();
  await addToWatchlist({ body: { symbol: { not: 'a string' } } }, resBadType);
  assert.equal(resBadType.statusCode, 400);
  assert.equal(db.financial_watchlist.all().length, 0);
});

test('addToWatchlist rejects a request with no body at all instead of throwing', async () => {
  // req.body is undefined, not {}, when body-parser didn't run for this
  // request at all (e.g. a missing/wrong content-type) - every other test
  // always supplies a body object, even an empty one.
  __resetForTests();
  const res = makeRes();
  await addToWatchlist({}, res);
  assert.equal(res.statusCode, 400);
});

test('addToWatchlist stores an honest disconnected entry when no market data key is configured', async () => {
  __resetForTests();
  const original = process.env.MARKET_DATA_API_KEY;
  delete process.env.MARKET_DATA_API_KEY;
  try {
    const res = makeRes();
    await addToWatchlist({ body: { symbol: 'AAPL' } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.entry.connected, false);
    assert.equal(res.body.entry.lastPrice, null);
    assert.equal(res.body.entry.dataSource, null);
  } finally {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
  }
});

test('addToWatchlist fetches and stores a real quote when market data is connected', async () => {
  __resetForTests();
  await withMarketDataKey(async () => {
    const restore = stubFetchOnce({ body: { price: '192.53' } });
    try {
      const res = makeRes();
      await addToWatchlist({ body: { symbol: 'AAPL' } }, res);
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.entry.connected, true);
      assert.equal(res.body.entry.lastPrice, 192.53);
      assert.equal(res.body.entry.dataSource, 'twelvedata');
    } finally {
      restore();
    }
  });
});

test('addToWatchlist surfaces a 502 instead of storing a broken entry when the quote provider fails', async () => {
  __resetForTests();
  await withMarketDataKey(async () => {
    const restore = stubFetchOnce({ ok: false, status: 429 });
    try {
      const res = makeRes();
      await addToWatchlist({ body: { symbol: 'AAPL' } }, res);
      assert.equal(res.statusCode, 502);
      assert.match(res.body.error, /לא ניתן היה לקבל מחיר/);
      assert.equal(db.financial_watchlist.all().length, 0);
      // A real external API failure (the market data provider) must leave a
      // trace in the activity log, not just a one-time error shown
      // synchronously in the add-symbol form - same reasoning as the
      // manual "new digital product" form's own equivalent AI-call-failure
      // logging.
      const logged = db.actions_log.where((a) => a.type === 'market_quote_fetch' && a.result === 'failed');
      assert.equal(logged.length, 1);
      assert.equal(logged[0].detail.symbol, 'AAPL');
      assert.match(logged[0].detail.error, /429/);
    } finally {
      restore();
    }
  });
});

test('addToWatchlist normalizes casing and whitespace so the symbol is stored consistently', async () => {
  __resetForTests();
  const original = process.env.MARKET_DATA_API_KEY;
  delete process.env.MARKET_DATA_API_KEY;
  try {
    const res = makeRes();
    await addToWatchlist({ body: { symbol: '  aapl  ' } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.entry.symbol, 'AAPL');
  } finally {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
  }
});

test('addToWatchlist rejects a symbol already on the watchlist instead of creating a duplicate row', async () => {
  // Without this, "AAPL" and "aapl" (or a double-click of "add") would
  // create two separate rows for the same real symbol, each refreshed
  // independently by the "refresh all" button.
  __resetForTests();
  const original = process.env.MARKET_DATA_API_KEY;
  delete process.env.MARKET_DATA_API_KEY;
  try {
    const res1 = makeRes();
    await addToWatchlist({ body: { symbol: 'AAPL' } }, res1);
    assert.equal(res1.statusCode, 201);

    const res2 = makeRes();
    await addToWatchlist({ body: { symbol: 'aapl' } }, res2);
    assert.equal(res2.statusCode, 409);
    assert.match(res2.body.error, /AAPL כבר נמצא ברשימת המעקב/);
    assert.equal(db.financial_watchlist.all().length, 1);
  } finally {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
  }
});

test('two concurrent addToWatchlist calls for the same symbol never both insert - the alreadyTracked check alone has an async gap this closes', async () => {
  // alreadyTracked is read BEFORE the await fetchQuote() call below it -
  // without a lock held across that gap, two near-simultaneous requests
  // for the same symbol (a double-click, two open tabs) could both read
  // "not yet tracked" before either had inserted, exactly the duplicate
  // row that check exists to prevent. Holding fetchQuote open via a gate
  // this test controls proves both calls are genuinely in flight at once,
  // not just run one after the other.
  __resetForTests();
  await withMarketDataKey(async () => {
    let releaseFetch;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      await fetchGate;
      return { ok: true, status: 200, json: async () => ({ price: '192.53' }) };
    };
    try {
      const res1 = makeRes();
      const res2 = makeRes();
      const firstPromise = addToWatchlist({ body: { symbol: 'AAPL' } }, res1);
      const secondPromise = addToWatchlist({ body: { symbol: 'AAPL' } }, res2);
      releaseFetch();
      await Promise.all([firstPromise, secondPromise]);
      const statuses = [res1.statusCode, res2.statusCode].sort();
      assert.deepEqual(statuses, [201, 409]);
      assert.equal(db.financial_watchlist.all().length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('addToWatchlist for a DIFFERENT symbol is never blocked by a concurrent call for another one', async () => {
  __resetForTests();
  const original = process.env.MARKET_DATA_API_KEY;
  delete process.env.MARKET_DATA_API_KEY;
  try {
    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([
      addToWatchlist({ body: { symbol: 'AAPL' } }, res1),
      addToWatchlist({ body: { symbol: 'MSFT' } }, res2),
    ]);
    assert.equal(res1.statusCode, 201);
    assert.equal(res2.statusCode, 201);
    assert.equal(db.financial_watchlist.all().length, 2);
  } finally {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
  }
});

test('the lock releases after a failed quote fetch, so a retry for the same symbol is never permanently stuck', async () => {
  __resetForTests();
  await withMarketDataKey(async () => {
    const restoreFail = stubFetchOnce({ ok: false, status: 429 });
    const resFail = makeRes();
    await addToWatchlist({ body: { symbol: 'AAPL' } }, resFail);
    assert.equal(resFail.statusCode, 502);
    restoreFail();

    const restoreOk = stubFetchOnce({ body: { price: '192.53' } });
    try {
      const resOk = makeRes();
      await addToWatchlist({ body: { symbol: 'AAPL' } }, resOk);
      assert.equal(resOk.statusCode, 201);
    } finally {
      restoreOk();
    }
  });
});

test('refreshWatchlistEntry returns 404 for an entry that does not exist', async () => {
  __resetForTests();
  const res = makeRes();
  await refreshWatchlistEntry({ params: { id: 'wl_missing' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'לא נמצא');
});

test('refreshWatchlistEntry returns 503 instead of silently reusing a stale price when market data is not connected', async () => {
  __resetForTests();
  const entry = db.financial_watchlist.insert({ id: 'wl_1', symbol: 'AAPL', connected: false, lastPrice: null });
  const res = makeRes();
  await refreshWatchlistEntry({ params: { id: entry.id } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'מקור נתוני שוק לא מחובר');
});

test('refreshWatchlistEntry updates a previously-disconnected entry to the current real price and connected state', async () => {
  __resetForTests();
  const entry = db.financial_watchlist.insert({
    id: 'wl_1', symbol: 'AAPL', connected: false, dataSource: null, lastPrice: null, lastUpdatedAt: null,
  });
  await withMarketDataKey(async () => {
    const restore = stubFetchOnce({ body: { price: '201.10' } });
    try {
      const res = makeRes();
      await refreshWatchlistEntry({ params: { id: entry.id } }, res);
      assert.equal(res.body.entry.connected, true);
      assert.equal(res.body.entry.lastPrice, 201.1);
      assert.equal(res.body.entry.dataSource, 'twelvedata');
    } finally {
      restore();
    }
  });
});

test('refreshWatchlistEntry surfaces a 502 instead of silently keeping the stale price when the quote provider fails', async () => {
  // Mirrors addToWatchlist's own 502-on-provider-failure test above — this
  // route makes the exact same fetchQuote call but had no test for its
  // failure path, even though a failed refresh must never look like it
  // succeeded (nor silently fall back to the old, now-stale price).
  __resetForTests();
  const entry = db.financial_watchlist.insert({
    id: 'wl_1', symbol: 'AAPL', connected: false, dataSource: null, lastPrice: null, lastUpdatedAt: null,
  });
  await withMarketDataKey(async () => {
    const restore = stubFetchOnce({ ok: false, status: 429 });
    try {
      const res = makeRes();
      await refreshWatchlistEntry({ params: { id: entry.id } }, res);
      assert.equal(res.statusCode, 502);
      assert.match(res.body.error, /לא ניתן היה לקבל מחיר/);
      const unchanged = db.financial_watchlist.get(entry.id);
      assert.equal(unchanged.connected, false);
      assert.equal(unchanged.lastPrice, null);
      // Same activity-log gap as addToWatchlist's own equivalent failure.
      const logged = db.actions_log.where((a) => a.type === 'market_quote_fetch' && a.result === 'failed');
      assert.equal(logged.length, 1);
      assert.equal(logged[0].detail.symbol, 'AAPL');
      assert.match(logged[0].detail.error, /429/);
    } finally {
      restore();
    }
  });
});

test('deleteWatchlistEntry removes an existing entry and 404s for one that does not exist', () => {
  __resetForTests();
  const entry = db.financial_watchlist.insert({ id: 'wl_1', symbol: 'AAPL' });
  const res = makeRes();
  deleteWatchlistEntry({ params: { id: entry.id } }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(db.financial_watchlist.get(entry.id), null);

  const res2 = makeRes();
  deleteWatchlistEntry({ params: { id: entry.id } }, res2);
  assert.equal(res2.statusCode, 404);
  assert.equal(res2.body.error, 'לא נמצא');
});

test('createPaperTrade rejects a whitespace-only symbol instead of storing a blank-looking trade', () => {
  // Mirrors addToWatchlist's own !symbol.trim() check - without it, a
  // symbol of "   " (the client sends no trim before uppercasing either)
  // would pass straight through and get stored as a trade nobody could
  // make sense of in the list.
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: '   ', side: 'long', entryPrice: 100, exitPrice: 110, quantity: 1 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /סימבול הוא שדה חובה/);
  assert.equal(db.paper_trades.all().length, 0);
});

test('createPaperTrade normalizes casing and whitespace, not just trusting whatever the client sends', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: '  aapl  ', side: 'long', entryPrice: 100, exitPrice: 110, quantity: 1 } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.trade.symbol, 'AAPL');
});

test('createPaperTrade rejects an invalid side instead of silently simulating it as a short', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: 'AAPL', side: 'Long', entryPrice: 100, exitPrice: 110, quantity: 1 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /הצד חייב להיות אחד מ/);
  assert.equal(db.paper_trades.all().length, 0);
});

test('createPaperTrade rejects a request with no body at all instead of throwing', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({}, res);
  assert.equal(res.statusCode, 400);
});

test('createPaperTrade rejects non-positive prices/quantity', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: 'AAPL', side: 'long', entryPrice: 0, exitPrice: 110, quantity: 1 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /מחיר כניסה חייב להיות מספר חיובי/);
});

test('createPaperTrade rejects a non-positive exitPrice even when entryPrice is valid', () => {
  // The entryPrice/exitPrice/quantity checks are three independent ifs, not
  // an else-chain - the test above only ever exercised entryPrice being
  // invalid, so exitPrice's own check had never actually been taken with a
  // valid entryPrice in front of it.
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: 'AAPL', side: 'long', entryPrice: 100, exitPrice: -5, quantity: 1 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /מחיר יציאה חייב להיות מספר חיובי/);
  assert.equal(db.paper_trades.all().length, 0);
});

test('createPaperTrade rejects a non-positive quantity even when both prices are valid', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: 'AAPL', side: 'long', entryPrice: 100, exitPrice: 110, quantity: 0 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /כמות חייבת להיות מספר חיובי/);
  assert.equal(db.paper_trades.all().length, 0);
});

test('createPaperTrade stores a simulated trade and logs it, never touching the real ledger', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: 'AAPL', side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10 } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.trade.simulated, true);
  assert.equal(db.ledger.all().length, 0);

  const logged = db.actions_log.where((a) => a.type === 'paper_trade');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].detail.symbol, 'AAPL');
});

test('listPaperTrades returns trades newest first', () => {
  // createPaperTrade stamps createdAt with the real clock, so two trades
  // created back-to-back in a test can land in the same millisecond and
  // never actually exercise the sort comparator either way - insert
  // directly with explicit, clearly-ordered timestamps so this checks the
  // real sort order instead of relying on test-run timing.
  __resetForTests();
  db.paper_trades.insert({ id: 'pt_older', symbol: 'AAPL', side: 'long', createdAt: '2026-01-01T00:00:00.000Z' });
  db.paper_trades.insert({ id: 'pt_newer', symbol: 'MSFT', side: 'short', createdAt: '2026-01-02T00:00:00.000Z' });

  const res = makeRes();
  listPaperTrades({}, res);
  assert.deepEqual(res.body.trades.map((t) => t.id), ['pt_newer', 'pt_older']);
});

test('listPaperTrades caps the response at the 100 most recent trades, newest first', () => {
  // Same unbounded-growth pattern already fixed for listDigests
  // (server/src/routes/digest.js) - a simulation-only list that only ever
  // grows every time the owner runs one, with no pagination anywhere in
  // the client. Unlike the opportunities/approvals lists, nothing else
  // looks up a paper trade by id from this same fetch, so a server-side
  // cap carries no correctness risk here.
  __resetForTests();
  for (let i = 0; i < 105; i += 1) {
    db.paper_trades.insert({
      id: `pt_${i}`, symbol: 'AAPL', side: 'long',
      createdAt: new Date(2026, 0, 1 + i).toISOString(),
    });
  }
  const res = makeRes();
  listPaperTrades({}, res);
  assert.equal(res.body.trades.length, 100);
  assert.equal(res.body.trades[0].id, 'pt_104');
  assert.equal(res.body.trades[99].id, 'pt_5');
});

test('listWatchlist and listPaperTrades return what was stored', () => {
  __resetForTests();
  db.financial_watchlist.insert({ id: 'wl_1', symbol: 'AAPL' });
  createPaperTrade({ body: { symbol: 'AAPL', side: 'long', entryPrice: 100, exitPrice: 110, quantity: 1 } }, makeRes());

  const wlRes = makeRes();
  listWatchlist({}, wlRes);
  assert.equal(wlRes.body.watchlist.length, 1);

  const ptRes = makeRes();
  listPaperTrades({}, ptRes);
  assert.equal(ptRes.body.trades.length, 1);
});
