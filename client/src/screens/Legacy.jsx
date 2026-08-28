import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCompact } from '../format';

export default function Legacy({ state, onBack }) {
  const [items, setItems] = useState([]);

  useEffect(() => { api.getLegacy(state.profile.id).then((d) => setItems(d.items)); }, []);

  return (
    <div className="scroll-area stack-lg fade-in">
      <button className="faint" style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer' }} onClick={onBack}>← Back</button>
      <div className="stack">
        <div className="eyebrow">LEGACY</div>
        <h2 style={{ fontSize: 22 }}>Your history, permanently</h2>
        <p className="muted" style={{ fontSize: 13.5 }}>Every empire, every bankruptcy, every comeback. Nothing here ever disappears.</p>
      </div>
      <div className="stack">
        {items.map((l) => (
          <div key={l.id} className="card row" style={{ alignItems: 'flex-start' }}>
            <span style={{ fontSize: 18 }}>🏅</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{l.headline}</div>
              <div className="faint" style={{ fontSize: 11 }}>
                {new Date(l.created_at).toLocaleDateString()} {l.amount != null && `· ${formatCompact(l.amount)}`}
              </div>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="faint">Your story starts now.</div>}
      </div>
    </div>
  );
}
