import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const MODE_EXPLAIN = {
  research: 'רק מאתר ומציג הזדמנויות. שום פעולה אמיתית (פרסום, חיוב, מסחר) לא מתבצעת — בטוח לגמרי לניסוי.',
  approve: 'מאתר הזדמנויות ומכין אותן, אבל כל פעולה אמיתית ממתינה לאישור ידני שלך מהמסך "אישורים".',
  auto_limited: 'פועל לבד — מפרסם ומבצע פעולות בלי לשאול — אבל אף פעם לא מעבר לתקציב ולהפסד המרבי שהגדרת למטה.',
};

export default function Settings() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ budget: '', maxLoss: '', country: '', currency: 'ILS', mode: 'research' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function refresh() {
    api.getSettings().then((r) => {
      setSettings(r.settings);
      setForm({
        budget: r.settings.budget ?? '',
        maxLoss: r.settings.maxLoss ?? '',
        country: r.settings.country ?? '',
        currency: r.settings.currency ?? 'ILS',
        mode: r.settings.mode,
      });
    });
  }
  useEffect(refresh, []);

  async function onSave(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.updateSettings({
        budget: Number(form.budget || 0),
        maxLoss: form.maxLoss !== '' ? Number(form.maxLoss) : null,
        country: form.country || null,
        currency: form.currency,
        mode: form.mode,
      });
      refresh();
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleStop() {
    setBusy(true);
    try {
      await api.updateSettings({ emergencyStop: !settings.emergencyStop });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  function onLogout() {
    logout();
    navigate('/login');
  }

  if (!settings) return <div className="page-loading">טוען…</div>;

  return (
    <div className="page">
      <h1>הגדרות</h1>

      <button className={`kill-switch ${settings.emergencyStop ? 'active' : ''}`} onClick={onToggleStop} disabled={busy}>
        {settings.emergencyStop ? '🛑 עצירה פעילה — לחץ לביטול' : '⏹ עצירה מיידית'}
      </button>
      <p className="hint" style={{ margin: '-10px 0 16px' }}>עצירה מיידית חוסמת כל פעולה אמיתית (פרסום, חיוב) מיד, בלי קשר למצב הפעולה — לשימוש בכל רגע שמשהו נראה לא בסדר.</p>

      <form className="card form" onSubmit={onSave}>
        <label>
          תקציב כולל ({form.currency})
          <input type="number" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="0" />
        </label>
        <p className="hint" style={{ margin: '-4px 0 0' }}>הסכום המרבי שהמערכת מותרת להוציא בסך הכול (עלויות AI, סליקה וכו'). כל עוד זה 0, שום הוצאה אמיתית לא תתבצע.</p>
        <label>
          הפסד מרבי מקובל ({form.currency})
          <input type="number" value={form.maxLoss} onChange={(e) => setForm({ ...form, maxLoss: e.target.value })} placeholder="ללא הגבלה" />
        </label>
        <p className="hint" style={{ margin: '-4px 0 0' }}>תקרה נפרדת על הפסד נטו (עלות שלא כוסתה בהכנסה) — למשל במסחר מדומה. ריק = בלי תקרה נפרדת, רק תקציב כללי.</p>
        <label>
          מדינה
          <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="ישראל" />
        </label>
        <label>
          מטבע
          <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="ILS">שקל</option>
            <option value="USD">דולר</option>
          </select>
        </label>
        <label>
          מצב פעולה
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            <option value="research">מחקר בלבד</option>
            <option value="approve">אישור לביצוע</option>
            <option value="auto_limited">אוטומטי מוגבל</option>
          </select>
        </label>
        <p className="hint" style={{ margin: '-4px 0 0' }}>{MODE_EXPLAIN[form.mode]}</p>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>שמור</button>
      </form>

      <Link className="link" to="/sources">מקורות הכנסה ←</Link>
      <br />
      <Link className="link" to="/digests">סיכום יומי ←</Link>
      <br />
      <button className="btn btn-ghost" onClick={onLogout}>התנתק</button>
    </div>
  );
}
