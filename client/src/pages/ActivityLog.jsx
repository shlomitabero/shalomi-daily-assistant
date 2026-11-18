import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { actionTypeLabel, resultLabel, reasonLabel, formatMoney, sideLabel, autonomousScanSummary, saleConfirmedSummary, settingsChangeSummary, opportunityChangeSummary } from '../labels.js';

export default function ActivityLog() {
  const [actions, setActions] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [error, setError] = useState('');
  const [resolvingId, setResolvingId] = useState(null);

  function refresh() {
    api.getActions().then((r) => setActions(r.actions)).catch((err) => setError(err.data?.error || err.message));
    // Best-effort only: most log entries carry detail.opportunityId, but
    // without this there was no way to tell from the log alone WHICH
    // product a "פרסום מוצר - הצלחה" or "דחיית הזדמנות - הצלחה" row was
    // even about - every entry of the same type read identically. A
    // failure here just means titles don't resolve; it must never block
    // the log itself from rendering.
    api.getOpportunities().then((r) => setOpportunities(r.opportunities)).catch(() => {});
  }
  useEffect(refresh, []);

  // Until now a blocked sale_confirmed (a real customer's real payment that
  // billing.js's webhook couldn't record) followed the owner forever, on
  // every visit to this page and every daily digest, with no way to ever
  // clear it - routes/actions.js's resolveUnrecordedSale lets them dismiss
  // one once they've actually dealt with it elsewhere (checked the server
  // logs, manually recorded the real ledger entry if the money is
  // genuinely theirs). This only removes the alert - it never touches the
  // ledger itself, so the confirm text says so plainly rather than implying
  // the system verified anything.
  async function onResolve(id) {
    if (!window.confirm('לסמן את הבעיה הזו כטופלה? זה רק מסיר את ההתראה - אם לא תיקנת את הרישום ביומן בעצמך, הכסף עדיין לא יחושב ברווח/הפסד.')) return;
    setError('');
    setResolvingId(id);
    try {
      await api.resolveUnrecordedSale(id);
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setResolvingId(null);
    }
  }

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
                  // A blocked sale_confirmed the owner has already marked
                  // resolved (detail.resolvedAt) no longer represents an
                  // open problem - muted, the same treatment every other
                  // "the safety system working as intended" block already
                  // gets, not the one real exception's own red.
                  : a.type === 'sale_confirmed' && a.result?.startsWith('blocked') && !a.detail?.resolvedAt ? 'negative'
                    : a.result?.startsWith('blocked') ? 'muted'
                      : 'negative'
              }`}>
                {a.type === 'autonomous_scan' ? autonomousScanSummary(a) : a.type === 'sale_confirmed' ? saleConfirmedSummary(a) : resultLabel(a.result)}
              </span>
            </div>
            {/* Lets the owner dismiss a real-but-unrecorded sale once
                they've actually dealt with it elsewhere - see onResolve's
                own comment above for why this never touches the ledger
                itself. */}
            {a.type === 'sale_confirmed' && a.result?.startsWith('blocked') && (
              a.detail?.resolvedAt ? (
                // Same gap Approvals.jsx's own approvedAt/rejectedAt display
                // already closed - the checkmark alone said THAT the owner
                // dealt with this, with no way to tell WHEN, even though
                // onResolve (above) has stamped detail.resolvedAt since the
                // feature shipped.
                <p className="hint positive" style={{ margin: '4px 0 0' }}>✓ סומן כטופל ב-{new Date(a.detail.resolvedAt).toLocaleString('he-IL')}</p>
              ) : (
                <button className="btn btn-ghost" style={{ marginTop: 6 }} onClick={() => onResolve(a.id)} disabled={resolvingId === a.id}>
                  {resolvingId === a.id ? 'מסמן…' : 'סמן כטופל'}
                </button>
              )
            )}
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
            {/* routes/billing.js's webhook handler logs the source ip the
                same way login_attempt already does - this endpoint is
                exactly as public and unauthenticated as /login, so a
                failed signature check here deserves the same "where did
                this come from" visibility. */}
            {a.type === 'webhook_signature_failed' && a.detail?.ip && (
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
            {/* routes/financial.js's deleteWatchlistEntry now logs the
                removed symbol - without this the row just said "הסרת
                סימבול ממעקב - הצלחה" with no way to tell which symbol was
                actually removed. */}
            {a.type === 'remove_from_watchlist' && a.detail?.symbol && (
              <p className="hint log-reason">{a.detail.symbol}</p>
            )}
            {/* addToWatchlist's own mirror of the above - without this the
                row just said "הוספת סימבול למעקב - הצלחה" with no way to
                tell which symbol was actually added. */}
            {a.type === 'add_to_watchlist' && a.detail?.symbol && (
              <p className="hint log-reason">{a.detail.symbol}</p>
            )}
            {/* routes/settings.js now logs the exact before/after diff for
                every settings save that actually changed something - without
                this the row just said "עדכון הגדרות - הצלחה" with no way to
                tell WHAT changed, for the most consequential settings in the
                whole app (mode gates every real action; emergencyStop halts
                everything immediately). */}
            {a.type === 'settings_updated' && a.detail?.changed && (
              <p className="hint log-reason">{settingsChangeSummary(a.detail.changed)}</p>
            )}
            {/* routes/opportunities.js's patchOpportunity now logs the exact
                before/after diff for every edit-form save that actually
                changed something - same gap as settings_updated above,
                just for a single opportunity's own revenueEstimate/costs/
                riskLevel/dataQuality/priceUSD. */}
            {a.type === 'opportunity_updated' && a.detail?.changed && (
              <p className="hint log-reason">{opportunityChangeSummary(a.detail.changed)}</p>
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
