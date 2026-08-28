const ARCHETYPE_COLORS = {
  'desperate founder': '#f59e0b',
  'cautious landlord': '#64748b',
  'desperate startup founder': '#22c55e',
  'arrogant investor': '#ef4444',
  'conservative banker': '#0ea5e9',
  'aggressive founder': '#dc2626',
  'loyal manager': '#10b981',
  'ambitious employee': '#8b5cf6',
  'dishonest partner': '#eab308',
  'genius operator': '#6366f1',
  manager: '#0ea5e9',
  cook: '#f97316',
  'sales rep': '#22c55e',
  technician: '#64748b',
  marketer: '#ec4899',
};

export function archetypeColor(archetype) {
  return ARCHETYPE_COLORS[(archetype ?? '').toLowerCase()] ?? '#6d5efc';
}

export default function Portrait({ name, archetype, size = 52 }) {
  const initials = (name || '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className="portrait" style={{ width: size, height: size, background: archetypeColor(archetype), fontSize: size * 0.34 }}>
      {initials}
    </div>
  );
}
