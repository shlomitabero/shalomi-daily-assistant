import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Sources() {
  const [sources, setSources] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.getSources().then((r) => setSources(r.sources)).catch((err) => setError(err.data?.error || err.message));
  }
  useEffect(refresh, []);

  async function onRescan() {
    setBusy(true);
    try {
      await api.rescanSources();
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const connected = sources.filter((s) => s.connected);
  const notConnected = sources.filter((s) => !s.connected);

  return (
    <div className="page">
      <h1>מקורות הכנסה</h1>
      <p className="hint">
        כל מקור כאן הוא ערוץ אמיתי שהמערכת יכולה לסרוק בו הזדמנויות — אבל רק אם הוא מחובר בפועל למפתח/חשבון אמיתי.
        מקור "לא מחובר" פשוט לא ייסרק, ולעולם לא יוצג כאילו יש בו תוצאות מומצאות.
      </p>

      {connected.length > 0 && (
        <section className="section">
          <h2>מחוברים ({connected.length})</h2>
          {connected.map((s) => (
            <div key={s.id} className="card">
              <div className="source-row" style={{ border: 'none', padding: 0, marginBottom: 6 }}>
                <span className="dot dot-on" />
                <span className="source-name" style={{ fontWeight: 700 }}>{s.name}</span>
              </div>
              <p className="hint">{s.description}</p>
            </div>
          ))}
        </section>
      )}

      <section className="section">
        <div className="section-header">
          <h2>לא מחוברים ({notConnected.length})</h2>
          <button className="btn btn-ghost" onClick={onRescan} disabled={busy}>{busy ? 'בודק…' : 'בדוק שוב'}</button>
        </div>
        {notConnected.map((s) => (
          <div key={s.id} className="card">
            <div className="source-row" style={{ border: 'none', padding: 0, marginBottom: 6 }}>
              <span className="dot dot-off" />
              <span className="source-name" style={{ fontWeight: 700 }}>{s.name}</span>
            </div>
            <p className="hint">{s.description}</p>
            <p className="hint" style={{ marginTop: 8 }}><strong style={{ color: 'var(--text)' }}>איך מחברים: </strong>{s.howToConnect}</p>
          </div>
        ))}
        {error && <p className="form-error">{error}</p>}
      </section>
    </div>
  );
}
