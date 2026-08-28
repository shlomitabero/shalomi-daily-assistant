import { formatMoney, formatCompact } from '../format';

const REP_LABELS = {
  trust: 'Trust', dealmaking: 'Dealmaking', leadership: 'Leadership',
  execution: 'Execution', innovation: 'Innovation', risk: 'Risk', social_impact: 'Social Impact',
};

export default function Profile({ state, onNavigate }) {
  const { profile, rank, businesses, loans, properties, reputation } = state;
  const activeBusinesses = businesses.filter((b) => b.stage === 'active');
  const totalEmployees = businesses.reduce((s, b) => s + b.employeeCount, 0);
  const realEstateValue = properties.reduce((s, p) => s + p.value, 0);
  const totalDebt = loans.filter((l) => l.status === 'active').reduce((s, l) => s + l.balance, 0);

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="card stack" style={{ textAlign: 'center', alignItems: 'center' }}>
        <div style={{ fontSize: 46 }}>{profile.avatar}</div>
        <h2 style={{ fontSize: 22 }}>{profile.display_name}</h2>
        <span className="badge gold">RANK {rank.rank} — {rank.title}</span>
        <div className="money positive" style={{ fontSize: 28, marginTop: 6 }}>{formatMoney(profile.netWorth)}</div>
        <div className="faint">NET WORTH · {profile.city}</div>
      </div>

      <div className="grid-2">
        <MiniStat label="COMPANIES" value={activeBusinesses.length} />
        <MiniStat label="EMPLOYEES" value={totalEmployees} />
        <MiniStat label="REAL ESTATE" value={formatCompact(realEstateValue)} />
        <MiniStat label="DEBT" value={formatCompact(totalDebt)} negative={totalDebt > 0} />
      </div>

      {reputation && (
        <div className="card stack">
          <div className="eyebrow">REPUTATION</div>
          {Object.entries(REP_LABELS).map(([key, label]) => (
            <div key={key} className="stack" style={{ gap: 4 }}>
              <div className="row-between"><span className="muted" style={{ fontSize: 12.5 }}>{label}</span><span style={{ fontSize: 12.5, fontWeight: 700 }}>{reputation[key]}</span></div>
              <div className="meter"><span style={{ width: `${reputation[key]}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      <div className="grid-2">
        <button className="btn btn-ghost" onClick={() => onNavigate('ranks')}>🏆 All 100 Ranks</button>
        <button className="btn btn-ghost" onClick={() => onNavigate('legacy')}>📜 Legacy</button>
      </div>
    </div>
  );
}

function MiniStat({ label, value, negative }) {
  return (
    <div className="card">
      <div className="eyebrow">{label}</div>
      <div style={{ fontWeight: 800, fontSize: 18, color: negative ? 'var(--loss)' : 'var(--text)' }}>{value}</div>
    </div>
  );
}
