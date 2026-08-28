import { formatCompact } from '../format';

// Full-screen celebration for million moments (section 37) and rank-ups.
export default function Celebration({ celebration, onDismiss }) {
  if (!celebration) return null;

  if (celebration.type === 'million') {
    return (
      <div className="overlay" onClick={onDismiss}>
        <div style={{ fontSize: 52 }}>💰</div>
        <div className="headline">{celebration.label}</div>
        <div className="subline">Net worth: {formatCompact(celebration.amount)}</div>
        <button className="btn btn-money" onClick={onDismiss}>KEEP BUILDING</button>
      </div>
    );
  }

  if (celebration.type === 'rankup') {
    return (
      <div className="overlay" onClick={onDismiss}>
        <div className="eyebrow">RANK UP</div>
        <div style={{ fontSize: 44 }}>🦈</div>
        <div className="headline">{celebration.title}</div>
        <div className="subline">{celebration.unlock}</div>
        <button className="btn btn-primary" onClick={onDismiss}>CONTINUE</button>
      </div>
    );
  }

  if (celebration.type === 'bankrupt') {
    return (
      <div className="overlay" onClick={onDismiss}>
        <div style={{ fontSize: 44 }}>📉</div>
        <div className="headline" style={{ WebkitTextFillColor: 'unset', color: 'var(--loss)' }}>BANKRUPT.</div>
        <div className="subline">Your businesses folded and your debts were wiped. You're back to $1,000 — and a legacy that remembers this.</div>
        <button className="btn btn-ghost" onClick={onDismiss}>START THE COMEBACK</button>
      </div>
    );
  }

  return null;
}
