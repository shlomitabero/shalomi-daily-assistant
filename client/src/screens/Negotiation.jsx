import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';

export default function Negotiation({ profileId, offerId, onBack, onClosed }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const logRef = useRef(null);

  useEffect(() => { api.getNegotiation(profileId, offerId).then(setData); }, [offerId]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [data]);

  if (!data) return <div className="scroll-area center"><div className="spinner" /></div>;
  const { offer, target, npc, transcript } = data;
  const closed = offer.status !== 'negotiating';

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await api.sendNegotiationMessage(profileId, offerId, text.trim());
      setText('');
      setData({ ...data, offer: result.offer, transcript: result.transcript });
      if (result.decision === 'accept') {
        if (result.acquisition?.error) {
          setError(result.acquisition.error);
        } else {
          onClosed(result.acquisition);
        }
      }
      if (result.decision === 'walk_away') {
        setTimeout(() => onClosed(null), 1200);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="stack" style={{ height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '18px 18px 10px' }}>
        <button className="faint" style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer' }} onClick={onBack}>← Back</button>
        <div className="row-between" style={{ marginTop: 10 }}>
          <div>
            <div style={{ fontWeight: 800 }}>{npc?.name}</div>
            <div className="faint">{npc?.archetype} · {target?.name}</div>
          </div>
          <span className="badge accent">Asking {formatMoney(offer.ask_price)} / {offer.ask_stake_pct}%</span>
        </div>
      </div>

      <div className="scroll-area no-nav chat-log" ref={logRef} style={{ paddingTop: 6 }}>
        {transcript.map((t) => (
          <div key={t.id} className={`bubble ${t.speaker}`}>{t.message}</div>
        ))}
        {closed && (
          <div className="bubble system">
            {offer.status === 'accepted' ? 'DEAL CLOSED' : offer.status === 'rejected' ? 'NEGOTIATION ENDED' : 'CLOSED'}
          </div>
        )}
      </div>

      {error && <div className="badge loss" style={{ margin: '0 18px' }}>{error}</div>}

      {!closed ? (
        <div className="row" style={{ padding: '10px 18px calc(18px + var(--safe-bottom))', gap: 8 }}>
          <input
            placeholder="e.g. I'll give $150,000 for 60%, you stay as CEO for 2 years"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          <button className="btn btn-primary" disabled={sending || !text.trim()} onClick={send}>{sending ? '…' : 'SEND'}</button>
        </div>
      ) : (
        <div style={{ padding: '10px 18px calc(18px + var(--safe-bottom))' }}>
          <button className="btn btn-ghost btn-block" onClick={onBack}>DONE</button>
        </div>
      )}
    </div>
  );
}
