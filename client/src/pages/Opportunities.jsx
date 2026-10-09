import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const STATUS_LABEL = { draft: 'טיוטה', published: 'פורסם', rejected: 'נדחה' };

export default function Opportunities() {
  const [opportunities, setOpportunities] = useState([]);
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [busy, setBusy] = useState(false);
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

  return (
    <div className="page">
      <h1>הזדמנויות</h1>

      <form className="card form" onSubmit={onCreate}>
        <h3>מוצר דיגיטלי חדש (AI)</h3>
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
