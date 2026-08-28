import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';

export default function Invest({ state, onChanged }) {
  const [targets, setTargets] = useState([]);
  const [stakeById, setStakeById] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = () => api.getInvestTargets(state.profile.id).then((d) => setTargets(d.targets));
  useEffect(() => { load(); }, []);

  const invest = async (t) => {
    const stakePct = Math.min(t.availablePct, Math.max(1, Number(stakeById[t.businessId] ?? Math.min(5, t.availablePct))));
    setBusyId(t.businessId);
    setError(null);
    setNotice(null);
    try {
      await api.invest(state.profile.id, t.businessId, stakePct);
      setNotice(`Took a ${stakePct}% stake in ${t.name}.`);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">INVEST</div>
        <h2 style={{ fontSize: 22 }}>Take a stake in someone else's company</h2>
        <p className="muted" style={{ fontSize: 13.5 }}>Minority stakes only — investing never buys control (max 40%).</p>
      </div>

      {error && <div className="badge loss">{error}</div>}
      {notice && <div className="badge money">{notice}</div>}

      <div className="stack">
        {targets.map((t) => {
          const stakePct = Math.min(t.availablePct, Math.max(1, Number(stakeById[t.businessId] ?? Math.min(5, t.availablePct))));
          const cost = Math.round((t.fullValuation * stakePct) / 100);
          return (
            <div key={t.businessId} className="card stack">
              <div className="row-between">
                <div style={{ fontWeight: 800 }}>{t.name}</div>
                <span className="badge accent">{t.industry.replace('_', ' ')}</span>
              </div>
              <div className="faint">Owned by {t.ownerName} · Valuation {formatMoney(t.fullValuation)}</div>
              <div>
                <label>Stake: {stakePct}% (up to {t.availablePct}% available)</label>
                <input type="range" min={1} max={t.availablePct} value={stakePct}
                  onChange={(e) => setStakeById({ ...stakeById, [t.businessId]: Number(e.target.value) })} />
              </div>
              <div className="row-between">
                <span className="faint">Cost</span>
                <span style={{ fontWeight: 700 }}>{formatMoney(cost)}</span>
              </div>
              <button className="btn btn-primary btn-block" disabled={busyId === t.businessId || state.profile.cash < cost}
                onClick={() => invest(t)}>
                {state.profile.cash < cost ? 'NOT ENOUGH CASH' : busyId === t.businessId ? 'INVESTING…' : `INVEST ${formatMoney(cost)}`}
              </button>
            </div>
          );
        })}
        {targets.length === 0 && <div className="faint">No investable companies right now — check back after the world moves.</div>}
      </div>
    </div>
  );
}
