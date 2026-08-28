import { formatMoney } from '../format';

const STAGE_LABEL = { active: null, sold: 'SOLD', bankrupt: 'BANKRUPT', closed: 'CLOSED' };

export default function Empire({ state, onOpenBusiness, onNavigate }) {
  const { businesses, events } = state;

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">MY EMPIRE</div>
        <h2 style={{ fontSize: 22 }}>Your businesses</h2>
      </div>

      {events.length > 0 && (
        <div className="stack">
          <div className="eyebrow">ALERTS</div>
          {events.map((e) => (
            <div key={e.id} className="card" style={{ borderColor: 'rgba(240,185,61,0.35)' }}>
              <div className="row-between">
                <span style={{ fontSize: 13.5 }}>⚡ {e.description}</span>
              </div>
            </div>
          ))}
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
