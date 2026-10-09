import { useEffect, useState } from 'react';
import Nav from '../components/Nav.jsx';
import PaywallModal from '../components/PaywallModal.jsx';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const TYPE_LABELS = {
  ad_copy: 'Ad copy',
  product_description: 'Product description',
  social_caption: 'Social caption',
  email_subject: 'Email subject lines',
};

export default function Dashboard() {
  const { user, setUser } = useAuth();
  const [options, setOptions] = useState({ promptTypes: [], tones: [] });
  const [promptType, setPromptType] = useState('ad_copy');
  const [tone, setTone] = useState('professional');
  const [brief, setBrief] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);

  useEffect(() => {
    api.options().then((opts) => {
      setOptions(opts);
      if (opts.promptTypes?.length) setPromptType(opts.promptTypes[0]);
      if (opts.tones?.length) setTone(opts.tones[0]);
    });
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    if (!brief.trim()) return;
    setError('');
    setBusy(true);
    try {
      const { generation, user: freshUser } = await api.generate({ promptType, tone, brief });
      setResult(generation);
      setUser(freshUser);
    } catch (err) {
      if (err.status === 402) setShowPaywall(true);
      else setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  const unlimited = user?.remainingGenerations === null;

  return (
    <div className="dashboard">
      <Nav />
      <main className="dashboard-main">
        <div className="dashboard-header">
          <h1>Generate copy</h1>
          <div className="usage-pill">
            {unlimited ? '✨ Unlimited (Pro)' : `${user?.remainingGenerations ?? 0} left today`}
            {user?.streak > 0 && <span className="streak-pill">🔥 {user.streak}-day streak</span>}
          </div>
        </div>

        <form className="generate-form" onSubmit={onSubmit}>
          <div className="field-row">
            <label>
              Copy type
              <select value={promptType} onChange={(e) => setPromptType(e.target.value)}>
                {options.promptTypes.map((t) => (
                  <option key={t} value={t}>{TYPE_LABELS[t] || t}</option>
                ))}
              </select>
            </label>
            <label>
              Tone
              <select value={tone} onChange={(e) => setTone(e.target.value)}>
                {options.tones.map((t) => (
                  <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            What is this for?
            <textarea
              required
              rows={4}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. a subscription box for artisanal coffee, aimed at young professionals"
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </form>

        {result && (
          <div className="result-card">
            <div className="result-header">
              <h3>{TYPE_LABELS[result.prompt_type] || result.prompt_type}</h3>
              {result.demo && <span className="demo-badge">Demo mode</span>}
            </div>
            <pre className="result-text">{result.output}</pre>
          </div>
        )}
      </main>
      {showPaywall && <PaywallModal onClose={() => setShowPaywall(false)} />}
    </div>
  );
}
