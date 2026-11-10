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
  // Promise.all meant a single failing call among these five (a transient
  // blip hitting just /sources, say) blanked this entire page down to one
  // error line - even though the other four, including the owner's own
  // cash-in/cash-out numbers, loaded perfectly fine. summary/settings are
  // genuinely load-bearing for everything below (budget ratios, the mode
  // card, the cash boxes), so a failure in either of those two still blocks
  // the page same as before - but opportunities/approvals/sources each get
  // their own section below, so a failure in just one of those three
  // shouldn't take the whole dashboard down with it.
  const [sectionErrors, setSectionErrors] = useState({});

  useEffect(() => {
    Promise.allSettled([
      api.getLedgerSummary(),
      api.getOpportunities(),
      api.getApprovals(),
      api.getSources(),
      api.getSettings(),
    ]).then(([sRes, oRes, aRes, srcRes, setRes]) => {
      const critical = sRes.status === 'rejected' ? sRes : setRes.status === 'rejected' ? setRes : null;
      if (critical) {
        setError(critical.reason?.data?.error || critical.reason?.message);
        return;
      }
      setSummary(sRes.value.summary);
      setSettings(setRes.value.settings);

      // opportunities/approvals/sources default to [] (their initial state)
      // on failure - that must never be shown as if it were real data (an
      // honest "0 opportunities" and a failed-to-load "0 opportunities"
      // look identical otherwise, exactly the kind of fabricated-looking
      // number this app exists to avoid), so each section below checks
      // sectionErrors first and shows an explicit load failure instead of
      // silently rendering the empty fallback as if it were the truth.
      const errors = {};
      if (oRes.status === 'fulfilled') setOpportunities(oRes.value.opportunities);
      else errors.opportunities = oRes.reason?.data?.error || oRes.reason?.message;
      if (aRes.status === 'fulfilled') setApprovals(aRes.value.approvals.filter((x) => x.status === 'approved'));
      else errors.approvals = aRes.reason?.data?.error || aRes.reason?.message;
      if (srcRes.status === 'fulfilled') setSources(srcRes.value.sources);
      else errors.sources = srcRes.reason?.data?.error || srcRes.reason?.message;
      setSectionErrors(errors);
    });
  }, []);

  // An approval has already done its job once its opportunity is published —
  // only count ones whose opportunity is still a draft as "waiting to run".
  const pendingApprovals = approvals.filter((a) => {
    const opp = opportunities.find((o) => o.id === a.opportunityId);
    return opp?.status === 'draft';
  });
  // pendingApprovals looks up each approval's own opportunity by id - a
  // failed opportunities load (not just a failed approvals load) makes
  // this count just as unreliable, since every lookup above would
  // silently miss against an empty opportunities array.
  const approvalsUnreliable = Boolean(sectionErrors.approvals || sectionErrors.opportunities);
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
  } else if (sectionErrors.opportunities) {
    // opportunities.length === 0 after a failed load is empty, not
    // genuinely zero - the branch below would otherwise tell the owner
    // "you have no opportunities yet," which isn't true, it just failed
    // to load this time.
    nextStep = { text: 'לא ניתן לטעון את ההזדמנויות כרגע — נסה לרענן את העמוד.', to: '/opportunities', cta: 'לנסות שוב' };
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
          <h2>הזדמנויות פעילות {sectionErrors.opportunities ? '' : `(${activeOpportunities.length})`}</h2>
          <Link className="link" to="/opportunities">הכל ←</Link>
        </div>
        {sectionErrors.opportunities ? (
          <p className="form-error">לא ניתן לטעון הזדמנויות כרגע — {sectionErrors.opportunities}</p>
        ) : activeOpportunities.length === 0 ? (
          <p className="hint">אין הזדמנות מספקת כרגע — זה תקין, אין צורך לפעול רק בשביל לפעול.</p>
        ) : null}
        {!sectionErrors.opportunities && activeOpportunities.slice(0, 3).map((o) => (
          <Link key={o.id} to={`/opportunities/${o.id}`} className="opp-row">
            <span className="opp-title">{o.title}</span>
            <span className="opp-profit">{o.netProfitMid != null ? formatMoney(o.netProfitMid, 0) : 'חסר מידע'}</span>
          </Link>
        ))}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>ממתין לאישור {approvalsUnreliable ? '' : `(${pendingApprovals.length})`}</h2>
          <Link className="link" to="/approvals">הכל ←</Link>
        </div>
        {/* Unlike "הזדמנויות פעילות" right above, this section showed only a
            bare count with no preview of what's actually waiting - the owner
            had to click through to "אישורים" just to see which action needs
            their sign-off, even though this is exactly the kind of
            actionable item this page's "what should I do now" framing
            exists to surface directly. */}
        {/* Same reassuring zero-state as "הזדמנויות פעילות" right above -
            this section was the one exception, showing its header and count
            then nothing at all underneath when empty, easy to mistake for
            "still loading" instead of the normal, common state it actually
            is (nothing to approve right now). pendingApprovals itself looks
            up each approval's opportunity by id, so a failed opportunities
            load (not just a failed approvals load) makes this count just as
            unreliable - both must show the honest failure, not a
            fabricated zero that looks identical to "genuinely nothing
            pending". */}
        {approvalsUnreliable ? (
          <p className="form-error">לא ניתן לטעון אישורים כרגע — {sectionErrors.approvals || sectionErrors.opportunities}</p>
        ) : pendingApprovals.length === 0 ? (
          <p className="hint">אין כרגע שום פעולה שממתינה לאישור שלך.</p>
        ) : null}
        {!approvalsUnreliable && pendingApprovals.slice(0, 3).map((a) => {
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
          <h2>מקורות הכנסה {sectionErrors.sources ? '' : `(${connectedCount}/${sources.length} מחוברים)`}</h2>
          <Link className="link" to="/sources">פרטים ←</Link>
        </div>
        {sectionErrors.sources && <p className="form-error">לא ניתן לטעון מקורות הכנסה כרגע — {sectionErrors.sources}</p>}
        {!sectionErrors.sources && sources.map((s) => (
          <div key={s.id} className="source-row">
            <span className={`dot ${s.connected ? 'dot-on' : 'dot-off'}`} />
            <span className="source-name">{s.name}</span>
            <span className="source-revenue">
              {revenueBySource[s.key]
                ? `$${revenueBySource[s.key].toFixed(0)} נכנס`
                : s.key === 'financial_markets'
                  // Unlike every other source, this one structurally can never
                  // show real revenue here, connected or not - README.md is
                  // explicit that real trading (the only way this source could
                  // ever produce a real ledger entry) requires a broker
                  // connection this build deliberately doesn't include.
                  // "עדיין ללא תוצאה" ("no result YET") would imply that's just
                  // a matter of time, which isn't honest for this one source.
                  ? 'מסחר מדומה בלבד — לא מייצר הכנסה אמיתית'
                  : s.connected ? 'עדיין ללא תוצאה' : 'לא מחובר'}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
