import { useEffect, useState } from 'react';
import Nav from '../components/Nav.jsx';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function Account() {
  const { user } = useAuth();
  const [billingConfigured, setBillingConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.billingConfigured().then((r) => setBillingConfigured(r.configured)).catch(() => {});
  }, []);

  const referralLink = `${window.location.origin}/signup?ref=${user?.referralCode}`;

  async function onCheckout() {
    setError('');
    setBusy(true);
    try {
      const { url } = await api.checkout();
      window.location.href = url;
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onPortal() {
    setError('');
    setBusy(true);
    try {
      const { url } = await api.portal();
      window.location.href = url;
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    navigator.clipboard?.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="dashboard">
      <Nav />
      <main className="dashboard-main">
        <h1>Account</h1>

        <section className="account-section">
          <h3>Your plan</h3>
          <p>{user?.isPaid ? 'You are on Pro — unlimited generations.' : 'You are on the Free plan — 5 generations/day plus referral bonuses.'}</p>
          {error && <p className="form-error">{error}</p>}
          {!billingConfigured ? (
            <p className="hint">Billing isn't configured on this deployment yet, so upgrades aren't available right now.</p>
          ) : user?.isPaid ? (
            <button className="btn btn-primary" onClick={onPortal} disabled={busy}>Manage billing</button>
          ) : (
            <button className="btn btn-primary" onClick={onCheckout} disabled={busy}>Upgrade to Pro — $9/mo</button>
          )}
        </section>

        <section className="account-section">
          <h3>Refer a friend</h3>
          <p>You've referred <strong>{user?.referralsCount ?? 0}</strong> {user?.referralsCount === 1 ? 'person' : 'people'}. Each referral gives you both 5 bonus generations.</p>
          <div className="referral-box">
            <input readOnly value={referralLink} onFocus={(e) => e.target.select()} />
            <button className="btn btn-ghost" onClick={copyLink}>{copied ? 'Copied!' : 'Copy link'}</button>
          </div>
        </section>

        <section className="account-section">
          <h3>Your stats</h3>
          <ul className="stat-list">
            <li><span>Bonus generations</span><strong>{user?.bonusGenerations ?? 0}</strong></li>
            <li><span>Current streak</span><strong>{user?.streak ?? 0} days</strong></li>
            <li><span>Member since</span><strong>{user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</strong></li>
          </ul>
        </section>
      </main>
    </div>
  );
}
