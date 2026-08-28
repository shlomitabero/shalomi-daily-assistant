import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';
import { sfx } from '../audio';
import Portrait, { archetypeColor } from '../components/Portrait';

const MOOD_BY_OUTCOME = {
  null: { label: 'Opening offer', color: '#f0b93d' },
  accept: { label: 'Ready to deal', color: '#34d399' },
  counter: { label: 'Considering', color: '#f0b93d' },
  reject: { label: 'Frustrated', color: '#fb7185' },
  walk_away: { label: 'Walking away', color: '#fb7185' },
};

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

  const lastSeller = [...transcript].reverse().find((t) => t.speaker === 'seller');
  const mood = MOOD_BY_OUTCOME[lastSeller?.outcome ?? null] ?? MOOD_BY_OUTCOME.counter;
  const turnsUsed = transcript.filter((t) => t.speaker === 'buyer').length;
  const tension = Math.min(100, turnsUsed * 22);
  const tensionColor = tension < 40 ? '#34d399' : tension < 75 ? '#f0b93d' : '#fb7185';

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
          sfx.dealClosed();
          const closingTurn = result.transcript[result.transcript.length - 1];
          onClosed(result.acquisition, { npc, target, price: closingTurn?.proposed_price, stakePct: closingTurn?.proposed_stake });
        }
      }
      if (result.decision === 'walk_away') {
        sfx.loss();
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
      <div className="boardroom">
        <button className="faint" style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer' }} onClick={onBack}>← Back</button>
        <div className="row" style={{ marginTop: 12, gap: 12, alignItems: 'flex-start' }}>
          <Portrait name={npc?.name} archetype={npc?.archetype} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{npc?.name}</div>
            <div className="faint" style={{ textTransform: 'capitalize' }}>{npc?.archetype} · {target?.name}</div>
            <div className="row" style={{ marginTop: 4, gap: 4 }}>
              <span className="mood-dot" style={{ background: mood.color }} />
              <span style={{ fontSize: 12, color: mood.color, fontWeight: 700 }}>{mood.label}</span>
            </div>
          </div>
          <span className="badge accent">{formatMoney(offer.ask_price)} / {offer.ask_stake_pct}%</span>
        </div>
        <div className="tension-track">
          <span style={{ width: `${tension}%`, background: tensionColor }} />
        </div>
      </div>

      <div className="scroll-area no-nav chat-log" ref={logRef} style={{ paddingTop: 14 }}>
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
