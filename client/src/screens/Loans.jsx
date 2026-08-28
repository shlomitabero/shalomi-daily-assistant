import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney } from '../format';

const KIND_LABEL = {
  business_loan: 'Business Loan',
  mortgage: 'Mortgage',
  credit_line: 'Credit Line',
  bridge_loan: 'Bridge Loan',
  investor_financing: 'Investor Financing',
};

export default function Loans({ state, onChanged }) {
  const [loans, setLoans] = useState([]);
  const [rates, setRates] = useState({});
  const [kind, setKind] = useState('business_loan');
  const [amount, setAmount] = useState(5000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = () => api.getLoans(state.profile.id).then((d) => { setLoans(d.loans); setRates(d.rates); });
  useEffect(() => { load(); }, []);

  const borrow = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.takeLoan(state.profile.id, kind, Number(amount));
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const repay = async (loan) => {
    setBusy(true);
    setError(null);
    try {
      await api.repayLoan(state.profile.id, loan.id, Math.min(loan.balance, state.profile.cash));
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const totalDebt = loans.filter((l) => l.status === 'active').reduce((s, l) => s + l.balance, 0);

  return (
    <div className="scroll-area stack-lg fade-in">
      <div className="stack">
        <div className="eyebrow">FINANCING</div>
        <h2 style={{ fontSize: 22 }}>Leverage your empire</h2>
        <p className="muted" style={{ fontSize: 13.5 }}>Debt grows your reach — and your risk. Total debt: <b>{formatMoney(totalDebt)}</b></p>
      </div>

      {error && <div className="badge loss">{error}</div>}

      <div className="card stack">
        <div className="eyebrow">TAKE A LOAN</div>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(rates).map(([k, r]) => <option key={k} value={k}>{KIND_LABEL[k] ?? k} — {(r * 100).toFixed(0)}% APR</option>)}
        </select>
        <input type="number" min={500} step={500} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className="btn btn-primary btn-block" disabled={busy || !(amount > 0)} onClick={borrow}>BORROW {formatMoney(amount)}</button>
      </div>

      <div className="stack">
        <div className="eyebrow">MY LOANS</div>
        {loans.length === 0 && <div className="faint">No loans yet.</div>}
        {loans.map((l) => (
          <div key={l.id} className="card row-between">
            <div>
              <div style={{ fontWeight: 700 }}>{KIND_LABEL[l.kind] ?? l.kind}</div>
              <div className="faint">{(l.annual_rate * 100).toFixed(0)}% APR · {l.status}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="money negative">{formatMoney(l.balance)}</div>
              {l.status === 'active' && (
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => repay(l)}>Repay</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
