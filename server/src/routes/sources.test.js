import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, __resetForTests } from '../db/store.js';
import { listSources, rescanSources } from './sources.js';

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.statusCode ??= 200; return res; };
  return res;
}

function withMarketDataKey(fn) {
  const original = process.env.MARKET_DATA_API_KEY;
  process.env.MARKET_DATA_API_KEY = 'test-key';
  try {
    fn();
  } finally {
    if (original !== undefined) process.env.MARKET_DATA_API_KEY = original;
    else delete process.env.MARKET_DATA_API_KEY;
  }
}

test('listSources returns the synced source list', () => {
  __resetForTests();
  const res = makeRes();
  listSources({}, res);
  assert.ok(res.body.sources.length > 0);
});

test('rescanSources stamps lastScannedAt only on sources that are actually connected', () => {
  // A disconnected source is never really scanned — stamping it anyway
  // would make the owner think it was checked when nothing happened.
  __resetForTests();
  withMarketDataKey(() => {
    const res = makeRes();
    rescanSources({}, res);

    const financial = res.body.sources.find((s) => s.key === 'financial_markets');
    const tenders = res.body.sources.find((s) => s.key === 'tenders_rfps');
    assert.equal(financial.connected, true);
    assert.ok(financial.lastScannedAt);
    assert.equal(tenders.connected, false);
    assert.equal(tenders.lastScannedAt, null);
  });
});

test('rescanSources leaves every source untouched (no lastScannedAt) when nothing is connected', () => {
  __resetForTests();
  const res = makeRes();
  rescanSources({}, res);
  for (const source of res.body.sources) {
    assert.equal(source.connected, false);
    assert.equal(source.lastScannedAt, null);
  }
});
