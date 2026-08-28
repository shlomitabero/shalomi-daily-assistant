import { useRef, useState } from 'react';
import { formatMoney, formatCompact } from '../format';
import { statusForTier } from '../world';
import { renderShareCard } from '../shareCard';

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
  const status = statusForTier(rank.tier);

  const [shareUrl, setShareUrl] = useState(null);
  const canvasRef = useRef(null);

  const openShare = () => {
    const canvas = canvasRef.current ?? document.createElement('canvas');
    canvasRef.current = canvas;
    const url = renderShareCard(canvas, { profile, rank, businessCount: activeBusinesses.length, employeeCount: totalEmployees });
    setShareUrl(url);
  };

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="card stack" style={{ textAlign: 'center', alignItems: 'center' }}>
        <div style={{ fontSize: 46 }}>{profile.avatar}</div>
        <h2 style={{ fontSize: 22 }}>{profile.display_name}</h2>
        <span className="badge gold">RANK {rank.rank} — {rank.title}</span>
        {profile.specialization && profile.specialization !== 'RISING ENTREPRENEUR' && (
          <span className="badge accent">{profile.specialization}</span>
        )}
        <div className="money positive" style={{ fontSize: 28, marginTop: 6 }}>{formatMoney(profile.netWorth)}</div>
        <div className="faint">NET WORTH · {profile.city}</div>
        <button className="btn btn-sm btn-primary" style={{ marginTop: 8 }} onClick={openShare}>📤 Share Card</button>
      </div>

      <div className="grid-2">
        <MiniStat label="COMPANIES" value={activeBusinesses.length} />
        <MiniStat label="EMPLOYEES" value={totalEmployees} />
        <MiniStat label="REAL ESTATE" value={formatCompact(realEstateValue)} />
        <MiniStat label="DEBT" value={formatCompact(totalDebt)} negative={totalDebt > 0} />
      </div>

      <div className="card stack">
        <div className="eyebrow">STATUS</div>
        <div className="row-between"><span className="muted" style={{ fontSize: 13 }}>Home</span><span style={{ fontSize: 13, fontWeight: 700 }}>{status.home}</span></div>
        <div className="row-between"><span className="muted" style={{ fontSize: 13 }}>Vehicle</span><span style={{ fontSize: 13, fontWeight: 700 }}>{status.vehicle}</span></div>
        <div className="row-between"><span className="muted" style={{ fontSize: 13 }}>Headquarters</span><span style={{ fontSize: 13, fontWeight: 700 }}>{status.hq}</span></div>
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

      {shareUrl && (
        <div className="overlay" onClick={() => setShareUrl(null)}>
          <img src={shareUrl} alt="Share card" style={{ width: '100%', maxWidth: 300, borderRadius: 16, boxShadow: '0 20px 60px -20px rgba(0,0,0,0.7)' }} onClick={(e) => e.stopPropagation()} />
          <a href={shareUrl} download={`from-zero-${profile.display_name}.png`} className="btn btn-money" onClick={(e) => e.stopPropagation()}>DOWNLOAD IMAGE</a>
          <button className="btn btn-ghost" onClick={() => setShareUrl(null)}>Close</button>
        </div>
      )}
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
