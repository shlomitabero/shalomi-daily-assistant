import { useEffect } from 'react';
import { formatCompact } from '../format';
import { sfx } from '../audio';
import Scene from './Scene';

// Full-screen celebration for million moments (section 37) and rank-ups.
export default function Celebration({ celebration, onDismiss, avatar }) {
  useEffect(() => {
    if (!celebration) return;
    if (celebration.type === 'million') sfx.million();
    else if (celebration.type === 'rankup') sfx.rankUp();
    else if (celebration.type === 'bankrupt') sfx.loss();
    else if (celebration.type === 'dealclosed' || celebration.type === 'purchase') sfx.dealClosed();
  }, [celebration]);

  if (!celebration) return null;

  if (celebration.type === 'purchase') {
    return (
      <div className="overlay" onClick={onDismiss}>
        <Scene valuation={celebration.valuation} avatar={avatar} label="IT'S YOURS" />
        <div className="headline" style={{ fontSize: 26 }}>{celebration.businessName}</div>
        <div className="subline">Your first day starts now.</div>
        <button className="btn btn-money" onClick={onDismiss}>OPEN FOR BUSINESS</button>
      </div>
    );
  }

  if (celebration.type === 'dealclosed') {
    return (
      <div className="overlay" onClick={onDismiss}>
        <Scene valuation={celebration.price} avatar={avatar} label="DEAL CLOSED" />
        <div className="headline" style={{ fontSize: 26 }}>{celebration.companyName}</div>
        <div className="subline">
          {celebration.stakePct}% for {formatCompact(celebration.price)} — now part of your empire.
        </div>
        <button className="btn btn-money" onClick={onDismiss}>ADD TO PORTFOLIO</button>
      </div>
    );
  }

  if (celebration.type === 'million') {
    return (
      <div className="overlay" onClick={onDismiss}>
        <div style={{ fontSize: 52 }}>💰</div>
        <div className="headline">{celebration.label}</div>
        <div className="subline">Net worth: {formatCompact(celebration.amount)}</div>
        {(celebration.daysToReach != null || celebration.firstBusiness) && (
          <div className="card stack" style={{ maxWidth: 300, width: '100%', textAlign: 'left' }}>
            {celebration.daysToReach != null && (
              <div className="row-between"><span className="faint">Days to get here</span><span style={{ fontWeight: 700 }}>{celebration.daysToReach}</span></div>
            )}
            {celebration.firstBusiness && (
              <div className="row-between"><span className="faint">Started with</span><span style={{ fontWeight: 700, textAlign: 'right' }}>{celebration.firstBusiness}</span></div>
            )}
            {celebration.businessCount != null && (
              <div className="row-between"><span className="faint">Businesses now</span><span style={{ fontWeight: 700 }}>{celebration.businessCount}</span></div>
            )}
          </div>
        )}
        <button className="btn btn-money" onClick={onDismiss}>KEEP BUILDING</button>
      </div>
    );
  }

  if (celebration.type === 'rankup') {
    const powers = (celebration.unlock ?? '').split(/\.\s+|,\s+/).map((s) => s.trim()).filter(Boolean);
    return (
      <div className="overlay" onClick={onDismiss}>
        <div className="eyebrow">{celebration.major ? `MAJOR MILESTONE — RANK ${celebration.rank}` : 'RANK UP'}</div>
        <div style={{ fontSize: celebration.major ? 60 : 44 }}>{celebration.major ? '🦈✨' : '🦈'}</div>
        <div className="headline" style={{ fontSize: celebration.major ? 32 : 26 }}>{celebration.title}</div>
        {celebration.major ? (
          <div className="card stack" style={{ maxWidth: 300, width: '100%', textAlign: 'left' }}>
            <div className="eyebrow" style={{ color: 'var(--gold)' }}>NEW POWERS UNLOCKED</div>
            {powers.map((p, i) => <div key={i} style={{ fontSize: 13.5 }}>✓ {p}</div>)}
          </div>
        ) : (
          <div className="subline">{celebration.unlock}</div>
        )}
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
