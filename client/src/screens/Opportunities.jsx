import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';

export default function Opportunities({ state, onBought, onBack }) {
  const [opportunities, setOpportunities] = useState([]);
  const [locked, setLocked] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getOpportunities(state.profile.id).then((d) => { setOpportunities(d.opportunities); setLocked(d.locked ?? []); });
  }, []);

  const buy = async (opp) => {
    setBusyId(opp.id);
    setError(null);
    try {
      const result = await api.buyBusiness(state.profile.id, opp.id);
      onBought(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <button className="faint" style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer' }} onClick={onBack}>← Back</button>
        <div className="eyebrow">OPPORTUNITIES</div>
        <h2 style={{ fontSize: 22 }}>What will you build?</h2>
        <p className="muted">Cash on hand: <span style={{ color: 'var(--text)', fontWeight: 700 }}>{formatMoney(state.profile.cash)}</span></p>
      </div>

      {error && <div className="badge loss">{error}</div>}

      <div className="stack">
        {opportunities.map((opp) => (
          <div key={opp.id} className="card stack">
            <div className="row-between">
              <div style={{ fontWeight: 800, fontSize: 16 }}>{opp.name}</div>
              <span className="badge accent">{opp.risk} risk</span>
            </div>
            <p className="muted" style={{ fontSize: 13.5 }}>{opp.description}</p>
            <div className="row" style={{ gap: 18 }}>
              <div><div className="faint" style={{ fontSize: 11 }}>COST</div><div style={{ fontWeight: 700 }}>{formatMoney(opp.cost)}</div></div>
              <div><div className="faint" style={{ fontSize: 11 }}>POTENTIAL</div><div style={{ fontWeight: 700 }}>{opp.potential}</div></div>
            </div>
            <button
              className="btn btn-primary btn-block"
              disabled={busyId === opp.id || state.profile.cash < opp.cost}
              onClick={() => buy(opp)}
            >
              {state.profile.cash < opp.cost ? 'NOT ENOUGH CASH' : busyId === opp.id ? 'BUYING…' : `BUY FOR ${formatMoney(opp.cost)}`}
            </button>
          </div>
        ))}
      </div>

      {locked.length > 0 && (
        <div className="stack">
          <div className="eyebrow">UNLOCKS AS YOU RANK UP</div>
          {locked.map((opp) => (
            <div key={opp.id} className="card stack" style={{ opacity: 0.55 }}>
              <div className="row-between">
                <div style={{ fontWeight: 800, fontSize: 15 }}>🔒 {opp.name}</div>
                <span className="badge">Rank {opp.minRank}+</span>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>{opp.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
