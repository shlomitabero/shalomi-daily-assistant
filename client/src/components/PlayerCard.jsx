import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney, formatCompact } from '../format';

// The "VIEW PLAYER" modal from world feed cards (section 17).
export default function PlayerCard({ profileId, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!profileId) return;
    setData(null);
    api.getPublicProfile(profileId).then(setData).catch(() => setData({ error: true }));
  }, [profileId]);

  if (!profileId) return null;

  return (
    <div className="overlay" onClick={onClose}>
      {!data ? (
        <div className="spinner" />
      ) : data.error ? (
        <div className="subline">Couldn't load this player.</div>
      ) : (
        <>
          <div style={{ fontSize: 48 }}>{data.avatar}</div>
          <div className="headline" style={{ fontSize: 26 }}>{data.displayName}</div>
          <div className="subline">RANK {data.rank.rank} — {data.rank.title} · {data.city}</div>
          {data.specialization && data.specialization !== 'RISING ENTREPRENEUR' && (
            <span className="badge accent">{data.specialization}</span>
          )}
          <div className="card stack" style={{ maxWidth: 300, width: '100%' }}>
            <div className="row-between"><span className="faint">Net worth</span><span className="money positive" style={{ fontWeight: 700 }}>{formatMoney(data.netWorth)}</span></div>
            <div className="row-between"><span className="faint">Companies</span><span style={{ fontWeight: 700 }}>{data.businessCount}</span></div>
            <div className="row-between"><span className="faint">Real estate</span><span style={{ fontWeight: 700 }}>{data.realEstateCount}</span></div>
            {data.biggestDeal && (
              <div className="row-between"><span className="faint">Biggest deal</span><span style={{ fontWeight: 700 }}>{formatCompact(data.biggestDeal.amount)}</span></div>
            )}
          </div>
        </>
      )}
      <button className="btn btn-ghost" onClick={onClose}>Close</button>
    </div>
  );
}
