import { useState } from 'react';
import { api } from '../api';

const AVATARS = ['🚀', '🦈', '💼', '🔥', '👑', '⚡', '🎯', '💎'];
const CITIES = ['Zero City', 'Port Meridian', 'New Ashford', 'Delta Bay'];
const ARCHETYPES = [
  { id: 'operator', label: 'The Operator', desc: 'Runs a tight ship.' },
  { id: 'investor', label: 'The Investor', desc: 'Plays the long game.' },
  { id: 'negotiator', label: 'The Negotiator', desc: 'Always gets the deal.' },
  { id: 'builder', label: 'The Builder', desc: 'Builds brands from nothing.' },
];

const STAGES = ['intro', 'identity', 'ready'];

export default function Onboarding({ onCreated }) {
  const [stage, setStage] = useState('intro');
  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [city, setCity] = useState(CITIES[0]);
  const [archetype, setArchetype] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (stage === 'intro') {
    return (
      <div className="scroll-area no-nav center fade-in" style={{ flexDirection: 'column', gap: 28, textAlign: 'center', minHeight: '100%' }}>
        <div className="stack" style={{ alignItems: 'center', gap: 18 }}>
          <div className="eyebrow">EVERY EMPIRE STARTS SOMEWHERE.</div>
          <h1 style={{ fontSize: 34, lineHeight: 1.15 }}>
            FROM<br />ZERO
          </h1>
          <p className="muted" style={{ maxWidth: 280 }}>Start with nothing. Own everything.</p>
        </div>
        <div className="card stack" style={{ width: '100%', maxWidth: 320 }}>
          <div className="row-between">
            <span className="muted">YOU HAVE</span>
            <span className="money positive" style={{ fontSize: 20 }}>$10,000</span>
          </div>
          <hr className="divider" />
          <div className="row-between"><span className="faint">Business</span><span className="faint">None</span></div>
          <div className="row-between"><span className="faint">Employees</span><span className="faint">None</span></div>
          <div className="row-between"><span className="faint">Connections</span><span className="faint">None</span></div>
        </div>
        <button className="btn btn-primary btn-block" style={{ maxWidth: 320 }} onClick={() => setStage('identity')}>
          WHAT WILL YOU BUILD?
        </button>
      </div>
    );
  }

  if (stage === 'identity') {
    return (
      <div className="scroll-area no-nav fade-in stack-lg">
        <div className="stack">
          <div className="eyebrow">CREATE YOUR PROFILE</div>
          <h2 style={{ fontSize: 24 }}>Who are you becoming?</h2>
        </div>

        <div className="stack">
          <label>Your name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Shlomi" maxLength={40} />
        </div>

        <div className="stack">
          <label>Avatar</label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {AVATARS.map((a) => (
              <button key={a} onClick={() => setAvatar(a)} className="btn btn-sm" style={{
                background: avatar === a ? 'var(--accent)' : 'var(--surface-2)',
                fontSize: 18, padding: '10px 14px',
              }}>{a}</button>
            ))}
          </div>
        </div>

        <div className="stack">
          <label>City</label>
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="stack">
          <label>Entrepreneurial style</label>
          <div className="stack">
            {ARCHETYPES.map((a) => (
              <button key={a.id} className="card card-tap row-between" onClick={() => setArchetype(a.id)}
                style={{ borderColor: archetype === a.id ? 'var(--accent)' : 'var(--border)', textAlign: 'left', width: '100%' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{a.label}</div>
                  <div className="faint">{a.desc}</div>
                </div>
                {archetype === a.id && <span style={{ color: 'var(--accent-2)' }}>✓</span>}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="badge loss">{error}</div>}

        <button
          className="btn btn-primary btn-block"
          disabled={!displayName.trim() || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const state = await api.createPlayer({ displayName, avatar, city, archetype });
              localStorage.setItem('fz_profile_id', state.profile.id);
              onCreated(state);
            } catch (e) {
              setError(e.message);
              setBusy(false);
            }
          }}
        >
          {busy ? 'Starting…' : 'START WITH $10,000'}
        </button>
      </div>
    );
  }

  return null;
}
