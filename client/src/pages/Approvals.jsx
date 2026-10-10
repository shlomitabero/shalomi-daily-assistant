import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const STATUS_LABEL = { approved: 'מאושר', rejected: 'נדחה' };

export default function Approvals() {
  const [approvals, setApprovals] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  function refresh() {
    Promise.all([api.getApprovals(), api.getOpportunities()])
      .then(([a, o]) => {
        setApprovals(a.approvals);
        setOpportunities(o.opportunities);
      })
      .catch((err) => setError(err.data?.error || err.message));
  }

  useEffect(refresh, []);

  async function onReject(id) {
    setError('');
    setBusyId(id);
    try {
      await api.reject(id);
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <h1>אישורים</h1>
      {error && <p className="form-error">{error}</p>}
      {approvals.length === 0 && <p className="hint">אין אישורים עדיין. אישור נוצר מתוך כרטיס הזדמנות כשהמצב הוא "אישור לביצוע".</p>}
      {approvals.map((a) => {
        const opp = opportunities.find((o) => o.id === a.opportunityId);
        const stillActionable = a.status === 'approved' && opp?.status === 'draft';
        return (
          <div key={a.id} className="card">
            <div className="opp-card-top">
              <span className="opp-title">{opp?.title ?? a.opportunityId}</span>
              <span className="badge">{STATUS_LABEL[a.status] ?? a.status}</span>
            </div>
            <p className="hint">פעולה: {a.actionType}{opp?.status === 'published' && ' — כבר בוצעה'}</p>
            <div className="field-row">
              <Link className="link" to={`/opportunities/${a.opportunityId}`}>לכרטיס ההזדמנות ←</Link>
              {stillActionable && (
                <button className="btn btn-ghost" onClick={() => onReject(a.id)} disabled={busyId === a.id}>
                  {busyId === a.id ? 'מבטל…' : 'בטל אישור'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
