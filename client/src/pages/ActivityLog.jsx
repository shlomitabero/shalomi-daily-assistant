import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { actionTypeLabel, resultLabel } from '../labels.js';

export default function ActivityLog() {
  const [actions, setActions] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getActions().then((r) => setActions(r.actions)).catch((err) => setError(err.data?.error || err.message));
  }, []);

  return (
    <div className="page">
      <h1>יומן פעולות</h1>
      {error && <p className="form-error">{error}</p>}
      {actions.map((a) => (
        <div key={a.id} className="card log-row">
          <div className="log-row-top">
            <span className="log-type">{actionTypeLabel(a.type)}</span>
            <span className={`log-result ${a.result === 'success' ? 'positive' : a.result?.startsWith('blocked') ? 'muted' : 'negative'}`}>{resultLabel(a.result)}</span>
          </div>
          <span className="log-time">{new Date(a.createdAt).toLocaleString('he-IL')}</span>
        </div>
      ))}
      {actions.length === 0 && !error && <p className="hint">אין פעולות עדיין.</p>}
    </div>
  );
}
