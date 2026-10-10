import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

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
  const [entries, setEntries] = useState([]);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getLedgerSummary(),
      api.getOpportunities(),
      api.getApprovals(),
      api.getSources(),
      api.getLedgerEntries(),
      api.getSettings(),
    ])
      .then(([s, o, a, src, led, set]) => {
        setSummary(s.summary);
        setOpportunities(o.opportunities);
        setApprovals(a.approvals.filter((x) => x.status === 'approved'));
        setSources(src.sources);
        setEntries(led.entries);
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
  const activeOpportunities = opportunities.filter((o) => o.status !== 'published' && o.status !== 'rejected');

  // Which source actually produced verified revenue vs. which only cost money with nothing to show.
  const revenueBySource = {};
  for (const e of entries) {
    if (e.type !== 'revenue' || !e.verified || !e.opportunityId) continue;
    const opp = opportunities.find((o) => o.id === e.opportunityId);
    const key = opp?.source ?? 'unknown';
    revenueBySource[key] = (revenueBySource[key] ?? 0) + e.amount;
  }

  if (error) return <div className="page"><p className="form-error">{error}</p></div>;
  if (!summary || !settings) return <div className="page-loading">טוען…</div>;

  const connectedCount = sources.filter((s) => s.connected).length;

  // One concrete next step, picked in priority order, so there's always a
  // clear answer to "what should I actually do now" instead of just numbers.
  let nextStep = null;
  if (!settings.budgetConfigured) {
    nextStep = { text: 'עדיין לא הוגדר תקציב — בלי תקציב המערכת לא תפרסם ולא תוציא כסף אמיתי, גם במצב אוטומטי. הגדירי תקציב בהגדרות.', to: '/settings', cta: 'להגדרות' };
  } else if (opportunities.length === 0) {
    nextStep = { text: 'עדיין אין אף הזדמנות. אפשר לסרוק אוטומטית או ליצור מוצר דיגיטלי ידנית.', to: '/opportunities', cta: 'להזדמנויות' };
  } else if (pendingApprovals.length > 0 && settings.mode === 'approve') {
    nextStep = { text: `${pendingApprovals.length} פעולות ממתינות לאישור שלך ולא יתבצעו בלעדיו.`, to: '/approvals', cta: 'לאישורים' };
  }

  return (
    <div className="page">
      <h1>היום</h1>

      <div className="card">
        <p style={{ margin: '0 0 6px', fontWeight: 700 }}>⚡ מה זה PROFIT AI</p>
        <p className="hint" style={{ margin: 0 }}>
          מנוע הכנסות אישי: מחפש הזדמנויות הכנסה אמיתיות, בונה עבורן כרטיס כדאיות כן (בלי להמציא ביקוש או מחיר),
          ופועל על פיהן רק בתוך הגבולות שקבעת. לא מבטיח רווח — רק לא משקר על המספרים.
        </p>
        <p className="hint" style={{ margin: '8px 0 0' }}>
          <strong style={{ color: 'var(--text)' }}>מצב נוכחי: </strong>{MODE_LABEL[settings.mode] ?? settings.mode}
        </p>
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
          <strong>₪{summary.cashInToday.toFixed(2)}</strong>
        </div>
        <div className="cash-box cash-out">
          <span>יצא היום</span>
          <strong>₪{summary.cashOutToday.toFixed(2)}</strong>
        </div>
      </div>

      <div className={`net-profit-box ${summary.netProfitToday >= 0 ? 'positive' : 'negative'}`}>
        <span>רווח/הפסד נטו היום (מאומת, לא תזרים)</span>
        <strong>₪{summary.netProfitToday.toFixed(2)}</strong>
      </div>

      <div className="stat-row">
        <div className="stat-chip">
          <span>כסף שטרם נגבה</span>
          <strong>₪{summary.outstandingReceivables.toFixed(2)}</strong>
        </div>
        <div className="stat-chip">
          <span>התחייבויות שטרם שולמו</span>
          <strong>₪{summary.pendingObligations.toFixed(2)}</strong>
        </div>
        <div className="stat-chip">
          <span>רווח נטו מצטבר (מאומת)</span>
          <strong>₪{summary.netProfitAllTime.toFixed(2)}</strong>
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
            <span className="opp-profit">{o.netProfitMid != null ? `₪${o.netProfitMid.toFixed(0)}` : 'חסר מידע'}</span>
          </Link>
        ))}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>ממתין לאישור ({pendingApprovals.length})</h2>
          <Link className="link" to="/approvals">הכל ←</Link>
        </div>
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
              {revenueBySource[s.key] ? `₪${revenueBySource[s.key].toFixed(0)} נכנס` : s.connected ? 'עדיין ללא תוצאה' : 'לא מחובר'}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
