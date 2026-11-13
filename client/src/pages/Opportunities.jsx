import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { riskLevelLabel, formatMoney, autonomousScanSummary } from '../labels.js';

const STATUS_LABEL = { draft: 'טיוטה', published: 'פורסם', rejected: 'נדחה' };

export default function Opportunities() {
  const [opportunities, setOpportunities] = useState([]);
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [error, setError] = useState('');
  const [lastScan, setLastScan] = useState(undefined); // undefined = still loading, null = never ran

  function refresh() {
    api.getOpportunities().then((r) => setOpportunities(r.opportunities)).catch((err) => setError(err.data?.error || err.message));
    // The scheduled scan (every 4 hours, server.js) logs here too, not just
    // a manual "סרוק עכשיו" click - without this, the owner had no way to
    // tell the scheduled scan is actually running on its own short of
    // digging through the full, unrelated-actions-mixed-in activity log.
    api.getActions()
      .then((r) => setLastScan(r.actions.find((a) => a.type === 'autonomous_scan') ?? null))
      .catch(() => setLastScan(null));
  }

  useEffect(refresh, []);

  async function onCreate(e) {
    e.preventDefault();
    // Neither input has a `required` attribute, so clicking "צור טיוטת
    // מוצר" with one or both fields empty used to just silently do
    // nothing - no error, no native browser validation message either -
    // indistinguishable from the button being broken.
    if (!topic.trim() || !audience.trim()) {
      setError('יש למלא גם נושא וגם קהל מטרה');
      return;
    }
    setError('');
    // These two cards' own result states live side by side on this same
    // page but were never cleared by each other's action - a scan
    // failure/result shown in the "סריקה אוטונומית" card above kept
    // showing indefinitely even after a later, unrelated manual create
    // succeeded or failed on its own. Same staleness bug already fixed
    // this session for OpportunityDetail.jsx's error/publishResult pair.
    setScanResult(null);
    setBusy(true);
    try {
      await api.createDigitalProduct(topic.trim(), audience.trim());
      setTopic('');
      setAudience('');
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onScanNow() {
    setScanBusy(true);
    setScanResult(null);
    // Mirrors the clear above: a failed manual "new digital product"
    // attempt's error (shown in the card below this one) must not keep
    // showing once the owner has moved on to running a scan instead.
    setError('');
    try {
      const result = await api.runAutonomousScan();
      setScanResult(result);
      refresh();
    } catch (err) {
      setScanResult({ ran: false, reason: err.data?.error || err.message });
    } finally {
      setScanBusy(false);
    }
  }

  // The list came back in ranking order with no regard for status - a
  // rejected or already-published opportunity could outrank the actual
  // drafts the owner needs to look at, and only grows more cluttered as
  // more get published or rejected over time. Active drafts (the thing
  // this whole page is for) always come first, in their existing ranked
  // order; resolved ones are still visible, just out of the way below.
  // A demo draft (no ANTHROPIC_API_KEY when drafted) can never actually
  // be published - publishing.js refuses it - so it can never be acted
  // on either; digest.js, runAutonomousScan and the dashboard already
  // exclude it from their own "what should I look at" surfaces for the
  // same reason. It still shows up here, just below with the resolved
  // ones rather than mixed into the worklist of things that can
  // actually be acted on.
  const activeOpportunities = opportunities.filter((o) => o.status === 'draft' && !o.productDraft?.demo);
  // Unlike activeOpportunities (naturally capped at 5 by the scan's own
  // pending-draft limit), this list only ever grows as the scan keeps
  // publishing/producing demo drafts every few hours, indefinitely - after
  // enough months of real use this would mean rendering hundreds of DOM
  // rows on one page with no pagination anywhere in this app. Sorted
  // newest-first by createdAt (more useful for a completed-history list
  // than the implicit score order the API returns) and capped at the most
  // recent 50; MAX_RESOLVED_SHOWN only limits what's rendered here, never
  // what the API itself returns, so Dashboard.jsx's own per-source revenue
  // breakdown (which looks up a resolved opportunity by id from the same
  // fetch) stays accurate regardless of how old it is.
  const MAX_RESOLVED_SHOWN = 50;
  const allResolvedOpportunities = opportunities
    .filter((o) => o.status !== 'draft' || o.productDraft?.demo)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const resolvedOpportunities = allResolvedOpportunities.slice(0, MAX_RESOLVED_SHOWN);

  return (
    <div className="page">
      <h1>הזדמנויות</h1>
      <p className="hint" style={{ marginTop: -10, marginBottom: 16 }}>
        כל "הזדמנות" כאן היא מוצר דיגיטלי אמיתי (מדריך/תבנית/כלי) עם דף מכירה, שמוכן לפרסום בתשלום אמיתי —
        לא רעיון כללי. אפשר לתת למערכת לחפש נושא לבד, או לבחור נושא בעצמך.
      </p>

      <div className="card">
        <h3>סריקה אוטונומית</h3>
        <p className="hint">המערכת סורקת לבד כל כמה שעות ומחפשת רעיון למוצר חדש. אפשר גם להריץ עכשיו ידנית לבדיקה.</p>
        {lastScan !== undefined && (
          <p className="hint">
            <strong style={{ color: 'var(--text)' }}>סריקה אחרונה: </strong>
            {lastScan ? `${new Date(lastScan.createdAt).toLocaleString('he-IL')} — ${autonomousScanSummary(lastScan)}` : autonomousScanSummary(null)}
          </p>
        )}
        <button className="btn btn-ghost" onClick={onScanNow} disabled={scanBusy}>{scanBusy ? 'סורק…' : 'סרוק עכשיו'}</button>
        {scanResult && (
          <p className={scanResult.ran ? 'positive' : 'hint'}>
            {scanResult.ran ? `נוצרה הזדמנות: ${scanResult.opportunity?.title}` : `לא נוצר דבר: ${scanResult.reason}`}
          </p>
        )}
      </div>

      <form className="card form" onSubmit={onCreate}>
        <h3>מוצר דיגיטלי חדש (ידני)</h3>
        <label>
          נושא
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="לדוגמה: ניהול תזרים מזומנים לעצמאים" />
        </label>
        <label>
          קהל מטרה
          <input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="לדוגמה: עצמאים ופרילנסרים" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'מכין טיוטה…' : 'צור טיוטת מוצר'}</button>
      </form>

      <section className="section">
        {opportunities.length === 0 && <p className="hint">אין הזדמנויות עדיין.</p>}
        {/* opportunities.length === 0 above only covers "none at all" - once
            every draft has been published/rejected (or is demo-only),
            opportunities.length stays positive while activeOpportunities is
            empty, and this section rendered nothing at all between the
            create form and "הושלמו" below it: a gap easy to mistake for a
            loading glitch instead of the normal state it actually is
            (nothing new to review right now). */}
        {opportunities.length > 0 && activeOpportunities.length === 0 && (
          <p className="hint">אין כרגע הזדמנויות פעילות לסקירה — כל מה שנוצר עד כה כבר טופל, למטה תחת "הושלמו".</p>
        )}
        {activeOpportunities.map((o) => (
          <Link key={o.id} to={`/opportunities/${o.id}`} className="opp-card">
            <div className="opp-card-top">
              <span className="opp-title">{o.title}</span>
              <span className={`badge badge-${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span>
            </div>
            <div className="opp-card-bottom">
              <span>{o.netProfitMid != null ? `רווח משוער: ${formatMoney(o.netProfitMid, 0)}` : 'חסר מידע לחישוב רווח'}</span>
              <span>סיכון: {riskLevelLabel(o.riskLevel)}</span>
            </div>
          </Link>
        ))}
      </section>

      {resolvedOpportunities.length > 0 && (
        <section className="section">
          <h2>הושלמו ({allResolvedOpportunities.length})</h2>
          {allResolvedOpportunities.length > MAX_RESOLVED_SHOWN && (
            <p className="hint">מוצגות {MAX_RESOLVED_SHOWN} העדכניות מתוך {allResolvedOpportunities.length}.</p>
          )}
          {resolvedOpportunities.map((o) => (
            <Link key={o.id} to={`/opportunities/${o.id}`} className="opp-card">
              <div className="opp-card-top">
                <span className="opp-title">{o.title}</span>
                <span className={`badge badge-${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span>
              </div>
              <div className="opp-card-bottom">
                <span>{o.netProfitMid != null ? `רווח משוער: ${formatMoney(o.netProfitMid, 0)}` : 'חסר מידע לחישוב רווח'}</span>
                <span>סיכון: {riskLevelLabel(o.riskLevel)}</span>
              </div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
