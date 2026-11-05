import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { actionTypeLabel, resultLabel, reasonLabel, formatMoney } from '../labels.js';

export default function ActivityLog() {
  const [actions, setActions] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getActions().then((r) => setActions(r.actions)).catch((err) => setError(err.data?.error || err.message));
    // Best-effort only: most log entries carry detail.opportunityId, but
    // without this there was no way to tell from the log alone WHICH
    // product a "פרסום מוצר - הצלחה" or "דחיית הזדמנות - הצלחה" row was
    // even about - every entry of the same type read identically. A
    // failure here just means titles don't resolve; it must never block
    // the log itself from rendering.
    api.getOpportunities().then((r) => setOpportunities(r.opportunities)).catch(() => {});
  }, []);

  return (
    <div className="page">
      <h1>יומן פעולות</h1>
      {error && <p className="form-error">{error}</p>}
      {actions.map((a) => {
        const opportunity = a.detail?.opportunityId ? opportunities.find((o) => o.id === a.detail.opportunityId) : null;
        return (
          <div key={a.id} className="card log-row">
            <div className="log-row-top">
              <span className="log-type">{actionTypeLabel(a.type)}</span>
              <span className={`log-result ${a.result === 'success' ? 'positive' : a.result?.startsWith('blocked') ? 'muted' : 'negative'}`}>{resultLabel(a.result)}</span>
            </div>
            {opportunity && (
              <Link className="link" to={`/opportunities/${opportunity.id}`}>{opportunity.title}</Link>
            )}
            {/* billing.js's webhook logs the verified sale amount on every
                successful sale_confirmed entry - without showing it here,
                the owner had to leave the audit log and cross-reference the
                ledger just to see how much a given sale was actually for. */}
            {a.type === 'sale_confirmed' && a.result === 'success' && Number.isFinite(a.detail?.amount) && (
              <p className="hint log-amount">נמכר בעד {formatMoney(a.detail.amount)}</p>
            )}
            {/* Without the message/path here, a "תקלה במסך - נכשל" row told
                the owner nothing about what actually broke or where - just
                that something, somewhere, once did. That defeats most of
                the point of surfacing it here at all. */}
            {a.type === 'client_error' && a.detail?.message && (
              <p className="hint log-reason">{a.detail.message}{a.detail.path ? ` (${a.detail.path})` : ''}</p>
            )}
            {a.detail?.reason && <p className="hint log-reason">{reasonLabel(a.detail.reason)}</p>}
            <span className="log-time">{new Date(a.createdAt).toLocaleString('he-IL')}</span>
          </div>
        );
      })}
      {actions.length === 0 && !error && <p className="hint">אין פעולות עדיין.</p>}
    </div>
  );
}
