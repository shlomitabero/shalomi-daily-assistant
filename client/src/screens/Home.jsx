import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney, formatCompact } from '../format';
import { DISTRICTS } from '../world';
import PlayerCard from '../components/PlayerCard';
import CityLife from '../components/CityLife';

export default function Home({ state, onNavigate, onAdvanceDay, advancing }) {
  const { profile, rank, nextRank, businesses, alerts } = state;
  const activeBusinesses = businesses.filter((b) => b.stage === 'active');
  const todaysProfit = activeBusinesses.reduce((s, b) => s + (b.latestFinancials?.ebitda ?? 0), 0);
  const progress = nextRank
    ? Math.min(100, Math.max(0, ((profile.netWorth - rank.netWorthThreshold) / (nextRank.netWorthThreshold - rank.netWorthThreshold)) * 100))
    : 100;

  const [dailyOpportunity, setDailyOpportunity] = useState(null);
  const [rival, setRival] = useState(null);
  const [hotProperty, setHotProperty] = useState(null);
  const [viewingPlayer, setViewingPlayer] = useState(null);

  useEffect(() => {
    api.getDailyOpportunity(profile.id).then((d) => setDailyOpportunity(d.opportunity)).catch(() => {});
    api.getRival(profile.id).then((d) => setRival(d.rival)).catch(() => {});
    api.getProperties().then((d) => setHotProperty(d.properties.find((p) => !p.owner_id) ?? null)).catch(() => {});
  }, [profile.id]);

  const districtsWithMe = DISTRICTS.map((d) => ({
    ...d,
    presence: activeBusinesses.filter((b) => d.industries.includes(b.industry)).length,
  }));

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="card stack">
        <div className="row-between">
          <span className="eyebrow">NET WORTH</span>
          <span className="badge accent">{profile.city}</span>
        </div>
        <div className="money positive" style={{ fontSize: 34 }}>{formatMoney(profile.netWorth)}</div>
        <div className="row" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="faint">TODAY</span>
            <span className={`money ${todaysProfit >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: 14 }}>
              {todaysProfit >= 0 ? '+' : ''}{formatMoney(todaysProfit)}
            </span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="faint">CASH</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{formatMoney(profile.cash)}</span>
          </div>
        </div>
      </div>

      <div className="card stack" onClick={() => onNavigate('ranks')} role="button">
        <div className="row-between">
          <div>
            <div className="eyebrow">RANK {rank.rank} · {rank.tier}</div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>{rank.title}</div>
          </div>
          {nextRank && <span className="badge gold">NEXT: {nextRank.title}</span>}
        </div>
        <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
        {nextRank && <div className="faint">{formatCompact(Math.max(0, nextRank.netWorthThreshold - profile.netWorth))} to rank {nextRank.rank}</div>}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <div className="row-between">
          <div className="eyebrow">YOUR CITY</div>
          <button className="faint" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }} onClick={() => onNavigate('world')}>Open map →</button>
        </div>
        <div className="row" style={{ gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
          {districtsWithMe.map((d) => (
            <div key={d.id} onClick={() => onNavigate('world')} style={{
              position: 'relative', flexShrink: 0, width: 78, padding: '10px 8px', borderRadius: 12, textAlign: 'center',
              background: `linear-gradient(155deg, ${d.color}cc, ${d.color}44)`, cursor: 'pointer', color: 'white', overflow: 'hidden',
            }}>
              <CityLife seed={d.id.length * 13 + d.id.charCodeAt(0)} count={1} compact />
              <div style={{ fontSize: 20, position: 'relative' }}>{d.icon}</div>
              <div style={{ fontSize: 10, fontWeight: 700, marginTop: 4, lineHeight: 1.2, position: 'relative' }}>{d.name}</div>
              {d.presence > 0 && <div style={{ fontSize: 9.5, opacity: 0.85, marginTop: 2 }}>{d.presence} owned</div>}
            </div>
          ))}
        </div>
      </div>

      {(dailyOpportunity || rival || hotProperty) && (
        <div className="stack">
          <div className="eyebrow">URGENT</div>
          {dailyOpportunity && (
            <UrgentCard icon="💼" label="DEAL" sub={dailyOpportunity.name} onClick={() => onNavigate('deals')} />
          )}
          {rival && (
            <UrgentCard
              icon="⚔️"
              label={rival.youAreAhead ? 'RIVAL — YOU LEAD' : 'RIVAL — CLOSING GAP'}
              sub={`${rival.displayName} · ${formatCompact(rival.netWorth)} net worth`}
              onClick={() => setViewingPlayer(rival.profileId)}
            />
          )}
          {hotProperty && (
            <UrgentCard icon="🏙️" label="PROPERTY" sub={`${hotProperty.neighborhood} · ${formatMoney(hotProperty.value)}`} onClick={() => onNavigate('estate')} />
          )}
        </div>
      )}

      <PlayerCard profileId={viewingPlayer} onClose={() => setViewingPlayer(null)} />

      <div className="grid-2">
        <StatMini label="BUSINESSES" value={activeBusinesses.length} onClick={() => onNavigate('empire')} />
        <StatMini label="ALERTS" value={alerts} accent={alerts > 0 ? 'gold' : null} onClick={() => onNavigate('empire')} />
      </div>

      <button className="btn btn-money btn-block" disabled={advancing} onClick={onAdvanceDay}>
        {advancing ? 'RUNNING THE DAY…' : '▶ RUN MY BUSINESSES (ADVANCE DAY)'}
      </button>

      <div className="stack">
        <div className="eyebrow">TAKE ACTION</div>
        <div className="action-grid">
          <ActionCard icon="🚀" label="New Opportunity" sub="Open a business" onClick={() => onNavigate('opportunities')} />
          <ActionCard icon="🤝" label="Make a Deal" sub="Negotiate an acquisition" onClick={() => onNavigate('deals')} />
          <ActionCard icon="📈" label="Invest" sub="Take a minority stake" onClick={() => onNavigate('invest')} />
          <ActionCard icon="🏙️" label="Real Estate" sub="Buy and develop property" onClick={() => onNavigate('estate')} />
          <ActionCard icon="🏦" label="Get a Loan" sub="Leverage your empire" onClick={() => onNavigate('loans')} />
          <ActionCard icon="🌍" label="World Feed" sub="See who's winning" onClick={() => onNavigate('world')} />
          <ActionCard icon="👤" label="My Empire" sub="Profile & legacy" onClick={() => onNavigate('profile')} />
        </div>
      </div>
    </div>
  );
}

function StatMini({ label, value, accent, onClick }) {
  return (
    <div className={`card card-tap ${accent === 'gold' && value > 0 ? 'pulse-attention' : ''}`} onClick={onClick}>
      <div className="eyebrow">{label}</div>
      <div style={{ fontSize: 22, color: accent === 'gold' ? 'var(--gold)' : 'var(--text)' }}>{value}</div>
    </div>
  );
}

function ActionCard({ icon, label, sub, onClick }) {
  return (
    <div className="action-card" onClick={onClick}>
      <span className="icon">{icon}</span>
      <span className="label">{label}</span>
      <span className="sub">{sub}</span>
    </div>
  );
}

function UrgentCard({ icon, label, sub, onClick }) {
  return (
    <div className="urgent-card" onClick={onClick}>
      <span className="urgent-icon">{icon}</span>
      <div>
        <div className="urgent-label">{label}</div>
        <div className="urgent-sub">{sub}</div>
      </div>
    </div>
  );
}
