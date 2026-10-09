import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { db, makeId } from '../db/store.js';
import { isMarketDataConnected, fetchQuote } from '../services/marketData.js';
import { simulateTradeResult } from '../engine/paperTrading.js';
import { logAction } from '../services/execution.js';

export const financialRouter = Router();

financialRouter.get('/financial/watchlist', requireOwner, (req, res) => {
  res.json({ watchlist: db.financial_watchlist.all(), connected: isMarketDataConnected() });
});

financialRouter.post('/financial/watchlist', requireOwner, async (req, res) => {
  const { symbol } = req.body ?? {};
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  let quote = null;
  if (isMarketDataConnected()) {
    try {
      quote = await fetchQuote(symbol);
    } catch (err) {
      return res.status(502).json({ error: `could not fetch a quote: ${err.message}` });
    }
  }

  const entry = db.financial_watchlist.insert({
    id: makeId('wl'),
    symbol,
    dataSource: isMarketDataConnected() ? 'twelvedata' : null,
    lastPrice: quote?.price ?? null,
    lastUpdatedAt: quote?.fetchedAt ?? null,
    connected: isMarketDataConnected(),
    createdAt: new Date().toISOString(),
  });
  res.status(201).json({ entry });
});

// Simulation only — never touches the real ledger. Real trading requires a
// broker connection that does not exist in this build.
financialRouter.post('/financial/paper-trade', requireOwner, (req, res) => {
  const { symbol, side, entryPrice, exitPrice, quantity } = req.body ?? {};
  if (!symbol || !side || !entryPrice || !exitPrice || !quantity) {
    return res.status(400).json({ error: 'symbol, side, entryPrice, exitPrice, and quantity are required' });
  }
  const result = simulateTradeResult({ side, entryPrice, exitPrice, quantity });
  const trade = db.paper_trades.insert({
    id: makeId('pt'), symbol, side, entryPrice, exitPrice, quantity, ...result,
    createdAt: new Date().toISOString(),
  });
  logAction({ type: 'paper_trade', detail: { symbol, side, netPnl: result.netPnl }, result: 'success' });
  res.status(201).json({ trade });
});

financialRouter.get('/financial/paper-trades', requireOwner, (req, res) => {
  res.json({ trades: db.paper_trades.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});
