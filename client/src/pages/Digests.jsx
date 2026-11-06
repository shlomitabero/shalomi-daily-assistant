import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Digests() {
  const [digests, setDigests] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function refresh() {
    api.getDigests().then((r) => setDigests(r.digests)).catch((err) => setError(err.data?.error || err.message));
  }
  useEffect(refresh, []);

  async function onGenerate() {
    setError('');
    setBusy(true);
    try {
      await api.generateDigest();
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>סיכום יומי</h1>
      <button className="btn btn-ghost" onClick={onGenerate} disabled={busy}>{busy ? 'מייצר…' : 'ייצר סיכום עכשיו'}</button>
      {error && <p className="form-error">{error}</p>}
      {/* Every other list page in the app (opportunities, approvals,
          activity log) explains plainly when there's nothing yet - this
          page was the one exception, showing a blank page under the button
          with no indication that's normal and not a loading or error
          state, especially likely on a first visit before the 7am cron
          tick or a manual click has ever run. */}
      {digests.length === 0 && !error && <p className="hint">אין סיכומים עדיין — סיכום נוצר אוטומטית כל יום ב-7:00 (שעון ישראל), או אפשר ללחוץ "ייצר סיכום עכשיו".</p>}
      {digests.map((d) => (
        <div key={d.id} className="card">
          <p className="hint">{new Date(d.generatedAt).toLocaleString('he-IL')}</p>
          <pre className="digest-text">{d.text}</pre>
        </div>
      ))}
    </div>
  );
}
