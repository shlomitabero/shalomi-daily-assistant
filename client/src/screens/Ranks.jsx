import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatCompact } from '../format';

export default function Ranks({ state, onBack }) {
  const [ranks, setRanks] = useState([]);
  const currentRef = useRef(null);

  useEffect(() => { api.getRanks().then((d) => setRanks(d.ranks)); }, []);
  useEffect(() => {
    if (ranks.length) setTimeout(() => currentRef.current?.scrollIntoView({ block: 'center' }), 50);
  }, [ranks]);

  return (
    <div className="scroll-area stack-lg fade-in">
      <button className="faint" style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer' }} onClick={onBack}>← Back</button>
      <div className="stack">
        <div className="eyebrow">PROGRESSION</div>
        <h2 style={{ fontSize: 22 }}>All 100 ranks</h2>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        {ranks.map((r) => {
          const current = r.rank === state.rank.rank;
          const reached = state.profile.netWorth >= r.netWorthThreshold;
          return (
            <div key={r.rank} ref={current ? currentRef : null} className="card row-between" style={{
              padding: '10px 14px',
              borderColor: current ? 'var(--gold)' : 'var(--border)',
              opacity: reached ? 1 : 0.55,
            }}>
              <div className="row" style={{ gap: 10 }}>
                <span className="faint" style={{ width: 28 }}>#{r.rank}</span>
                <div>
                  <div style={{ fontWeight: current ? 800 : 600, fontSize: 13.5 }}>{r.title}</div>
                  <div className="faint" style={{ fontSize: 10.5 }}>{r.tier}</div>
                </div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{formatCompact(r.netWorthThreshold)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
