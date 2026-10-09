import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateTradeResult } from './paperTrading.js';

test('a winning long trade nets a positive but fee-reduced profit', () => {
  const result = simulateTradeResult({ side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, feeRatePerSide: 0, slippageRate: 0 });
  assert.equal(result.grossPnl, 100);
  assert.equal(result.netPnl, 100);
  assert.equal(result.simulated, true);
});

test('fees reduce net profit below gross profit', () => {
  const result = simulateTradeResult({ side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, feeRatePerSide: 0.01, slippageRate: 0 });
  assert.ok(result.fees > 0);
  assert.ok(result.netPnl < result.grossPnl);
});

test('slippage works against the trader on both entry and exit', () => {
  const noSlippage = simulateTradeResult({ side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, feeRatePerSide: 0, slippageRate: 0 });
  const withSlippage = simulateTradeResult({ side: 'long', entryPrice: 100, exitPrice: 110, quantity: 10, feeRatePerSide: 0, slippageRate: 0.01 });
  assert.ok(withSlippage.grossPnl < noSlippage.grossPnl);
});

test('a losing trade produces a negative net P&L', () => {
  const result = simulateTradeResult({ side: 'long', entryPrice: 100, exitPrice: 90, quantity: 10, feeRatePerSide: 0, slippageRate: 0 });
  assert.ok(result.netPnl < 0);
});

test('a winning short trade profits when price falls', () => {
  const result = simulateTradeResult({ side: 'short', entryPrice: 100, exitPrice: 90, quantity: 10, feeRatePerSide: 0, slippageRate: 0 });
  assert.equal(result.grossPnl, 100);
});

test('a short trade loses when price rises', () => {
  const result = simulateTradeResult({ side: 'short', entryPrice: 100, exitPrice: 110, quantity: 10, feeRatePerSide: 0, slippageRate: 0 });
  assert.ok(result.netPnl < 0);
});
