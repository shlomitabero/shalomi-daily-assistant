import { Link } from 'react-router-dom';

export default function PaywallModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>You're out of free generations for today</h2>
        <p>Come back tomorrow, invite a friend for 5 bonus generations, or go unlimited with Pro.</p>
        <div className="modal-actions">
          <Link className="btn btn-primary btn-lg" to="/account">Upgrade to Pro — $9/mo</Link>
          <button className="btn btn-ghost" onClick={onClose}>Maybe later</button>
        </div>
      </div>
    </div>
  );
}
