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
      {digests.map((d) => (
        <div key={d.id} className="card">
          <p className="hint">{new Date(d.generatedAt).toLocaleString('he-IL')}</p>
          <pre className="digest-text">{d.text}</pre>
        </div>
      ))}
    </div>
  );
}
