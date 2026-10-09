import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Nav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function onLogout() {
    logout();
    navigate('/');
  }

  return (
    <header className="app-nav">
      <Link className="brand" to="/app">⚡ CopyBolt</Link>
      <nav>
        <Link to="/app">Generate</Link>
        <Link to="/account">Account</Link>
        {user?.isAdmin && <Link to="/admin">Admin</Link>}
        <button className="btn btn-ghost" onClick={onLogout}>Log out</button>
      </nav>
    </header>
  );
}
