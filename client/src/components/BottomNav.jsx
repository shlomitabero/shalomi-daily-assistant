const ITEMS = [
  { key: 'home', icon: '🏠', label: 'Home' },
  { key: 'empire', icon: '🏢', label: 'Empire' },
  { key: 'deals', icon: '🤝', label: 'Deals' },
  { key: 'estate', icon: '🏙️', label: 'Estate' },
  { key: 'world', icon: '🌍', label: 'World' },
];

export default function BottomNav({ active, onNavigate }) {
  return (
    <nav className="bottom-nav">
      {ITEMS.map((item) => (
        <button
          key={item.key}
          className={`nav-btn ${active === item.key ? 'active' : ''}`}
          onClick={() => onNavigate(item.key)}
        >
          <span className="icon">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
