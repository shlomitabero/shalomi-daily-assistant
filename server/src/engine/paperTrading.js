// Simulates a trade's result including fees and slippage. This never moves
// real money — real execution only happens once a real broker connection
// exists — so every result is explicitly marked `simulated: true` and must
// never be added to the real ledger as realized profit.
export function simulateTradeResult({ side, entryPrice, exitPrice, quantity, feeRatePerSide = 0.001, slippageRate = 0.0005 }) {
  if (side !== 'long' && side !== 'short') {
    // Without this, an unrecognized side (a typo like "Long", or "buy")
    // would silently fall through to the short-side math below and return a
    // confidently wrong result instead of an error.
    throw new Error(`side must be "long" or "short", got: ${JSON.stringify(side)}`);
  }
  const entryAdj = side === 'long' ? 1 + slippageRate : 1 - slippageRate;
  const exitAdj = side === 'long' ? 1 - slippageRate : 1 + slippageRate;
  const effectiveEntry = entryPrice * entryAdj;
  const effectiveExit = exitPrice * exitAdj;

  const grossPnl = side === 'long'
    ? (effectiveExit - effectiveEntry) * quantity
    : (effectiveEntry - effectiveExit) * quantity;

  const fees = (effectiveEntry * quantity + effectiveExit * quantity) * feeRatePerSide;

  return {
    simulated: true,
    grossPnl: round2(grossPnl),
    fees: round2(fees),
    netPnl: round2(grossPnl - fees),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
