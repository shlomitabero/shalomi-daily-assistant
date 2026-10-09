import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import Nav from '../components/Nav.jsx';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function Admin() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.isAdmin) return;
    api.adminStats().then(setStats).catch((err) => setError(err.data?.error || err.message));
  }, [user]);

  if (user && !user.isAdmin) return <Navigate to="/app" replace />;

  return (
    <div className="dashboard">
      <Nav />
      <main className="dashboard-main">
        <h1>Analytics</h1>
        {error && <p className="form-error">{error}</p>}
        {stats && (
          <>
            <div className="stat-grid">
              <div className="stat-box"><span>Total signups</span><strong>{stats.totalSignups}</strong></div>
              <div className="stat-box"><span>DAU today</span><strong>{stats.dauToday}</strong></div>
              <div className="stat-box"><span>Paid subscribers</span><strong>{stats.paidSubscribers}</strong></div>
              <div className="stat-box"><span>Conversion rate</span><strong>{stats.conversionRate}%</strong></div>
              <div className="stat-box stat-box-highlight"><span>MRR</span><strong>${stats.mrr}</strong></div>
              <div className="stat-box"><span>Total generations</span><strong>{stats.totalGenerations}</strong></div>
              <div className="stat-box"><span>Total referrals</span><strong>{stats.totalReferrals}</strong></div>
            </div>

            <h2>Last 7 days</h2>
            <table className="stat-table">
              <thead>
                <tr><th>Day</th><th>Signups</th><th>Generations</th><th>DAU</th></tr>
              </thead>
              <tbody>
                {stats.last7.map((row) => (
                  <tr key={row.day}>
                    <td>{row.day}</td>
                    <td>{row.signups}</td>
                    <td>{row.generations}</td>
                    <td>{row.dau}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </div>
  );
}
