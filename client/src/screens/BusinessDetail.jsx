import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';

const ROLES = ['Manager', 'Cook', 'Sales Rep', 'Technician', 'Marketer'];

export default function BusinessDetail({ profileId, bizId, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [hiring, setHiring] = useState(false);
  const [hireForm, setHireForm] = useState({ role: ROLES[0], name: '', salaryMonthly: 1800, skill: 50 });

  const load = () => api.getBusiness(profileId, bizId).then(setData);
  useEffect(() => { load(); }, [bizId]);

  if (!data) return <div className="scroll-area center"><div className="spinner" /></div>;
  const { business, financials, employees } = data;
  const latest = financials[financials.length - 1];
  const activeEmployees = employees.filter((e) => !e.terminated_at);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scroll-area stack-lg fade-in">
      <button className="faint" style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer' }} onClick={onBack}>← Back</button>

      <div className="stack">
        <div className="eyebrow">{business.industry.replace('_', ' ').toUpperCase()} · {business.city}</div>
        <h2 style={{ fontSize: 22 }}>{business.name}</h2>
        <div className="row" style={{ gap: 10 }}>
          <span className="badge accent">{business.ownership_pct}% owned</span>
          <span className="badge gold">Quality {business.quality}</span>
        </div>
      </div>

      {error && <div className="badge loss">{error}</div>}

      {latest && (
        <div className="card stack">
          <div className="eyebrow">LATEST DAY P&L</div>
          <PLRow label="Revenue" value={latest.revenue} />
          <PLRow label="COGS" value={-latest.cogs} />
          <PLRow label="Payroll" value={-latest.payroll} />
          <PLRow label="Rent" value={-latest.rent} />
          <PLRow label="Marketing" value={-latest.marketing} />
          <PLRow label="Other" value={-latest.other_expenses} />
          <hr className="divider" />
          <PLRow label="EBITDA" value={latest.ebitda} bold />
          <div className="faint">Customer score: {latest.customer_score}/100</div>
        </div>
      )}

      {business.stage === 'active' && (
        <div className="grid-2">
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.upgradeMarketing(profileId, bizId))}>
            📣 Marketing Lv.{business.marketing_level} → {business.marketing_level + 1}
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => {
            if (confirm(`Sell ${business.name}? This can't be undone.`)) run(() => api.sellBusiness(profileId, bizId));
          }}>💰 Sell Business</button>
        </div>
      )}

      <div className="stack">
        <div className="row-between">
          <div className="eyebrow">STAFF ({activeEmployees.length})</div>
          {business.stage === 'active' && <button className="btn btn-sm btn-ghost" onClick={() => setHiring((h) => !h)}>{hiring ? 'Cancel' : '+ Hire'}</button>}
        </div>

        {hiring && (
          <div className="card stack">
            <select value={hireForm.role} onChange={(e) => setHireForm({ ...hireForm, role: e.target.value })}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
            <input placeholder="Employee name" value={hireForm.name} onChange={(e) => setHireForm({ ...hireForm, name: e.target.value })} />
            <div>
              <label>Monthly salary: {formatMoney(hireForm.salaryMonthly)}</label>
              <input type="range" min={800} max={8000} step={100} value={hireForm.salaryMonthly}
                onChange={(e) => setHireForm({ ...hireForm, salaryMonthly: Number(e.target.value) })} />
            </div>
            <button className="btn btn-primary btn-block" disabled={!hireForm.name.trim() || busy}
              onClick={() => run(async () => {
                await api.hire(profileId, bizId, hireForm);
                setHiring(false);
                setHireForm({ ...hireForm, name: '' });
              })}
            >HIRE — $300 signing cost</button>
          </div>
        )}

        {activeEmployees.map((e) => (
          <div key={e.id} className="card row-between">
            <div>
              <div style={{ fontWeight: 700 }}>{e.name}</div>
              <div className="faint">{e.role} · {formatMoney(e.salary_monthly)}/mo · skill {e.skill}</div>
            </div>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(() => api.fire(profileId, bizId, e.id))}>Fire</button>
          </div>
        ))}
        {activeEmployees.length === 0 && !hiring && <div className="faint">No employees yet.</div>}
      </div>
    </div>
  );
}

function PLRow({ label, value, bold }) {
  const sign = value > 0 ? '+' : '';
  const tone = value > 0 ? 'positive' : value < 0 ? 'negative' : '';
  return (
    <div className="row-between">
      <span className={bold ? '' : 'muted'} style={{ fontSize: bold ? 14 : 13.5, fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span className={`money ${tone}`} style={{ fontSize: bold ? 16 : 13.5 }}>
        {sign}{formatMoney(value)}
      </span>
    </div>
  );
}
