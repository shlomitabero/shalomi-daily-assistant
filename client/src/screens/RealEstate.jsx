import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';

export default function RealEstate({ state, onChanged }) {
  const [properties, setProperties] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = () => api.getProperties().then((d) => setProperties(d.properties));
  useEffect(() => { load(); }, []);

  const buy = async (p) => {
    setBusyId(p.id);
    setError(null);
    try {
      await api.buyProperty(state.profile.id, p.id);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const sell = async (p) => {
    setBusyId(p.id);
    setError(null);
    try {
      await api.sellProperty(state.profile.id, p.id);
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
        <div className="eyebrow">REAL ESTATE</div>
        <h2 style={{ fontSize: 22 }}>Own the city</h2>
        <p className="muted" style={{ fontSize: 13.5 }}>Landmark properties are scarce — only one player can hold each.</p>
      </div>

      {error && <div className="badge loss">{error}</div>}

      <div className="stack">
        {properties.map((p) => {
          const mine = p.owner_id === state.profile.id;
          const takenByOther = p.owner_id && !mine;
          return (
            <div key={p.id} className="card stack" style={p.is_scarce ? { borderColor: 'rgba(240,185,61,0.4)' } : undefined}>
              <div className="row-between">
                <div style={{ fontWeight: 800 }}>{p.neighborhood}</div>
                {p.is_scarce && <span className="badge gold">LANDMARK</span>}
              </div>
              <div className="faint" style={{ textTransform: 'capitalize' }}>{p.kind} · {p.city}</div>
              <div className="row" style={{ gap: 18 }}>
                <div><div className="faint" style={{ fontSize: 10.5 }}>VALUE</div><div style={{ fontWeight: 700 }}>{formatMoney(p.value)}</div></div>
                <div><div className="faint" style={{ fontSize: 10.5 }}>INCOME/MO</div><div style={{ fontWeight: 700 }}>{formatMoney(p.monthly_income)}</div></div>
              </div>
              {mine ? (
                <button className="btn btn-danger" disabled={busyId === p.id} onClick={() => sell(p)}>SELL</button>
              ) : takenByOther ? (
                <button className="btn btn-ghost" disabled>OWNED BY ANOTHER PLAYER</button>
              ) : (
                <button className="btn btn-primary" disabled={busyId === p.id || state.profile.cash < p.value} onClick={() => buy(p)}>
                  {state.profile.cash < p.value ? 'NOT ENOUGH CASH' : `BUY FOR ${formatMoney(p.value)}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
