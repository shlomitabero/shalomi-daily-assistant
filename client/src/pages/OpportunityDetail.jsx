import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';

export default function OpportunityDetail() {
  const { id } = useParams();
  const [opp, setOpp] = useState(null);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ low: '', mid: '', high: '', aiUsage: '', paymentProcessing: '', riskLevel: 'medium', dataQuality: 'unknown', priceUSD: 9 });
  const [error, setError] = useState('');
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
    });
    api.getSettings().then((r) => setSettings(r.settings));
  }

  useEffect(refresh, [id]);

  async function onSave(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.updateOpportunity(id, {
        revenueEstimate: form.low !== '' && form.high !== '' ? { low: Number(form.low), mid: form.mid !== '' ? Number(form.mid) : undefined, high: Number(form.high) } : null,
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

  if (!opp) return <div className="page-loading">טוען…</div>;
  const draft = opp.productDraft;

  return (
    <div className="page">
      <Link className="link" to="/opportunities">← חזרה לכל ההזדמנויות</Link>
      <h1>{opp.title}</h1>
      <p className="hint">מקור: {opp.source} · סטטוס: {opp.status}</p>

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

      <form className="card form" onSubmit={onSave}>
        <h3>הערכת רווח (על אחריותך — לא נתון מאומת)</h3>
        <div className="field-row">
          <label>הכנסה נמוכה (₪)<input type="number" value={form.low} onChange={(e) => setForm({ ...form, low: e.target.value })} /></label>
          <label>הכנסה ממוצעת (₪)<input type="number" value={form.mid} onChange={(e) => setForm({ ...form, mid: e.target.value })} /></label>
          <label>הכנסה גבוהה (₪)<input type="number" value={form.high} onChange={(e) => setForm({ ...form, high: e.target.value })} /></label>
        </div>
        <div className="field-row">
          <label>עלות AI ($)<input type="number" step="0.01" value={form.aiUsage} onChange={(e) => setForm({ ...form, aiUsage: e.target.value })} /></label>
          <label>עמלת סליקה ($)<input type="number" step="0.01" value={form.paymentProcessing} onChange={(e) => setForm({ ...form, paymentProcessing: e.target.value })} /></label>
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
        <label>מחיר מוצר ($)<input type="number" value={form.priceUSD} onChange={(e) => setForm({ ...form, priceUSD: e.target.value })} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-ghost" type="submit" disabled={busy}>שמור הערכה</button>
      </form>

      <div className="card">
        <h3>רווח נטו משוער</h3>
        {opp.feasibility.status === 'incomplete' ? (
          <p className="hint">חסר מידע: {opp.feasibility.missing.join(', ')}</p>
        ) : (
          <p>₪{opp.feasibility.netProfit.low.toFixed(0)} – ₪{opp.feasibility.netProfit.high.toFixed(0)} (ממוצע: ₪{opp.feasibility.netProfit.mid.toFixed(0)})</p>
        )}
      </div>

      {opp.status === 'published' ? (
        <div className="card">
          <h3>פורסם</h3>
          <p>נמכר {opp.salesCount} פעמים.</p>
          <p>דף המכירה: <a className="link" href={`/p/${opp.slug}`} target="_blank" rel="noreferrer">/p/{opp.slug}</a></p>
        </div>
      ) : (
        <div className="card">
          <h3>פרסום</h3>
          <p className="hint">מצב נוכחי: {settings?.mode === 'research' ? 'מחקר בלבד — לא יפרסם' : settings?.mode === 'approve' ? 'דורש אישור' : 'אוטומטי מוגבל'}</p>
          {settings?.mode === 'approve' && (
            <button className="btn btn-ghost" onClick={onApprove} disabled={busy}>אשר פרסום</button>
          )}
          <button className="btn btn-primary" onClick={onPublish} disabled={busy}>פרסם מוצר (יצירת תשלום אמיתי)</button>
          {publishResult && !publishResult.ok && <p className="form-error">{publishResult.message}</p>}
        </div>
      )}
    </div>
  );
}
