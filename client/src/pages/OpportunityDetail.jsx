import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { opportunityStatusLabel, sourceLabel, missingFieldLabel, formatMoney } from '../labels.js';

export default function OpportunityDetail() {
  const { id } = useParams();
  const [opp, setOpp] = useState(null);
  const [settings, setSettings] = useState(null);
  const [hasPublishApproval, setHasPublishApproval] = useState(false);
  const [form, setForm] = useState({ low: '', mid: '', high: '', aiUsage: '', paymentProcessing: '', riskLevel: 'medium', dataQuality: 'unknown', priceUSD: 9 });
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishResult, setPublishResult] = useState(null);

  function refresh() {
    api.getOpportunity(id).then((r) => {
      setOpp(r.opportunity);
      setForm({
        low: r.opportunity.revenueEstimate?.low ?? '',
        mid: r.opportunity.revenueEstimate?.mid ?? '',
        high: r.opportunity.revenueEstimate?.high ?? '',
        aiUsage: r.opportunity.costs?.aiUsage ?? '',
        paymentProcessing: r.opportunity.costs?.paymentProcessing ?? '',
        riskLevel: r.opportunity.riskLevel,
        dataQuality: r.opportunity.dataQuality,
        priceUSD: r.opportunity.priceUSD,
      });
    }).catch((err) => setLoadError(err.data?.error || err.message));
    api.getSettings().then((r) => setSettings(r.settings)).catch((err) => setLoadError(err.data?.error || err.message));
    // In "approve" mode the publish button must stay disabled until this
    // exact opportunity's publish_product action has been approved — before
    // this, the owner could click "פרסם מוצר" straight away, the server
    // would correctly reject it with a 409 ("ממתין לאישור מפורש"), and the
    // button looked clickable with no indication anything was missing.
    api.getApprovals().then((r) => {
      const approved = r.approvals.some((a) => a.opportunityId === id && a.actionType === 'publish_product' && a.status === 'approved');
      setHasPublishApproval(approved);
    }).catch((err) => setLoadError(err.data?.error || err.message));
  }

  useEffect(refresh, [id]);

  async function onSave(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Previously this sent the whole estimate as null unless BOTH low and
      // high were filled in - so typing only one of them (e.g. just a low
      // estimate, meaning to fill in high next) silently discarded it on
      // save, with no error: refresh() would then overwrite the field back
      // to empty, as if the owner had never typed anything. Each field is
      // now sent independently, like costs.aiUsage/paymentProcessing below
      // already are - revenueEstimate is only null when all three are
      // genuinely empty (the owner explicitly cleared the whole estimate).
      const allRevenueFieldsEmpty = form.low === '' && form.mid === '' && form.high === '';
      await api.updateOpportunity(id, {
        revenueEstimate: allRevenueFieldsEmpty ? null : {
          low: form.low !== '' ? Number(form.low) : null,
          mid: form.mid !== '' ? Number(form.mid) : null,
          high: form.high !== '' ? Number(form.high) : null,
        },
        costs: { aiUsage: form.aiUsage !== '' ? Number(form.aiUsage) : null, paymentProcessing: form.paymentProcessing !== '' ? Number(form.paymentProcessing) : null },
        riskLevel: form.riskLevel,
        dataQuality: form.dataQuality,
        priceUSD: Number(form.priceUSD),
      });
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    setError('');
    setBusy(true);
    try {
      await api.approve(id, 'publish_product');
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onPublish() {
    setBusy(true);
    setPublishResult(null);
    try {
      await api.publishOpportunity(id);
      setPublishResult({ ok: true });
      refresh();
    } catch (err) {
      setPublishResult({ ok: false, message: err.data?.error || err.message });
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!window.confirm('לדחות את ההזדמנות הזו? לא יהיה אפשר לפרסם אותה אחר כך.')) return;
    setError('');
    setBusy(true);
    try {
      await api.rejectOpportunity(id);
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!opp) {
    return (
      <div className="page-loading">
        {loadError ? <p className="form-error">{loadError}</p> : 'טוען…'}
      </div>
    );
  }
  const draft = opp.productDraft;

  return (
    <div className="page">
      <Link className="link" to="/opportunities">← חזרה לכל ההזדמנויות</Link>
      <h1>{opp.title}</h1>
      <p className="hint">מקור: {sourceLabel(opp.source)} · סטטוס: {opportunityStatusLabel(opp.status)}</p>

      <div className="card">
        <h3>מה זה, מי משלם, ולמה</h3>
        <p>{opp.what}</p>
        <p>{opp.whoPays}</p>
        <p>{opp.why}</p>
      </div>

      {draft && (
        <div className="card">
          <h3>תוכן המוצר {draft.demo && <span className="demo-badge">דמו</span>}</h3>
          <p className="guide-preview">{draft.guide}</p>
          <h4>{draft.salesHeadline}</h4>
          <ul>{draft.salesBullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          <p>{draft.salesParagraph}</p>
        </div>
      )}

      {/* step="any" on every number input below: a type="number" input
          with no step attribute defaults to step=1, so typing ANY decimal
          value (e.g. 9.99 - the single most common digital-product price
          point) makes the field fail native HTML5 validation. The browser
          then silently blocks the form's submit event before React ever
          sees it - the owner's click on "שמור" would just do nothing, no
          error shown anywhere, for one of the most ordinary values anyone
          would type into a price or revenue field. */}
      <form className="card form" onSubmit={onSave}>
        <h3>הערכת רווח (על אחריותך — לא נתון מאומת)</h3>
        <div className="field-row">
          <label>הכנסה נמוכה ($)<input type="number" step="any" value={form.low} onChange={(e) => setForm({ ...form, low: e.target.value })} /></label>
          <label>הכנסה ממוצעת ($)<input type="number" step="any" value={form.mid} onChange={(e) => setForm({ ...form, mid: e.target.value })} /></label>
          <label>הכנסה גבוהה ($)<input type="number" step="any" value={form.high} onChange={(e) => setForm({ ...form, high: e.target.value })} /></label>
        </div>
        <div className="field-row">
          <label>עלות AI ($)<input type="number" step="any" value={form.aiUsage} onChange={(e) => setForm({ ...form, aiUsage: e.target.value })} /></label>
          <label>עמלת סליקה ($)<input type="number" step="any" value={form.paymentProcessing} onChange={(e) => setForm({ ...form, paymentProcessing: e.target.value })} /></label>
        </div>
        <div className="field-row">
          <label>רמת סיכון
            <select value={form.riskLevel} onChange={(e) => setForm({ ...form, riskLevel: e.target.value })}>
              <option value="low">נמוכה</option>
              <option value="medium">בינונית</option>
              <option value="high">גבוהה</option>
            </select>
          </label>
          <label>איכות הנתונים
            <select value={form.dataQuality} onChange={(e) => setForm({ ...form, dataQuality: e.target.value })}>
              <option value="unknown">לא ידוע</option>
              <option value="estimated">הערכה</option>
              <option value="verified">מאומת</option>
            </select>
          </label>
        </div>
        <label>
          מחיר מוצר ($)
          <input
            type="number"
            step="any"
            value={form.priceUSD}
            onChange={(e) => setForm({ ...form, priceUSD: e.target.value })}
            disabled={opp.status === 'published'}
            title={opp.status === 'published' ? 'לא ניתן לשנות מחיר אחרי פרסום — המחיר כבר קבוע ב-Paddle' : undefined}
          />
        </label>
        {opp.status === 'published' && <p className="hint" style={{ margin: '-4px 0 0' }}>המחיר נעול — הוא כבר קבוע בדף המכירה האמיתי ואי אפשר לשנות אותו בדיעבד.</p>}
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-ghost" type="submit" disabled={busy}>שמור הערכה</button>
      </form>

      <div className="card">
        <h3>רווח נטו משוער</h3>
        {opp.feasibility.status === 'incomplete' ? (
          <p className="hint">חסר מידע: {opp.feasibility.missing.map(missingFieldLabel).join(', ')}</p>
        ) : (
          <p>{formatMoney(opp.feasibility.netProfit.low, 0)} – {formatMoney(opp.feasibility.netProfit.high, 0)} (ממוצע: {formatMoney(opp.feasibility.netProfit.mid, 0)})</p>
        )}
      </div>

      {opp.status === 'published' ? (
        <div className="card">
          <h3>פורסם</h3>
          <p>נמכר {opp.salesCount} פעמים.</p>
          <p>דף המכירה: <a className="link" href={`/p/${opp.slug}`} target="_blank" rel="noreferrer">/p/{opp.slug}</a></p>
        </div>
      ) : opp.status === 'rejected' ? (
        <div className="card">
          <h3>נדחה</h3>
          <p className="hint">ההזדמנות הזו נדחתה ולא ניתן לפרסם אותה.</p>
        </div>
      ) : (
        <div className="card">
          <h3>פרסום</h3>
          <p className="hint">מצב נוכחי: {settings?.mode === 'research' ? 'מחקר בלבד — לא יפרסם' : settings?.mode === 'approve' ? 'דורש אישור' : 'אוטומטי מוגבל'}</p>
          {settings?.mode === 'approve' && (
            <button className="btn btn-ghost" onClick={onApprove} disabled={busy}>אשר פרסום</button>
          )}
          <button
            className="btn btn-primary"
            onClick={onPublish}
            disabled={busy || settings?.mode === 'research' || (settings?.mode === 'approve' && !hasPublishApproval)}
            title={
              settings?.mode === 'research'
                ? 'מצב מחקר בלבד — שום פעולה לא מתבצעת אוטומטית'
                : settings?.mode === 'approve' && !hasPublishApproval
                  ? 'צריך ללחוץ קודם על "אשר פרסום" למעלה'
                  : undefined
            }
          >
            פרסם מוצר (יצירת תשלום אמיתי)
          </button>
          <button className="btn btn-ghost" onClick={onReject} disabled={busy} style={{ marginRight: 8 }}>
            דחה הזדמנות
          </button>
          {publishResult && !publishResult.ok && <p className="form-error">{publishResult.message}</p>}
        </div>
      )}
    </div>
  );
}
