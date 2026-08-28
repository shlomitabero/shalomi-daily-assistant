import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';

export default function Deals({ state, onOpenNegotiation, onBack }) {
  const [targets, setTargets] = useState([]);
  const [daily, setDaily] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getNegotiationTargets().then((d) => setTargets(d.targets));
    api.getDailyOpportunity(state.profile.id).then((d) => setDaily(d.opportunity));
  }, []);

  const start = async (targetId) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.startNegotiation(state.profile.id, targetId);
      onOpenNegotiation(result.offer.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">MAKE A DEAL</div>
        <h2 style={{ fontSize: 22 }}>Negotiate an acquisition</h2>
        <p className="muted" style={{ fontSize: 13.5 }}>Write your own offer — price, stake, conditions. The seller decides.</p>
      </div>

      {error && <div className="badge loss">{error}</div>}

      {daily && (
        <div className="card stack" style={{ borderColor: 'rgba(240,185,61,0.4)' }}>
          <div className="eyebrow" style={{ color: 'var(--gold)' }}>★ TODAY'S OPPORTUNITY</div>
          <div style={{ fontWeight: 800 }}>{daily.name}</div>
          <p className="muted" style={{ fontSize: 13 }}>{daily.description}</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => start(daily.id)}>NEGOTIATE NOW</button>
        </div>
      )}

      <div className="stack">
        <div className="eyebrow">ALL TARGETS</div>
        {targets.map((t) => (
          <div key={t.id} className="card stack">
            <div className="row-between">
              <div style={{ fontWeight: 800 }}>{t.name}</div>
              <span className="badge accent">{t.askStakePct}% ask</span>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>{t.description}</p>
            <div className="row-between">
              <span className="faint">Asking {formatMoney(t.askPrice)}</span>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => start(t.id)}>NEGOTIATE</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
