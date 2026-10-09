import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'ראשי', icon: '🏠' },
  { to: '/opportunities', label: 'הזדמנויות', icon: '💡' },
  { to: '/approvals', label: 'אישורים', icon: '✅' },
  { to: '/financial', label: 'פיננסי', icon: '📈' },
  { to: '/activity', label: 'יומן', icon: '📜' },
  { to: '/settings', label: 'הגדרות', icon: '⚙️' },
];

export default function Shell({ children }) {
  return (
    <div className="shell">
      <main className="shell-main">{children}</main>
      <nav className="bottom-nav">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `nav-tab${isActive ? ' active' : ''}`} end={tab.to === '/'}>
            <span className="nav-icon">{tab.icon}</span>
            <span className="nav-label">{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
