import { useState } from 'react';
import { api } from '../api';
import { formatMoney, formatCompact } from '../format';
import DecisionModal from '../components/DecisionModal';
import { sfx } from '../audio';
import { businessTier } from '../world';

const STAGE_LABEL = { active: null, sold: 'SOLD', bankrupt: 'BANKRUPT', closed: 'CLOSED' };

function industryLabel(industry) {
  return industry.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Empire({ state, onOpenBusiness, onNavigate, onChanged }) {
  const { businesses, events, profile, loans, properties } = state;
  const [openDecision, setOpenDecision] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resultText, setResultText] = useState(null);

  const dismiss = async (event) => {
    await api.dismissEvent(state.profile.id, event.id);
    onChanged();
  };

  const decide = async (payload) => {
    setBusy(true);
    try {
      const result = await api.decideEvent(state.profile.id, openDecision.id, payload);
      setResultText(result.resultText);
      sfx.dealClosed();
      setOpenDecision(null);
      onChanged();
    } catch (e) {
      setResultText(e.message);
    } finally {
      setBusy(false);
    }
  };

  const active = businesses.filter((b) => b.stage === 'active');
  const inactive = businesses.filter((b) => b.stage !== 'active');
  const byIndustry = {};
  for (const b of active) (byIndustry[b.industry] ??= []).push(b);

  const totalDebt = loans.filter((l) => l.status === 'active').reduce((s, l) => s + l.balance, 0);
  const realEstateValue = properties.reduce((s, p) => s + p.value, 0);

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">MY EMPIRE</div>
        <h2 style={{ fontSize: 22 }}>Your businesses</h2>
      </div>

      <div className="grid-2">
        <Metric label="CASH" value={formatCompact(profile.cash)} />
        <Metric label="DEBT" value={formatCompact(totalDebt)} negative={totalDebt > 0} />
        <Metric label="REAL ESTATE" value={formatCompact(realEstateValue)} />
        <Metric label="NET WORTH" value={formatCompact(profile.netWorth)} positive />
      </div>

      {resultText && <div className="badge money">{resultText}</div>}

      {events.length > 0 && (
        <div className="stack">
          <div className="eyebrow">ALERTS</div>
          {events.map((e) => {
            const isDecision = Boolean(e.impact?.decisionId);
            return (
              <div key={e.id} className="card row-between" style={{ borderColor: 'rgba(240,185,61,0.35)' }}>
                <span style={{ fontSize: 13.5, flex: 1, paddingRight: 10 }}>⚡ {e.description}</span>
                {isDecision ? (
                  <button className="btn btn-sm btn-primary" onClick={() => setOpenDecision(e)}>Decide</button>
                ) : (
                  <button className="btn btn-sm btn-ghost" onClick={() => dismiss(e)}>OK</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {active.length === 0 && inactive.length === 0 && (
        <div className="card center" style={{ flexDirection: 'column', gap: 10, padding: 30 }}>
          <span className="muted">You don't own anything yet.</span>
          <button className="btn btn-primary" onClick={() => onNavigate('opportunities')}>Find an opportunity</button>
        </div>
      )}

      {Object.entries(byIndustry).map(([industry, list]) => {
        const monthlyRevenue = list.reduce((s, b) => s + (b.latestFinancials?.revenue ?? 0) * 30, 0);
        return (
          <div key={industry} className="stack">
            <div className="row-between">
              <div className="eyebrow">{industryLabel(industry)} · {list.length} {list.length === 1 ? 'business' : 'businesses'}</div>
              {monthlyRevenue > 0 && <span className="faint" style={{ fontSize: 11 }}>{formatCompact(monthlyRevenue)}/mo</span>}
            </div>
            {list.map((b) => {
              const tier = businessTier(b.valuation);
              return (
                <div key={b.id} className="card card-tap stack" onClick={() => onOpenBusiness(b.id)}>
                  <div className="row-between">
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontSize: 20 }}>{tier.icon}</span>
                      <div>
                        <div style={{ fontWeight: 800 }}>{b.name}</div>
                        <div className="faint" style={{ fontSize: 10.5 }}>{tier.label}</div>
                      </div>
                    </div>
                    <span className="badge money">ACTIVE</span>
                  </div>
                  <div className="row" style={{ gap: 18 }}>
                    <Metric label="VALUATION" value={formatMoney(b.valuation)} inline />
                    <Metric label="EBITDA/DAY" value={formatMoney(b.latestFinancials?.ebitda ?? 0)} inline />
                    <Metric label="STAFF" value={b.employeeCount} inline />
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {inactive.length > 0 && (
        <div className="stack">
          <div className="eyebrow">PAST BUSINESSES</div>
          {inactive.map((b) => (
            <div key={b.id} className="card row-between" style={{ opacity: 0.6 }}>
              <span>{b.name}</span>
              <span className="badge loss">{STAGE_LABEL[b.stage]}</span>
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-ghost btn-block" onClick={() => onNavigate('opportunities')}>+ OPEN ANOTHER BUSINESS</button>

      <DecisionModal event={openDecision} busy={busy} onDecide={decide} onClose={() => setOpenDecision(null)} />
    </div>
  );
}

function Metric({ label, value, inline, negative, positive }) {
  const tone = negative ? 'var(--loss)' : positive ? 'var(--money)' : 'var(--text)';
  if (inline) {
    return (
      <div>
        <div className="faint" style={{ fontSize: 10.5 }}>{label}</div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{value}</div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="eyebrow">{label}</div>
      <div style={{ fontWeight: 800, fontSize: 18, color: tone }}>{value}</div>
    </div>
  );
}
