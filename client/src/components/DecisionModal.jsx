import { useState } from 'react';

// The Decision Engine (section 11): fixed options, or write your own —
// both resolve through the same server-side outcome table.
export default function DecisionModal({ event, busy, onDecide, onClose }) {
  const [text, setText] = useState('');
  if (!event) return null;
  const options = event.impact?.options ?? [];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card stack" style={{ maxWidth: 340, width: '100%', textAlign: 'left' }} onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">DECISION</div>
        <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.4 }}>{event.description}</div>
        <div className="stack">
          {options.map((o) => (
            <button key={o.key} className="btn btn-ghost btn-block" disabled={busy} onClick={() => onDecide({ choice: o.key })}>
              {o.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input placeholder="Or write your own response…" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => onDecide({ text: text.trim() })}>SEND</button>
        </div>
        <button className="faint" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'center' }} onClick={onClose}>
          Decide later
        </button>
      </div>
    </div>
  );
}
