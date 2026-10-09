import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Approvals() {
  const [approvals, setApprovals] = useState([]);

  useEffect(() => {
    api.getApprovals().then((r) => setApprovals(r.approvals));
  }, []);

  return (
    <div className="page">
      <h1>אישורים</h1>
      {approvals.length === 0 && <p className="hint">אין אישורים עדיין. אישור נוצר מתוך כרטיס הזדמנות כשהמצב הוא "אישור לביצוע".</p>}
      {approvals.map((a) => (
        <div key={a.id} className="card">
          <p>פעולה: {a.actionType}</p>
          <p>סטטוס: {a.status}</p>
          <Link className="link" to={`/opportunities/${a.opportunityId}`}>לכרטיס ההזדמנות ←</Link>
        </div>
      ))}
    </div>
  );
}
