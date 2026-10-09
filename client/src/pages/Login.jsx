import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(password);
      navigate('/');
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">⚡ PROFIT AI</div>
        <p className="hint">מנוע הכנסות אוטונומי — כלי אישי, לא ציבורי.</p>
        <form onSubmit={onSubmit}>
          <label>
            סיסמה
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
            {busy ? 'מתחבר…' : 'התחברות'}
          </button>
        </form>
      </div>
    </div>
  );
}
