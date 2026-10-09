import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const STATUS_LABEL = { draft: 'טיוטה', published: 'פורסם', rejected: 'נדחה' };

export default function Opportunities() {
  const [opportunities, setOpportunities] = useState([]);
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [error, setError] = useState('');

  function refresh() {
    api.getOpportunities().then((r) => setOpportunities(r.opportunities)).catch((err) => setError(err.data?.error || err.message));
  }

  useEffect(refresh, []);

  async function onCreate(e) {
    e.preventDefault();
    if (!topic.trim() || !audience.trim()) return;
    setError('');
    setBusy(true);
    try {
      await api.createDigitalProduct(topic.trim(), audience.trim());
      setTopic('');
      setAudience('');
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onScanNow() {
    setScanBusy(true);
    setScanResult(null);
    try {
      const result = await api.runAutonomousScan();
      setScanResult(result);
      refresh();
    } catch (err) {
      setScanResult({ ran: false, reason: err.data?.error || err.message });
    } finally {
      setScanBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>הזדמנויות</h1>

      <div className="card">
        <h3>סריקה אוטונומית</h3>
        <p className="hint">המערכת סורקת לבד כל כמה שעות ומחפשת רעיון למוצר חדש. אפשר גם להריץ עכשיו ידנית לבדיקה.</p>
        <button className="btn btn-ghost" onClick={onScanNow} disabled={scanBusy}>{scanBusy ? 'סורק…' : 'סרוק עכשיו'}</button>
        {scanResult && (
          <p className={scanResult.ran ? 'positive' : 'hint'}>
            {scanResult.ran ? `נוצרה הזדמנות: ${scanResult.opportunity?.title}` : `לא נוצר דבר: ${scanResult.reason}`}
          </p>
        )}
      </div>

      <form className="card form" onSubmit={onCreate}>
        <h3>מוצר דיגיטלי חדש (ידני)</h3>
        <label>
          נושא
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="לדוגמה: ניהול תזרים מזומנים לעצמאים" />
        </label>
        <label>
          קהל מטרה
          <input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="לדוגמה: עצמאים ופרילנסרים" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'מכין טיוטה…' : 'צור טיוטת מוצר'}</button>
      </form>

      <section className="section">
        {opportunities.length === 0 && <p className="hint">אין הזדמנויות עדיין.</p>}
        {opportunities.map((o) => (
          <Link key={o.id} to={`/opportunities/${o.id}`} className="opp-card">
            <div className="opp-card-top">
              <span className="opp-title">{o.title}</span>
              <span className="badge">{STATUS_LABEL[o.status] ?? o.status}</span>
            </div>
            <div className="opp-card-bottom">
              <span>{o.netProfitMid != null ? `רווח משוער: ₪${o.netProfitMid.toFixed(0)}` : 'חסר מידע לחישוב רווח'}</span>
              <span>סיכון: {o.riskLevel}</span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
