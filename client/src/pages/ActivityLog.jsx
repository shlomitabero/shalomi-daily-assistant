import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { actionTypeLabel, resultLabel, reasonLabel, formatMoney, sideLabel, autonomousScanSummary, saleConfirmedSummary } from '../labels.js';

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
              {/* resultLabel only translates the leading word ('blocked'/
                  'skipped'/...) - the free-text detail after it stays in
                  whatever language the logging code wrote it in, which for
                  autonomous_scan's own 'blocked: source not connected' /
                  'skipped: N drafts already awaiting review', and for
                  sale_confirmed's own 'skipped: sandbox transaction, not
                  recorded as real revenue' (the common case while testing
                  Paddle in sandbox mode) / 'blocked: <raw payload error>',
                  is English. autonomousScanSummary()/saleConfirmedSummary()
                  already have a full Hebrew sentence for every one of their
                  outcomes. */}
              {/* 'blocked' is muted (de-emphasized gray), not negative
                  (red), everywhere else in this log - research mode
                  blocking a publish, a budget cap, a demo draft, a
                  rate-limited login are all the safety system working
                  exactly as intended, not a failure. A blocked
                  sale_confirmed is the one real exception: it means a
                  real customer's real payment came in and did NOT get
                  recorded (a malformed amount, or a transaction missing
                  custom_data.opportunityId) - Dashboard.jsx already
                  shows this as a red 🚨 banner and the daily digest
                  flags it the same way, so this row muting itself gray,
                  as if nothing worth worrying about happened, directly
                  contradicted both of those. */}
              <span className={`log-result ${
                a.result === 'success' ? 'positive'
                  : a.type === 'sale_confirmed' && a.result?.startsWith('blocked') ? 'negative'
                    : a.result?.startsWith('blocked') ? 'muted'
                      : 'negative'
              }`}>
                {a.type === 'autonomous_scan' ? autonomousScanSummary(a) : a.type === 'sale_confirmed' ? saleConfirmedSummary(a) : resultLabel(a.result)}
              </span>
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
            {/* financial.js's createPaperTrade logs symbol/side/netPnl on every
                simulated trade, but until now the audit log just said "עסקה
                מדומה - הצלחה" with no way to tell which symbol, which side,
                or the simulated result apart - the owner had to go back to
                the Financial page's own trade list to see any of that. This
                is simulated only (paperTrading.js never touches the real
                ledger), hence "מדומה" rather than a real profit/loss figure. */}
            {a.type === 'paper_trade' && a.detail?.symbol && (
              <p className="hint log-reason">{a.detail.symbol} · {sideLabel(a.detail.side)} · רווח/הפסד מדומה: {formatMoney(a.detail.netPnl)}</p>
            )}
            {/* routes/auth.js logs the source ip on every failed/blocked
                login_attempt, but until now nothing here showed it - the
                owner could see THAT a login attempt failed, with no way to
                tell a single mistyped password apart from a sustained
                attack from one source, or to know what IP to even look for
                if they wanted to block it upstream. */}
            {a.type === 'login_attempt' && a.detail?.ip && (
              <p className="hint log-reason">מקור: {a.detail.ip}</p>
            )}
            {/* routes/financial.js logs symbol/error on every failed
                market_quote_fetch (addToWatchlist/refreshWatchlistEntry's
                own real call to the external market data provider) - without
                this, the row just said "שליפת מחיר שוק - נכשל" with no way
                to tell which symbol failed or why, even though that's
                exactly the information the owner needs to decide whether to
                retry, fix a typo'd symbol, or suspect the provider itself. */}
            {a.type === 'market_quote_fetch' && a.detail?.symbol && (
              <p className="hint log-reason">{a.detail.symbol}{a.detail.error ? ` · ${a.detail.error}` : ''}</p>
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
