import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMarketDataConnected } from './marketData.js';

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
