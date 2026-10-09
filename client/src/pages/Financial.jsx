import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Financial() {
  const [watchlist, setWatchlist] = useState([]);
  const [connected, setConnected] = useState(false);
  const [trades, setTrades] = useState([]);
  const [symbol, setSymbol] = useState('');
  const [trade, setTrade] = useState({ symbol: '', side: 'long', entryPrice: '', exitPrice: '', quantity: '' });
  const [error, setError] = useState('');

  function refresh() {
    api.getFinancialWatchlist().then((r) => { setWatchlist(r.watchlist); setConnected(r.connected); });
    api.getPaperTrades().then((r) => setTrades(r.trades));
  }
  useEffect(refresh, []);

  async function onAddSymbol(e) {
    e.preventDefault();
    if (!symbol.trim()) return;
    setError('');
    try {
      await api.addToWatchlist(symbol.trim().toUpperCase());
      setSymbol('');
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    }
  }

  async function onPaperTrade(e) {
    e.preventDefault();
    setError('');
    try {
      await api.paperTrade({
        symbol: trade.symbol.toUpperCase(), side: trade.side,
        entryPrice: Number(trade.entryPrice), exitPrice: Number(trade.exitPrice), quantity: Number(trade.quantity),
      });
      setTrade({ symbol: '', side: 'long', entryPrice: '', exitPrice: '', quantity: '' });
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    }
  }

  return (
    <div className="page">
      <h1>שווקים פיננסיים</h1>
      <p className="hint">{connected ? 'מקור נתוני שוק מחובר.' : 'לא מחובר מקור נתוני שוק אמיתי — הוסף MARKET_DATA_API_KEY.'} מסחר כאן הוא סימולציה בלבד — אין חיבור לברוקר אמיתי.</p>

      <div className="card form">
        <h3>מעקב סימבול</h3>
        <form onSubmit={onAddSymbol} className="field-row">
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="AAPL" />
          <button className="btn btn-ghost" type="submit">הוסף</button>
        </form>
        {watchlist.map((w) => (
          <div key={w.id} className="source-row">
            <span className={`dot ${w.connected ? 'dot-on' : 'dot-off'}`} />
            <span>{w.symbol}</span>
            <span>{w.lastPrice != null ? `$${w.lastPrice}` : 'לא מחובר'}</span>
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
        <div className="field-row">
          <input type="number" placeholder="מחיר כניסה" value={trade.entryPrice} onChange={(e) => setTrade({ ...trade, entryPrice: e.target.value })} />
          <input type="number" placeholder="מחיר יציאה" value={trade.exitPrice} onChange={(e) => setTrade({ ...trade, exitPrice: e.target.value })} />
          <input type="number" placeholder="כמות" value={trade.quantity} onChange={(e) => setTrade({ ...trade, quantity: e.target.value })} />
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-ghost" type="submit">הרץ סימולציה</button>
      </form>

      <section className="section">
        <h2>עסקאות מדומות אחרונות</h2>
        {trades.map((t) => (
          <div key={t.id} className="opp-row">
            <span>{t.symbol} ({t.side})</span>
            <span className={t.netPnl >= 0 ? 'positive' : 'negative'}>${t.netPnl.toFixed(2)} <span className="demo-badge">סימולציה</span></span>
          </div>
        ))}
      </section>
    </div>
  );
}
