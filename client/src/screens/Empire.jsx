import { useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';
import DecisionModal from '../components/DecisionModal';
import { sfx } from '../audio';

const STAGE_LABEL = { active: null, sold: 'SOLD', bankrupt: 'BANKRUPT', closed: 'CLOSED' };

export default function Empire({ state, onOpenBusiness, onNavigate, onChanged }) {
  const { businesses, events } = state;
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

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">MY EMPIRE</div>
        <h2 style={{ fontSize: 22 }}>Your businesses</h2>
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

      <div className="stack">
        {businesses.length === 0 && (
          <div className="card center" style={{ flexDirection: 'column', gap: 10, padding: 30 }}>
            <span className="muted">You don't own anything yet.</span>
            <button className="btn btn-primary" onClick={() => onNavigate('opportunities')}>Find an opportunity</button>
          </div>
        )}
        {businesses.map((b) => (
          <div key={b.id} className="card card-tap stack" onClick={() => onOpenBusiness(b.id)}>
            <div className="row-between">
              <div style={{ fontWeight: 800 }}>{b.name}</div>
              {STAGE_LABEL[b.stage] && <span className="badge loss">{STAGE_LABEL[b.stage]}</span>}
              {b.stage === 'active' && <span className="badge money">ACTIVE</span>}
            </div>
            <div className="row" style={{ gap: 18 }}>
              <Metric label="VALUATION" value={formatMoney(b.valuation)} />
              <Metric label="EBITDA/DAY" value={formatMoney(b.latestFinancials?.ebitda ?? 0)} />
              <Metric label="STAFF" value={b.employeeCount} />
            </div>
          </div>
        ))}
      </div>

      <button className="btn btn-ghost btn-block" onClick={() => onNavigate('opportunities')}>+ OPEN ANOTHER BUSINESS</button>

      <DecisionModal event={openDecision} busy={busy} onDecide={decide} onClose={() => setOpenDecision(null)} />
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="faint" style={{ fontSize: 10.5 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{value}</div>
    </div>
  );
}
