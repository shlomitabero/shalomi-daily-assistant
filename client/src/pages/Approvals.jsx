import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { actionTypeLabel } from '../labels.js';

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

  // Unlike listDigests (capped server-side, server/src/routes/digest.js),
  // this list is never capped server-side: Dashboard.jsx's pendingApprovals
  // and OpportunityDetail.jsx's hasPublishApproval both scan the FULL
  // getApprovals() response to find a specific opportunity's current
  // approval status, however old it is. Capping the API response itself
  // would risk the exact bug fixed for resolved opportunities, just
  // worse here: an old still-unpublished approval silently stops counting
  // as approved. So only what's rendered on this page is capped, newest
  // first by createdAt, same precedent as Opportunities.jsx's resolved list.
  const MAX_APPROVALS_SHOWN = 50;
  const sortedApprovals = [...approvals].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const shownApprovals = sortedApprovals.slice(0, MAX_APPROVALS_SHOWN);

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
      {sortedApprovals.length > MAX_APPROVALS_SHOWN && (
        <p className="hint">מוצגים {MAX_APPROVALS_SHOWN} האחרונים מתוך {sortedApprovals.length}.</p>
      )}
      {shownApprovals.map((a) => {
        const opp = opportunities.find((o) => o.id === a.opportunityId);
        const stillActionable = a.status === 'approved' && opp?.status === 'draft';
        return (
          <div key={a.id} className="card">
            <div className="opp-card-top">
              <span className="opp-title">{opp?.title ?? a.opportunityId}</span>
              <span className="badge">{STATUS_LABEL[a.status] ?? a.status}</span>
            </div>
            <p className="hint">פעולה: {actionTypeLabel(a.actionType)}{opp?.status === 'published' && ' — כבר בוצעה'}</p>
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
