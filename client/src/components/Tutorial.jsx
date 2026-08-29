import { useState } from 'react';

const STEPS = [
  { icon: '💰', title: 'Net Worth', body: "This is everything you own — cash, businesses, real estate — minus what you owe. It's the number that matters." },
  { icon: '▶️', title: 'Advance the day', body: 'Tap "Run My Businesses" whenever you want time to pass. Your businesses earn, pay expenses, and things happen — no waiting around for timers.' },
  { icon: '🏙️', title: 'Your city', body: 'Every industry lives in a district. Tap one to find opportunities there, or open the full map from World.' },
  { icon: '⚡', title: 'Urgent cards', body: 'Deals, rivals, and property auctions show up right on your home screen — one tap gets you straight into the action.' },
  { icon: '🧭', title: "You're ready", body: 'Use the bar at the bottom to jump between your Empire, Deals, Real Estate, and the World. Go build something.' },
];

export default function Tutorial({ onDone }) {
  const [step, setStep] = useState(0);
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="overlay">
      <div style={{ fontSize: 52 }}>{s.icon}</div>
      <div className="headline" style={{ fontSize: 24 }}>{s.title}</div>
      <div className="subline">{s.body}</div>
      <div className="row" style={{ gap: 6 }}>
        {STEPS.map((_, i) => (
          <span key={i} style={{
            width: 7, height: 7, borderRadius: 99,
            background: i === step ? 'var(--gold)' : 'var(--surface-3)',
          }} />
        ))}
      </div>
      <div className="row" style={{ gap: 10 }}>
        {step > 0 && <button className="btn btn-ghost" onClick={() => setStep((s) => s - 1)}>Back</button>}
        <button className="btn btn-primary" onClick={() => (last ? onDone() : setStep((s) => s + 1))}>
          {last ? "LET'S GO" : 'Next'}
        </button>
      </div>
      {!last && (
        <button className="faint" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={onDone}>
          Skip
        </button>
      )}
    </div>
  );
}
