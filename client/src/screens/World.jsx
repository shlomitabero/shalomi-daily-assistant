import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCompact } from '../format';
import { DISTRICTS } from '../world';
import PlayerCard from '../components/PlayerCard';

const KIND_ICON = {
  sale: '💰', loss: '📉', property: '🏙️', acquisition: '🤝', bankruptcy: '⚠️',
  milestone: '🏆', takeover: '⚔️', launch: '🚀', event: '⚡', investment: '📈',
};

const CATEGORY_LABEL = {
  net_worth: 'Net Worth', best_operator: 'Best Operator', best_investor: 'Best Investor', real_estate: 'Real Estate',
};

export default function World({ state, onNavigate }) {
  const [tab, setTab] = useState('city');
  const [feed, setFeed] = useState([]);
  const [category, setCategory] = useState('net_worth');
  const [board, setBoard] = useState([]);
  const [opportunities, setOpportunities] = useState({ opportunities: [], locked: [] });
  const [properties, setProperties] = useState([]);
  const [viewingPlayer, setViewingPlayer] = useState(null);

  useEffect(() => { if (tab === 'feed') api.getFeed().then((d) => setFeed(d.items)); }, [tab]);
  useEffect(() => { if (tab === 'leaderboard') api.getLeaderboard(category).then((d) => setBoard(d.items)); }, [tab, category]);
  useEffect(() => {
    if (tab !== 'city') return;
    api.getOpportunities(state.profile.id).then(setOpportunities);
    api.getProperties().then((d) => setProperties(d.properties));
  }, [tab]);

  const activeBusinesses = state.businesses.filter((b) => b.stage === 'active');

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">WORLD</div>
        <h2 style={{ fontSize: 22 }}>{state.profile.city}</h2>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className={`btn btn-sm ${tab === 'city' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('city')}>City</button>
        <button className={`btn btn-sm ${tab === 'feed' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('feed')}>Feed</button>
        <button className={`btn btn-sm ${tab === 'leaderboard' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('leaderboard')}>Leaderboard</button>
      </div>

      {tab === 'city' && (
        <div className="stack">
          <p className="muted" style={{ fontSize: 13 }}>Tap a district to see what's there.</p>
          <div className="district-grid">
            {DISTRICTS.map((d) => {
              const mine = activeBusinesses.filter((b) => d.industries.includes(b.industry)).length;
              const myProperties = properties.filter((p) => p.owner_id === state.profile.id && d.propertyKinds?.includes(p.kind)).length;
              const hasHotOpportunity = opportunities.opportunities.some((o) => d.industries.includes(o.industry))
                || properties.some((p) => !p.owner_id && d.propertyKinds?.includes(p.kind));
              const presence = mine + myProperties;
              return (
                <div
                  key={d.id}
                  className="district-tile"
                  style={{ background: `linear-gradient(155deg, ${d.color}dd, ${d.color}55)` }}
                  onClick={() => onNavigate?.(d.industries.length ? 'opportunities' : 'estate')}
                >
                  {hasHotOpportunity && <span className="hot-badge">🔥 HOT</span>}
                  <span className="district-icon">{d.icon}</span>
                  <div>
                    <div className="district-name">{d.name}</div>
                    <div className="district-meta">{presence > 0 ? `You own ${presence} here` : 'No presence yet'}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'feed' && (
        <div className="stack">
          {feed.map((f) => (
            <div key={f.id} className={`card row ${f.profile_id ? 'card-tap' : ''}`} style={{ alignItems: 'flex-start' }}
              onClick={() => f.profile_id && setViewingPlayer(f.profile_id)}>
              <span style={{ fontSize: 18 }}>{KIND_ICON[f.kind] ?? '📰'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5 }}>{f.headline}</div>
                <div className="row-between" style={{ marginTop: 3 }}>
                  <div className="faint" style={{ fontSize: 11 }}>{new Date(f.created_at).toLocaleString()}</div>
                  {f.profile_id && <span className="faint" style={{ fontSize: 11, color: 'var(--accent-2)' }}>VIEW PLAYER →</span>}
                </div>
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
                padding: '8px 4px', borderRadius: 8, cursor: 'pointer',
                background: row.profileId === state.profile.id ? 'var(--surface-2)' : 'transparent',
              }} onClick={() => setViewingPlayer(row.profileId)}>
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

      <PlayerCard profileId={viewingPlayer} onClose={() => setViewingPlayer(null)} />
    </div>
  );
}
