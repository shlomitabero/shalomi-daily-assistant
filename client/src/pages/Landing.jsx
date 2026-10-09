import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Landing() {
  const { user } = useAuth();

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="brand">⚡ CopyBolt</div>
        <nav>
          {user ? (
            <Link className="btn btn-primary" to="/app">Open app</Link>
          ) : (
            <>
              <Link className="btn btn-ghost" to="/login">Log in</Link>
              <Link className="btn btn-primary" to="/signup">Start free</Link>
            </>
          )}
        </nav>
      </header>

      <section className="hero">
        <h1>Marketing copy that writes itself.</h1>
        <p>
          Ad headlines, product descriptions, social captions, email subject lines —
          generated in seconds. 5 free every day, no credit card required.
        </p>
        <Link className="btn btn-primary btn-lg" to={user ? '/app' : '/signup'}>
          {user ? 'Open the generator' : 'Start generating for free'}
        </Link>
      </section>

      <section className="features">
        <div className="feature-card">
          <div className="feature-icon">✍️</div>
          <h3>4 copy types</h3>
          <p>Ad copy, product descriptions, social captions, and email subject lines.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">🎯</div>
          <h3>5 tones</h3>
          <p>Professional, playful, bold, luxury, or friendly — pick what fits your brand.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">🔥</div>
          <h3>Daily streaks</h3>
          <p>Come back every day, build a streak, and never run out of fresh ideas.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">🎁</div>
          <h3>Refer & earn</h3>
          <p>Invite a friend — you both get 5 bonus generations, instantly.</p>
        </div>
      </section>

      <section className="pricing">
        <h2>Simple pricing</h2>
        <div className="pricing-cards">
          <div className="price-card">
            <h3>Free</h3>
            <div className="price">$0</div>
            <ul>
              <li>5 generations / day</li>
              <li>All copy types &amp; tones</li>
              <li>Referral bonuses</li>
            </ul>
            <Link className="btn btn-ghost" to="/signup">Get started</Link>
          </div>
          <div className="price-card price-card-highlight">
            <h3>Pro</h3>
            <div className="price">$9<span>/mo</span></div>
            <ul>
              <li>Unlimited generations</li>
              <li>All copy types &amp; tones</li>
              <li>Priority support</li>
            </ul>
            <Link className="btn btn-primary" to="/signup">Go Pro</Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">CopyBolt</footer>
    </div>
  );
}
