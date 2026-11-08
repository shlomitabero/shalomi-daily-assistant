import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { actionTypeLabel, formatMoney } from '../labels.js';

const MODE_LABEL = {
  research: 'מחקר בלבד — איתור והצגת הזדמנויות, שום דבר לא מתבצע לבד',
  approve: 'דורש אישור — כל פעולה אמיתית (כמו פרסום מוצר) ממתינה לאישור שלך',
  auto_limited: 'אוטומטי מוגבל — פועל לבד בתוך התקציב וההגבלות שהגדרת',
};

export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [opportunities, setOpportunities] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [sources, setSources] = useState([]);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getLedgerSummary(),
      api.getOpportunities(),
      api.getApprovals(),
      api.getSources(),
      api.getSettings(),
    ])
      .then(([s, o, a, src, set]) => {
        setSummary(s.summary);
        setOpportunities(o.opportunities);
        setApprovals(a.approvals.filter((x) => x.status === 'approved'));
        setSources(src.sources);
        setSettings(set.settings);
      })
      .catch((err) => setError(err.data?.error || err.message));
  }, []);

  // An approval has already done its job once its opportunity is published —
  // only count ones whose opportunity is still a draft as "waiting to run".
  const pendingApprovals = approvals.filter((a) => {
    const opp = opportunities.find((o) => o.id === a.opportunityId);
    return opp?.status === 'draft';
  });
  // A demo draft (no ANTHROPIC_API_KEY when it was drafted) can never
  // actually be published - publishing.js refuses it - and this list is
  // sliced down to the top 3 below, so without this exclusion a demo
  // draft could occupy one of those 3 slots and crowd out a real,
  // actionable opportunity from the dashboard. digest.js's own
  // recommendation and runAutonomousScan's pending-draft cap already
  // exclude demo drafts for the same reason - this was the one
  // "what should I look at" surface left out of that pattern.
  const activeOpportunities = opportunities.filter((o) => o.status !== 'published' && o.status !== 'rejected' && !o.productDraft?.demo);

  if (error) return <div className="page"><p className="form-error">{error}</p></div>;
  if (!summary || !settings) return <div className="page-loading">טוען…</div>;

  // canSpend()'s real-money gate already compares spentSoFar/lossSoFar
  // against budget/maxLoss on every spend attempt - until now the owner
  // had no way to see how close they were to either except by waiting for
  // a real action to actually get blocked. 80% is a warning, not the limit
  // itself: the gate alone still decides what's actually allowed.
  const budgetRatio = settings.budgetConfigured && settings.budget > 0 ? summary.spentSoFar / settings.budget : null;
  const nearBudget = budgetRatio != null && budgetRatio >= 0.8;
  const maxLossRatio = settings.maxLoss > 0 ? summary.lossSoFar / settings.maxLoss : null;
  const nearMaxLoss = maxLossRatio != null && maxLossRatio >= 0.8;
  const unrecordedSales = summary.unrecordedSales ?? 0;
  // Computed server-side now (services/ledger.js's getLedgerSummary) over
  // the entire lifetime ledger - this page used to fetch every raw ledger
  // entry ever created via a separate call just to reduce them into this
  // same shape client-side.
  const revenueBySource = summary.revenueBySource ?? {};

  const connectedCount = sources.filter((s) => s.connected).length;

  // One concrete next step, picked in priority order, so there's always a
  // clear answer to "what should I actually do now" instead of just numbers.
  let nextStep = null;
  if (settings.mode === 'research') {
    // The single most common reason the owner sees zero real activity: the
    // mode card lower on this page already says this in small print, but
    // without a prominent, actionable callout it's easy to miss entirely —
    // everything else below (budget, opportunities, approvals) can look
    // "ready" while this one setting silently keeps every real action from
    // ever running.
    nextStep = {
      text: 'המצב הנוכחי הוא "מחקר בלבד" — המערכת מאתרת ומכינה הזדמנויות, אבל לעולם לא מפרסמת ולא גובה כסף אמיתי בעצמה. כדי שהרווח יתחיל לקרות בפועל, צריך לבחור מצב אחר בהגדרות.',
      to: '/settings', cta: 'להגדרות',
    };
  } else if (opportunities.length === 0) {
    nextStep = { text: 'עדיין אין אף הזדמנות. אפשר לסרוק אוטומטית או ליצור מוצר דיגיטלי ידנית.', to: '/opportunities', cta: 'להזדמנויות' };
  } else if (activeOpportunities.length >= 5) {
    // Matches server/src/services/opportunities.js's MAX_PENDING_DRAFTS -
    // runAutonomousScan logs this as a silent 'skipped' result with
    // nothing in the UI explaining why the scan stopped producing
    // anything new. This was the most likely real explanation for "the
    // scanner isn't finding anything" once a backlog piles up unreviewed.
    nextStep = {
      text: `${activeOpportunities.length} הזדמנויות ממתינות לסקירה שלך — הסריקה האוטומטית משהה את עצמה עד שתסקור או תדחה חלק מהן.`,
      to: '/opportunities', cta: 'להזדמנויות',
    };
  } else if (pendingApprovals.length > 0 && settings.mode === 'approve') {
    nextStep = { text: `${pendingApprovals.length} פעולות ממתינות לאישור שלך ולא יתבצעו בלעדיו.`, to: '/approvals', cta: 'לאישורים' };
  } else if (!settings.budgetConfigured) {
    // Publishing the one implemented revenue path costs $0 (no ad spend, no
    // COGS — see autonomousScan.js), so a missing budget never actually
    // blocks it — the previous wording here overstated that and could read
    // as "this is why nothing published" when it wasn't. It only matters
    // for a future action that spends real money.
    nextStep = {
      text: 'עדיין לא הוגדר תקציב — זה לא חוסם פרסום מוצרים (שזה בחינם), אבל יחסום כל פעולה עתידית שעולה כסף אמיתי. מומלץ להגדיר בהגדרות.',
      to: '/settings', cta: 'להגדרות',
    };
  }

  return (
    <div className="page">
      <h1>היום</h1>

      {settings.emergencyStop && (
        <div className="card" style={{ borderColor: 'var(--accent)', background: 'rgba(220, 38, 38, 0.08)' }}>
          <p style={{ margin: '0 0 6px', fontWeight: 700 }}>🛑 עצירת חירום פעילה</p>
          <p className="hint" style={{ margin: '0 0 10px' }}>
            שום פעולה אמיתית (פרסום, חיוב) לא מתבצעת כרגע, בלי קשר למצב הפעולה שנבחר למטה — העצירה חוסמת הכול.
          </p>
          <Link className="btn btn-primary" to="/settings">לביטול העצירה</Link>
        </div>
      )}

      {unrecordedSales > 0 && (
        <div className="card" style={{ borderColor: 'var(--accent)', background: 'rgba(220, 38, 38, 0.08)' }}>
          <p style={{ margin: '0 0 6px', fontWeight: 700 }}>🚨 תשלומים אמיתיים שלא נרשמו</p>
          <p className="hint" style={{ margin: 0 }}>
            {unrecordedSales} תשלומים אמיתיים התקבלו אך לא נרשמו ביומן בגלל שגיאה בעיבוד — בדוק ביומן הפעולות ואת לוגי השרת.
            אין מסלול אוטומטי לתיקון זה; הכסף כבר התקבל אבל לא חושב ברווח/הפסד עד שזה יטופל.
          </p>
        </div>
      )}

      {nearBudget && (
        <div className="card" style={{ borderColor: 'var(--accent)', background: 'rgba(220, 38, 38, 0.08)' }}>
          <p style={{ margin: '0 0 6px', fontWeight: 700 }}>⚠️ מתקרב לתקציב שהוגדר</p>
          <p className="hint" style={{ margin: '0 0 10px' }}>
            הוצא עד כה: {formatMoney(summary.spentSoFar, 2)} מתוך {formatMoney(settings.budget, 2)}
            {' '}({Math.round(budgetRatio * 100)}%). ברגע שהתקציב יעבור את התקרה, כל פעולה בתשלום תיחסם אוטומטית.
          </p>
          <Link className="btn btn-primary" to="/settings">לעדכון התקציב</Link>
        </div>
      )}

      {nearMaxLoss && (
        <div className="card" style={{ borderColor: 'var(--accent)', background: 'rgba(220, 38, 38, 0.08)' }}>
          <p style={{ margin: '0 0 6px', fontWeight: 700 }}>⚠️ מתקרב להפסד המרבי שהוגדר</p>
          <p className="hint" style={{ margin: '0 0 10px' }}>
            הפסד עד כה: {formatMoney(summary.lossSoFar, 2)} מתוך {formatMoney(settings.maxLoss, 2)}
            {' '}({Math.round(maxLossRatio * 100)}%). ברגע שההפסד יעבור את התקרה, כל פעולה בתשלום תיחסם אוטומטית.
          </p>
          <Link className="btn btn-primary" to="/settings">לעדכון התקרה</Link>
        </div>
      )}

      <div className="card">
        <p style={{ margin: '0 0 6px', fontWeight: 700 }}>⚡ מה זה PROFIT AI</p>
        <p className="hint" style={{ margin: 0 }}>
          מנוע הכנסות אישי: מחפש הזדמנויות הכנסה אמיתיות, בונה עבורן כרטיס כדאיות כן (בלי להמציא ביקוש או מחיר),
          ופועל על פיהן רק בתוך הגבולות שקבעת. לא מבטיח רווח — רק לא משקר על המספרים.
        </p>
        <p className="hint" style={{ margin: '8px 0 0' }}>
          <strong style={{ color: 'var(--text)' }}>מצב נוכחי: </strong>{MODE_LABEL[settings.mode] ?? settings.mode}
        </p>
        <Link className="btn btn-ghost" to="/guide" style={{ marginTop: 10, display: 'inline-block' }}>📖 מדריך שימוש — איך מתחילים</Link>
      </div>

      {nextStep && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <p style={{ margin: '0 0 10px' }}>👉 {nextStep.text}</p>
          <Link className="btn btn-primary" to={nextStep.to}>{nextStep.cta}</Link>
        </div>
      )}

      <div className="cash-grid">
        <div className="cash-box cash-in">
          <span>נכנס היום</span>
          <strong>${summary.cashInToday.toFixed(2)}</strong>
        </div>
        <div className="cash-box cash-out">
          <span>יצא היום</span>
          <strong>${summary.cashOutToday.toFixed(2)}</strong>
        </div>
      </div>

      <div className={`net-profit-box ${summary.netProfitToday >= 0 ? 'positive' : 'negative'}`}>
        <span>רווח/הפסד נטו היום (מאומת, לא תזרים)</span>
        <strong>{formatMoney(summary.netProfitToday)}</strong>
      </div>

      <div className="stat-row">
        <div className="stat-chip">
          <span>כסף שטרם נגבה</span>
          <strong>${summary.outstandingReceivables.toFixed(2)}</strong>
        </div>
        <div className="stat-chip">
          <span>התחייבויות שטרם שולמו</span>
          <strong>${summary.pendingObligations.toFixed(2)}</strong>
        </div>
        <div className="stat-chip">
          <span>רווח נטו מצטבר (מאומת)</span>
          <strong>{formatMoney(summary.netProfitAllTime)}</strong>
        </div>
      </div>

      <section className="section">
        <div className="section-header">
          <h2>הזדמנויות פעילות ({activeOpportunities.length})</h2>
          <Link className="link" to="/opportunities">הכל ←</Link>
        </div>
        {activeOpportunities.length === 0 && <p className="hint">אין הזדמנות מספקת כרגע — זה תקין, אין צורך לפעול רק בשביל לפעול.</p>}
        {activeOpportunities.slice(0, 3).map((o) => (
          <Link key={o.id} to={`/opportunities/${o.id}`} className="opp-row">
            <span className="opp-title">{o.title}</span>
            <span className="opp-profit">{o.netProfitMid != null ? formatMoney(o.netProfitMid, 0) : 'חסר מידע'}</span>
          </Link>
        ))}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>ממתין לאישור ({pendingApprovals.length})</h2>
          <Link className="link" to="/approvals">הכל ←</Link>
        </div>
        {/* Unlike "הזדמנויות פעילות" right above, this section showed only a
            bare count with no preview of what's actually waiting - the owner
            had to click through to "אישורים" just to see which action needs
            their sign-off, even though this is exactly the kind of
            actionable item this page's "what should I do now" framing
            exists to surface directly. */}
        {pendingApprovals.slice(0, 3).map((a) => {
          const opp = opportunities.find((o) => o.id === a.opportunityId);
          return (
            <Link key={a.id} to={`/opportunities/${a.opportunityId}`} className="opp-row">
              <span className="opp-title">{opp?.title ?? a.opportunityId}</span>
              <span className="opp-profit">{actionTypeLabel(a.actionType)}</span>
            </Link>
          );
        })}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>מקורות הכנסה ({connectedCount}/{sources.length} מחוברים)</h2>
          <Link className="link" to="/sources">פרטים ←</Link>
        </div>
        {sources.map((s) => (
          <div key={s.id} className="source-row">
            <span className={`dot ${s.connected ? 'dot-on' : 'dot-off'}`} />
            <span className="source-name">{s.name}</span>
            <span className="source-revenue">
              {revenueBySource[s.key] ? `$${revenueBySource[s.key].toFixed(0)} נכנס` : s.connected ? 'עדיין ללא תוצאה' : 'לא מחובר'}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
