import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { sideLabel, formatMoney, refreshAllFailuresSummary } from '../labels.js';

export default function Financial() {
  const [watchlist, setWatchlist] = useState([]);
  const [connected, setConnected] = useState(false);
  const [trades, setTrades] = useState([]);
  const [symbol, setSymbol] = useState('');
  const [trade, setTrade] = useState({ symbol: '', side: 'long', entryPrice: '', exitPrice: '', quantity: '' });
  const [error, setError] = useState('');
  const [refreshingId, setRefreshingId] = useState(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [addBusy, setAddBusy] = useState(false);
  const [tradeBusy, setTradeBusy] = useState(false);

  function refresh() {
    api.getFinancialWatchlist().then((r) => { setWatchlist(r.watchlist); setConnected(r.connected); }).catch((err) => setError(err.data?.error || err.message));
    api.getPaperTrades().then((r) => setTrades(r.trades)).catch((err) => setError(err.data?.error || err.message));
  }
  useEffect(refresh, []);

  async function onAddSymbol(e) {
    e.preventDefault();
    // Same silent-no-op gap already fixed this hour for onPaperTrade just
    // below and for the Opportunities page's manual-draft form: the symbol
    // input has no `required` attribute, and this used to just return with
    // no error on an empty value - clicking "הוסף" with a blank symbol did
    // nothing at all. Same Hebrew wording routes/financial.js's own
    // addToWatchlist already uses server-side for this exact case.
    if (!symbol.trim()) {
      setError('סימבול הוא שדה חובה וחייב להיות מחרוזת לא ריקה');
      return;
    }
    setError('');
    setAddBusy(true);
    try {
      await api.addToWatchlist(symbol.trim().toUpperCase());
      setSymbol('');
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setAddBusy(false);
    }
  }

  async function onRefreshSymbol(id) {
    setError('');
    setRefreshingId(id);
    try {
      await api.refreshWatchlistEntry(id);
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setRefreshingId(null);
    }
  }

  // Without this, catching up N stale prices after first setting
  // MARKET_DATA_API_KEY (or just after being away a while) meant clicking
  // "רענן מחיר" once per symbol — tedious and easy to miss one. Refreshes
  // run one at a time (not Promise.all) so a single slow/failing symbol
  // doesn't race its error against the others' successful updates.
  async function onRefreshAll() {
    setError('');
    setRefreshingAll(true);
    // Each symbol's own failure used to call setError() directly inside
    // the loop - a second or third failing symbol silently overwrote the
    // first's message, so only the LAST one of possibly several real
    // failures in the same run ever reached the owner, as if the others
    // had succeeded. refreshAllFailuresSummary (labels.js) builds one
    // combined message instead.
    const failedSymbols = [];
    try {
      for (const w of watchlist) {
        try {
          await api.refreshWatchlistEntry(w.id);
        } catch (err) {
          failedSymbols.push({ symbol: w.symbol, message: err.data?.error || err.message });
        }
      }
      refresh();
    } finally {
      setRefreshingAll(false);
    }
    const summary = refreshAllFailuresSummary(failedSymbols);
    if (summary) setError(summary);
  }

  async function onRemoveSymbol(id) {
    // Without a busy state here (every other action on this page has one),
    // a double-click fires two concurrent DELETE requests - the first
    // removes it, and the second then 404s and flashes a confusing "not
    // found" error even though the removal actually succeeded.
    setError('');
    setRemovingId(id);
    try {
      await api.removeFromWatchlist(id);
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setRemovingId(null);
    }
  }

  async function onPaperTrade(e) {
    e.preventDefault();
    // Same gap as the Opportunities page's manual-draft form (fixed
    // earlier this hour): clicking "הרץ סימולציה" with an empty symbol
    // did nothing at all, no error, no native browser validation either
    // (the input has no `required`) - indistinguishable from the button
    // being broken. Same Hebrew wording routes/financial.js's own
    // createPaperTrade already uses for this exact case server-side.
    if (!trade.symbol.trim()) {
      setError('סימבול הוא שדה חובה');
      return;
    }
    setError('');
    setTradeBusy(true);
    try {
      await api.paperTrade({
        symbol: trade.symbol.trim().toUpperCase(), side: trade.side,
        entryPrice: Number(trade.entryPrice), exitPrice: Number(trade.exitPrice), quantity: Number(trade.quantity),
      });
      setTrade({ symbol: '', side: 'long', entryPrice: '', exitPrice: '', quantity: '' });
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setTradeBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>שווקים פיננסיים</h1>
      <p className="hint">{connected ? 'מקור נתוני שוק מחובר.' : 'לא מחובר מקור נתוני שוק אמיתי — הוסף MARKET_DATA_API_KEY.'} מסחר כאן הוא סימולציה בלבד — אין חיבור לברוקר אמיתי.</p>

      <div className="card form">
        <div className="section-header">
          <h3 style={{ margin: 0 }}>מעקב סימבול</h3>
          {watchlist.length > 1 && (
            <button
              className="btn btn-ghost"
              onClick={onRefreshAll}
              disabled={refreshingAll || refreshingId !== null || !connected}
              title={!connected ? 'מקור נתוני שוק לא מחובר' : undefined}
            >
              {refreshingAll ? 'מרענן הכל…' : 'רענן הכל'}
            </button>
          )}
        </div>
        <form onSubmit={onAddSymbol} className="field-row">
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="AAPL" disabled={addBusy} />
          <button className="btn btn-ghost" type="submit" disabled={addBusy}>{addBusy ? 'מוסיף…' : 'הוסף'}</button>
        </form>
        {error && <p className="form-error">{error}</p>}
        {watchlist.map((w) => (
          <div key={w.id}>
            <div className="source-row">
              <span className={`dot ${w.connected ? 'dot-on' : 'dot-off'}`} />
              <span>{w.symbol}</span>
              <span>{w.lastPrice != null ? `$${w.lastPrice}` : 'לא מחובר'}</span>
              <button
                className="btn btn-ghost"
                onClick={() => onRefreshSymbol(w.id)}
                disabled={refreshingId === w.id || refreshingAll || !connected}
                title={!connected ? 'מקור נתוני שוק לא מחובר' : undefined}
              >
                {refreshingId === w.id ? 'מרענן…' : 'רענן מחיר'}
              </button>
              <button className="btn btn-ghost" onClick={() => onRemoveSymbol(w.id)} disabled={removingId === w.id}>
                {removingId === w.id ? 'מסיר…' : 'הסר'}
              </button>
            </div>
            {/* Without this, a price fetched once weeks ago (the owner never
                clicked "רענן מחיר" again) looked identical to one fetched
                moments ago - nothing distinguished a stale number from a
                fresh one, which is exactly the kind of silent staleness
                this app's "never show a number without being honest about
                it" principle exists to avoid. lastUpdatedAt and lastPrice
                are always set together (both come from the same fetchQuote
                call), so this is never shown without a price next to it.*/}
            {w.lastUpdatedAt && (
              <p className="hint" style={{ margin: '-4px 0 6px' }}>עודכן לאחרונה: {new Date(w.lastUpdatedAt).toLocaleString('he-IL')}</p>
            )}
          </div>
        ))}
      </div>

      <form className="card form" onSubmit={onPaperTrade}>
        <h3>עסקה מדומה (סימולציה)</h3>
        <div className="field-row">
          <input placeholder="סימבול" value={trade.symbol} onChange={(e) => setTrade({ ...trade, symbol: e.target.value })} />
          <select value={trade.side} onChange={(e) => setTrade({ ...trade, side: e.target.value })}>
            <option value="long">לונג</option>
            <option value="short">שורט</option>
          </select>
        </div>
        {/* step="any" on all three - without it, a type="number" input
            defaults to step=1, so a decimal price (e.g. 149.99) fails
            native validation and the browser silently blocks the form's
            submit event before React even sees it, with no error shown
            anywhere. */}
        <div className="field-row">
          <input type="number" step="any" placeholder="מחיר כניסה" value={trade.entryPrice} onChange={(e) => setTrade({ ...trade, entryPrice: e.target.value })} />
          <input type="number" step="any" placeholder="מחיר יציאה" value={trade.exitPrice} onChange={(e) => setTrade({ ...trade, exitPrice: e.target.value })} />
          <input type="number" step="any" placeholder="כמות" value={trade.quantity} onChange={(e) => setTrade({ ...trade, quantity: e.target.value })} />
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-ghost" type="submit" disabled={tradeBusy}>{tradeBusy ? 'מריץ…' : 'הרץ סימולציה'}</button>
      </form>

      <section className="section">
        <h2>עסקאות מדומות אחרונות</h2>
        {/* Same gap as the Digests page (fixed earlier this hour): a bare
            heading with nothing under it on first use, no indication
            that's normal rather than a loading state or a bug. */}
        {trades.length === 0 && <p className="hint">אין עסקאות מדומות עדיין — אפשר להריץ סימולציה בטופס למעלה.</p>}
        {trades.map((t) => (
          <div key={t.id} className="opp-row">
            <span>{t.symbol} ({sideLabel(t.side)})</span>
            <span className={t.netPnl >= 0 ? 'positive' : 'negative'}>{formatMoney(t.netPnl)} <span className="demo-badge">סימולציה</span></span>
          </div>
        ))}
      </section>
    </div>
  );
}
