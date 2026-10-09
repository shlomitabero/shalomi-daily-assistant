import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function ActivityLog() {
  const [actions, setActions] = useState([]);

  useEffect(() => {
    api.getActions().then((r) => setActions(r.actions));
  }, []);

  return (
    <div className="page">
      <h1>יומן פעולות</h1>
      {actions.map((a) => (
        <div key={a.id} className="card log-row">
          <div className="log-row-top">
            <span className="log-type">{a.type}</span>
            <span className={`log-result ${a.result === 'success' ? 'positive' : a.result?.startsWith('blocked') ? 'muted' : 'negative'}`}>{a.result}</span>
          </div>
          <span className="log-time">{new Date(a.createdAt).toLocaleString('he-IL')}</span>
        </div>
      ))}
      {actions.length === 0 && <p className="hint">אין פעולות עדיין.</p>}
    </div>
  );
}
