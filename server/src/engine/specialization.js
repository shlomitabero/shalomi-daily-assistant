// Infers a play-style label from what the player actually did (section 43)
// — never asked for directly, and never permanently locked in; it's
// recomputed fresh from current counts every time.
const CANDIDATES = [
  { label: 'THE SHARK', field: 'acquisitions', min: 2 },
  { label: 'THE REAL ESTATE KING', field: 'properties', min: 3 },
  { label: 'THE INVESTOR', field: 'investments', min: 3 },
  { label: 'THE BUILDER', field: 'organicBusinesses', min: 3 },
];

export function inferSpecialization(stats) {
  const qualifying = CANDIDATES
    .map((c) => ({ ...c, strength: stats[c.field] ?? 0 }))
    .filter((c) => c.strength >= c.min);
  if (!qualifying.length) return 'RISING ENTREPRENEUR';
  qualifying.sort((a, b) => b.strength - a.strength);
  return qualifying[0].label;
}
