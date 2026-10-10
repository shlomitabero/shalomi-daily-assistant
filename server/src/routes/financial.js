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

const VALID_SIDES = ['long', 'short'];

// Simulation only — never touches the real ledger. Real trading requires a
// broker connection that does not exist in this build.
financialRouter.post('/financial/paper-trade', requireOwner, (req, res) => {
  const { symbol, side, entryPrice, exitPrice, quantity } = req.body ?? {};
  if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'symbol is required' });
  // simulateTradeResult silently treats anything other than 'long' as a
  // short, so a typo like "Long" or "buy" would otherwise produce a
  // confidently wrong simulated result instead of an error.
  if (!VALID_SIDES.includes(side)) return res.status(400).json({ error: `side must be one of ${VALID_SIDES.join(', ')}` });

  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const qty = Number(quantity);
  if (!Number.isFinite(entry) || entry <= 0) return res.status(400).json({ error: 'entryPrice must be a positive number' });
  if (!Number.isFinite(exit) || exit <= 0) return res.status(400).json({ error: 'exitPrice must be a positive number' });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });

  const result = simulateTradeResult({ side, entryPrice: entry, exitPrice: exit, quantity: qty });
  const trade = db.paper_trades.insert({
    id: makeId('pt'), symbol, side, entryPrice: entry, exitPrice: exit, quantity: qty, ...result,
    createdAt: new Date().toISOString(),
  });
  logAction({ type: 'paper_trade', detail: { symbol, side, netPnl: result.netPnl }, result: 'success' });
  res.status(201).json({ trade });
});

financialRouter.get('/financial/paper-trades', requireOwner, (req, res) => {
  res.json({ trades: db.paper_trades.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});
