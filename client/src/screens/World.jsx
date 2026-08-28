import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCompact } from '../format';

const KIND_ICON = {
  sale: '💰', loss: '📉', property: '🏙️', acquisition: '🤝', bankruptcy: '⚠️',
  milestone: '🏆', takeover: '⚔️', launch: '🚀', event: '⚡',
};

const CATEGORY_LABEL = {
  net_worth: 'Net Worth', best_operator: 'Best Operator', best_investor: 'Best Investor', real_estate: 'Real Estate',
};

export default function World({ state }) {
  const [tab, setTab] = useState('feed');
  const [feed, setFeed] = useState([]);
  const [category, setCategory] = useState('net_worth');
  const [board, setBoard] = useState([]);

  useEffect(() => { if (tab === 'feed') api.getFeed().then((d) => setFeed(d.items)); }, [tab]);
  useEffect(() => { if (tab === 'leaderboard') api.getLeaderboard(category).then((d) => setBoard(d.items)); }, [tab, category]);

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">WORLD</div>
        <h2 style={{ fontSize: 22 }}>The global economy</h2>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className={`btn btn-sm ${tab === 'feed' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('feed')}>Feed</button>
        <button className={`btn btn-sm ${tab === 'leaderboard' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('leaderboard')}>Leaderboard</button>
      </div>

      {tab === 'feed' && (
        <div className="stack">
          {feed.map((f) => (
            <div key={f.id} className="card row" style={{ alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18 }}>{KIND_ICON[f.kind] ?? '📰'}</span>
              <div>
                <div style={{ fontSize: 13.5 }}>{f.headline}</div>
                <div className="faint" style={{ fontSize: 11 }}>{new Date(f.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
          {feed.length === 0 && <div className="faint">Nothing yet. Go make some noise.</div>}
        </div>
      )}

      {tab === 'leaderboard' && (
        <div className="stack">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <div className="card stack" style={{ gap: 4 }}>
            {board.map((row) => (
              <div key={row.profileId} className="row-between" style={{
                padding: '8px 4px', borderRadius: 8,
                background: row.profileId === state.profile.id ? 'var(--surface-2)' : 'transparent',
              }}>
                <div className="row" style={{ gap: 10 }}>
                  <span className="faint" style={{ width: 22 }}>#{row.position}</span>
                  <span>{row.avatar}</span>
                  <span style={{ fontWeight: row.profileId === state.profile.id ? 800 : 500 }}>{row.displayName}</span>
                </div>
                <span className="money positive" style={{ fontSize: 13.5 }}>{formatCompact(row.value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
