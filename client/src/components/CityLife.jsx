// Ambient motion for district tiles / the home city strip — small walking
// pedestrians and cars on pure CSS keyframe loops (no JS animation frame
// loop, so it's cheap even with many tiles on screen at once). Purely
// decorative: makes the city read as alive even when the player isn't
// doing anything.
const WALKERS = ['🚶', '🚗', '🚕', '🚶‍♀️', '🚌'];

// A small deterministic PRNG so the same district always gets the same
// "cast" instead of reshuffling on every re-render.
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export default function CityLife({ seed = 0, count = 3, compact = false }) {
  const rand = seededRandom(seed + 1);
  const walkers = Array.from({ length: count }, (_, i) => {
    const r = rand();
    return {
      emoji: WALKERS[Math.floor(rand() * WALKERS.length)],
      top: `${18 + Math.floor(rand() * 55)}%`,
      duration: 7 + rand() * 9,
      delay: -rand() * 12,
      reverse: r > 0.5,
      size: compact ? 10 : 13,
    };
  });

  return (
    <div className="city-life" aria-hidden="true">
      {walkers.map((w, i) => (
        <span
          key={i}
          className={`city-walker ${w.reverse ? 'reverse' : ''}`}
          style={{
            top: w.top,
            fontSize: w.size,
            animationDuration: `${w.duration}s`,
            animationDelay: `${w.delay}s`,
          }}
        >
          {w.emoji}
        </span>
      ))}
    </div>
  );
}
