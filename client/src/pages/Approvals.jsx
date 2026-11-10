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
  const [opportunitiesError, setOpportunitiesError] = useState('');

  function refresh() {
    // getOpportunities() here is only an enrichment of getApprovals()'s own
    // data - every lookup below already falls back to the raw
    // a.opportunityId via `opp?.title ?? a.opportunityId` when an
    // opportunity isn't found. Promise.all meant a transient failure in
    // that one enrichment call blanked this entire page down to an error
    // line, even when the actual approvals list (the one thing this page
    // exists to show) had loaded fine. Same fix as Dashboard.jsx's
    // equivalent Promise.all -> Promise.allSettled change.
    Promise.allSettled([api.getApprovals(), api.getOpportunities()]).then(([aRes, oRes]) => {
      if (aRes.status === 'rejected') {
        setError(aRes.reason?.data?.error || aRes.reason?.message);
        return;
      }
      setError('');
      setApprovals(aRes.value.approvals);
      if (oRes.status === 'fulfilled') {
        setOpportunities(oRes.value.opportunities);
        setOpportunitiesError('');
      } else {
        // Degrade honestly, not silently: every card below will fall back
        // to showing a.opportunityId instead of a real title, and "בטל
        // אישור" will stay hidden wherever that lookup needed opp.status -
        // without this notice the owner would see unexplained raw ids
        // with no indication anything failed to load.
        setOpportunitiesError(oRes.reason?.data?.error || oRes.reason?.message);
      }
    });
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
      {opportunitiesError && (
        <p className="form-error">לא ניתן לטעון את פרטי ההזדמנויות כרגע ({opportunitiesError}) — הכרטיסים למטה יוצגו עם מזהה בלבד, בלי כותרת.</p>
      )}
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
