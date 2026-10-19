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

  const resBadType = makeRes();
  await addToWatchlist({ body: { symbol: { not: 'a string' } } }, resBadType);
  assert.equal(resBadType.statusCode, 400);
  assert.equal(db.financial_watchlist.all().length, 0);
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
      assert.equal(db.financial_watchlist.all().length, 0);
    } finally {
      restore();
    }
  });
});

test('refreshWatchlistEntry returns 404 for an entry that does not exist', async () => {
  __resetForTests();
  const res = makeRes();
  await refreshWatchlistEntry({ params: { id: 'wl_missing' } }, res);
  assert.equal(res.statusCode, 404);
});

test('refreshWatchlistEntry returns 503 instead of silently reusing a stale price when market data is not connected', async () => {
  __resetForTests();
  const entry = db.financial_watchlist.insert({ id: 'wl_1', symbol: 'AAPL', connected: false, lastPrice: null });
  const res = makeRes();
  await refreshWatchlistEntry({ params: { id: entry.id } }, res);
  assert.equal(res.statusCode, 503);
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
});

test('createPaperTrade rejects an invalid side instead of silently simulating it as a short', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: 'AAPL', side: 'Long', entryPrice: 100, exitPrice: 110, quantity: 1 } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.paper_trades.all().length, 0);
});

test('createPaperTrade rejects non-positive prices/quantity', () => {
  __resetForTests();
  const res = makeRes();
  createPaperTrade({ body: { symbol: 'AAPL', side: 'long', entryPrice: 0, exitPrice: 110, quantity: 1 } }, res);
  assert.equal(res.statusCode, 400);
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
