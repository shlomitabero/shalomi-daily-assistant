import { formatMoney, formatCompact } from '../format';

export default function Home({ state, onNavigate, onAdvanceDay, advancing }) {
  const { profile, rank, nextRank, businesses, alerts } = state;
  const activeBusinesses = businesses.filter((b) => b.stage === 'active');
  const todaysProfit = activeBusinesses.reduce((s, b) => s + (b.latestFinancials?.ebitda ?? 0), 0);
  const progress = nextRank
    ? Math.min(100, Math.max(0, ((profile.netWorth - rank.netWorthThreshold) / (nextRank.netWorthThreshold - rank.netWorthThreshold)) * 100))
    : 100;

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
    <div className="card card-tap" onClick={onClick}>
      <div className="eyebrow">{label}</div>
      <div className={`money ${accent === 'gold' ? '' : ''}`} style={{ fontSize: 22, color: accent === 'gold' ? 'var(--gold)' : 'var(--text)' }}>{value}</div>
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
