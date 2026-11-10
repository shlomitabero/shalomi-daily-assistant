import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { db, makeId } from '../db/store.js';
import { isMarketDataConnected, fetchQuote } from '../services/marketData.js';
import { simulateTradeResult } from '../engine/paperTrading.js';
import { logAction } from '../services/execution.js';

export const financialRouter = Router();

export function listWatchlist(req, res) {
  res.json({ watchlist: db.financial_watchlist.all(), connected: isMarketDataConnected() });
}

// Guards the gap between the alreadyTracked check below and the insert
// landing afterward, below the await fetchQuote() call - two concurrent
// requests for the same symbol (a double-click of "add", or two open
// tabs) could otherwise both read "not yet tracked" before either had
// inserted, creating exactly the duplicate row alreadyTracked itself
// exists to prevent, just via a path that check alone doesn't close.
const symbolsBeingAdded = new Set();

export async function addToWatchlist(req, res) {
  const { symbol } = req.body ?? {};
  // A non-string symbol (an object, a number) would otherwise be stored
  // as-is and crash the Financial page's render — React throws trying to
  // render a plain object as a child. The client's top-level ErrorBoundary
  // would catch that, but it resets the whole app back to the dashboard,
  // not just that one row — this stops it at the door instead.
  if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
    return res.status(400).json({ error: 'סימבול הוא שדה חובה וחייב להיות מחרוזת לא ריקה' });
  }
  const normalizedSymbol = symbol.trim().toUpperCase();

  if (symbolsBeingAdded.has(normalizedSymbol)) {
    return res.status(409).json({ error: `${normalizedSymbol} כבר בתהליך הוספה — נסה שוב בעוד רגע` });
  }
  symbolsBeingAdded.add(normalizedSymbol);
  try {
    // The client already uppercases before sending, but the server must not
    // rely on that — without this check, "AAPL" and "aapl" (or a second
    // click of "add") would silently create two separate watchlist rows for
    // the same real symbol, each refreshed independently by "refresh all".
    const alreadyTracked = db.financial_watchlist.where((w) => w.symbol === normalizedSymbol).length > 0;
    if (alreadyTracked) {
      return res.status(409).json({ error: `${normalizedSymbol} כבר נמצא ברשימת המעקב` });
    }

    let quote = null;
    if (isMarketDataConnected()) {
      try {
        quote = await fetchQuote(normalizedSymbol);
      } catch (err) {
        return res.status(502).json({ error: `לא ניתן היה לקבל מחיר: ${err.message}` });
      }
    }

    const entry = db.financial_watchlist.insert({
      id: makeId('wl'),
      symbol: normalizedSymbol,
      dataSource: isMarketDataConnected() ? 'twelvedata' : null,
      lastPrice: quote?.price ?? null,
      lastUpdatedAt: quote?.fetchedAt ?? null,
      connected: isMarketDataConnected(),
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ entry });
  } finally {
    symbolsBeingAdded.delete(normalizedSymbol);
  }
}

// Without this, a watchlist entry's price/connected status was frozen
// forever at whatever it was when added — a symbol added before
// MARKET_DATA_API_KEY was configured would show "not connected" even
// years after it was, and even a fully-connected entry's price never
// updated past the moment it was first added. There was no way back to
// current data short of deleting and re-adding the symbol (and there's
// no delete route either).
export async function refreshWatchlistEntry(req, res) {
  const entry = db.financial_watchlist.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'לא נמצא' });
  if (!isMarketDataConnected()) return res.status(503).json({ error: 'מקור נתוני שוק לא מחובר' });

  let quote;
  try {
    quote = await fetchQuote(entry.symbol);
  } catch (err) {
    return res.status(502).json({ error: `לא ניתן היה לקבל מחיר: ${err.message}` });
  }

  const updated = db.financial_watchlist.update(entry.id, {
    dataSource: 'twelvedata',
    lastPrice: quote.price,
    lastUpdatedAt: quote.fetchedAt,
    connected: true,
  });
  res.json({ entry: updated });
}

export function deleteWatchlistEntry(req, res) {
  const existed = db.financial_watchlist.delete(req.params.id);
  if (!existed) return res.status(404).json({ error: 'לא נמצא' });
  res.status(204).end();
}

const VALID_SIDES = ['long', 'short'];

// Simulation only — never touches the real ledger. Real trading requires a
// broker connection that does not exist in this build.
export function createPaperTrade(req, res) {
  const { symbol, side, entryPrice, exitPrice, quantity } = req.body ?? {};
  // addToWatchlist already rejects a whitespace-only symbol the same way
  // (!symbol.trim()) - this check was missing it, so a symbol of "   " (the
  // client sends trade.symbol.toUpperCase() with no trim either) would pass
  // straight through and get stored as a paper trade with a blank-looking
  // symbol in the list below.
  if (!symbol || typeof symbol !== 'string' || !symbol.trim()) return res.status(400).json({ error: 'סימבול הוא שדה חובה' });
  const normalizedSymbol = symbol.trim().toUpperCase();
  // simulateTradeResult (engine/paperTrading.js) already throws on an
  // unrecognized side - this check exists so a typo like "Long" or "buy"
  // gets a clean Hebrew 400 at this layer instead of that engine-level
  // throw's own raw English message ('side must be "long" or "short", got: ...')
  // leaking straight to the owner.
  if (!VALID_SIDES.includes(side)) return res.status(400).json({ error: `הצד חייב להיות אחד מ: ${VALID_SIDES.join(', ')}` });

  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const qty = Number(quantity);
  if (!Number.isFinite(entry) || entry <= 0) return res.status(400).json({ error: 'מחיר כניסה חייב להיות מספר חיובי' });
  if (!Number.isFinite(exit) || exit <= 0) return res.status(400).json({ error: 'מחיר יציאה חייב להיות מספר חיובי' });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'כמות חייבת להיות מספר חיובי' });

  const result = simulateTradeResult({ side, entryPrice: entry, exitPrice: exit, quantity: qty });
  const trade = db.paper_trades.insert({
    id: makeId('pt'), symbol: normalizedSymbol, side, entryPrice: entry, exitPrice: exit, quantity: qty, ...result,
    createdAt: new Date().toISOString(),
  });
  logAction({ type: 'paper_trade', detail: { symbol: normalizedSymbol, side, netPnl: result.netPnl }, result: 'success' });
  res.status(201).json({ trade });
}

// Simulation-only and never read by anything else (no cross-file lookup by
// id, unlike approvals/opportunities) - a straight server-side cap, same
// precedent as listDigests, is safe here with no correctness risk.
const MAX_PAPER_TRADES_RETURNED = 100;

export function listPaperTrades(req, res) {
  const trades = db.paper_trades.all()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, MAX_PAPER_TRADES_RETURNED);
  res.json({ trades });
}

financialRouter.get('/financial/watchlist', requireOwner, listWatchlist);
financialRouter.post('/financial/watchlist', requireOwner, asyncHandler(addToWatchlist));
financialRouter.post('/financial/watchlist/:id/refresh', requireOwner, asyncHandler(refreshWatchlistEntry));
financialRouter.delete('/financial/watchlist/:id', requireOwner, deleteWatchlistEntry);
financialRouter.post('/financial/paper-trade', requireOwner, createPaperTrade);
financialRouter.get('/financial/paper-trades', requireOwner, listPaperTrades);
