import { businessTier } from '../world';

// The "walk up to the building, stamp the deal" moment (section 7) — shown
// inside the celebration overlay before the numbers/text, so a purchase
// reads as an event rather than a database write.
export default function Scene({ valuation = 0, avatar = '🧑‍💼', label = 'DEAL CLOSED' }) {
  const tier = businessTier(valuation);
  return (
    <div className="scene">
      <span className="scene-building">{tier.icon}</span>
      <span className="scene-avatar">{avatar}</span>
      <span className="scene-stamp">{label}</span>
    </div>
  );
}
