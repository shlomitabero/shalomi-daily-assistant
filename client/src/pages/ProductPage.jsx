import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

// Paddle's SDK loads from a CDN <script> tag in index.html — if that's
// blocked (an ad/privacy blocker commonly flags paddle.com) or just slow
// on a bad connection, window.Paddle may not exist yet, or ever, by the
// time this page's data comes back. Polling a few times before giving up
// tells the two cases apart: "still loading" vs. "actually failed" — a
// real paying customer on this page deserves an error, not a button that
// stays disabled forever with no explanation.
function waitForPaddle({ retries = 10, intervalMs = 300 } = {}) {
  return new Promise((resolve) => {
    let attempts = 0;
    function check() {
      if (window.Paddle) return resolve(window.Paddle);
      attempts += 1;
      if (attempts >= retries) return resolve(null);
      setTimeout(check, intervalMs);
    }
    check();
  });
}

// Before this, a real customer who actually paid through Paddle had no way
// to ever receive what they bought: ProductPage only ever showed sales
// copy, and the real guide text was only ever rendered on the owner's own
// authenticated OpportunityDetail.jsx. Paddle's checkout.completed browser
// event is the only client-side signal a purchase happened, but it must
// never unlock the paid content by itself (anyone could fire a fake one
// from devtools) — the server only releases the guide once the webhook in
// billing.js has actually recorded a verified ledger entry for that exact
// transaction, which usually lands within a second or two of this event.
function purchaseStorageKey(slug) {
  return `profitai_purchase_${slug}`;
}

export default function ProductPage() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [paddleReady, setPaddleReady] = useState(false);
  const [paddleFailed, setPaddleFailed] = useState(false);
  const [paddleNotConfigured, setPaddleNotConfigured] = useState(false);
  const [guide, setGuide] = useState(null);
  const [purchasePending, setPurchasePending] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);

  async function tryFetchGuide(transactionId) {
    try {
      const r = await api.getProductGuide(slug, transactionId);
      setGuide(r.guide);
      setPurchasePending(false);
      return true;
    } catch (err) {
      if (err.status === 402) return false; // real purchase, not verified yet — keep waiting
      return false; // a transient network error here must not look like "purchase failed"
    }
  }

  async function pollForGuide(transactionId) {
    setPurchasePending(true);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await tryFetchGuide(transactionId)) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Still not confirmed after ~20s — stay honest: the purchase likely went
    // through (Paddle itself confirmed it client-side), but say so plainly
    // instead of either pretending it failed or fabricating the guide.
  }

  async function onCheckAgain() {
    const transactionId = localStorage.getItem(purchaseStorageKey(slug));
    if (!transactionId) return;
    setCheckingPayment(true);
    try {
      await tryFetchGuide(transactionId);
    } finally {
      setCheckingPayment(false);
    }
  }

  useEffect(() => {
    api.getProduct(slug).then(async (r) => {
      setData(r);
      // Without this, a real customer on a product page published before
      // Paddle was configured (or if it's ever unset again) would see a
      // "קנה עכשיו" button that's just silently disabled forever — no
      // error, no explanation, indistinguishable from a slow network.
      if (!r.clientToken) {
        setPaddleNotConfigured(true);
        return;
      }
      const paddle = await waitForPaddle();
      if (!paddle) {
        setPaddleFailed(true);
        return;
      }
      if (r.sandbox) paddle.Environment.set('sandbox');
      paddle.Initialize({
        token: r.clientToken,
        eventCallback: (event) => {
          if (event?.name !== 'checkout.completed') return;
          const transactionId = event.data?.transaction_id;
          if (!transactionId) return;
          localStorage.setItem(purchaseStorageKey(slug), transactionId);
          pollForGuide(transactionId);
        },
      });
      setPaddleReady(true);

      // A reload right after paying (or before this session's own poll
      // finished) must not force the customer to find and re-enter a
      // checkout — resume from the transaction id saved on this device.
      const savedTransactionId = localStorage.getItem(purchaseStorageKey(slug));
      if (savedTransactionId) pollForGuide(savedTransactionId);
    }).catch((err) => setError(err.data?.error || err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function onBuy() {
    if (!paddleReady || !data?.product?.paddlePriceId) return;
    window.Paddle.Checkout.open({
      items: [{ priceId: data.product.paddlePriceId, quantity: 1 }],
      customData: { opportunityId: data.product.opportunityId },
    });
  }

  if (error) return <div className="public-page"><p>המוצר לא נמצא.</p></div>;
  if (!data) return <div className="public-page">טוען…</div>;

  const { product } = data;

  if (guide) {
    return (
      <div className="public-page">
        <div className="demo-banner" style={{ background: 'var(--positive-bg, #e6f4ea)', color: 'var(--positive, #1a7f37)' }}>
          התשלום אומת — הנה המדריך שלך
        </div>
        {/* data.sandbox means Paddle's test environment — no real money
            moved. Without this, a sandbox purchase (e.g. while the owner is
            testing the flow) would show the exact same "payment verified"
            confirmation as a real sale, which is the one thing this build
            promises never to blur. */}
        {data.sandbox && <p className="hint">(מצב בדיקה של Paddle — לא בוצע תשלום אמיתי)</p>}
        <h1>{product.salesHeadline}</h1>
        <p className="guide-preview" style={{ maxHeight: 'none' }}>{guide}</p>
      </div>
    );
  }

  return (
    <div className="public-page">
      {product.demo && <div className="demo-banner">זהו תוכן דמו להמחשה — לא מוצר אמיתי</div>}
      <h1>{product.salesHeadline}</h1>
      <ul className="sales-bullets">
        {product.salesBullets.map((b, i) => <li key={i}>{b}</li>)}
      </ul>
      <p>{product.salesParagraph}</p>
      <div className="price-tag">${product.priceUSD}</div>
      {purchasePending ? (
        <>
          <p className="hint">התשלום התקבל ב-Paddle — מאשרים ומכינים את המדריך…</p>
          <button className="btn btn-ghost" onClick={onCheckAgain} disabled={checkingPayment}>
            {checkingPayment ? 'בודק…' : 'בדוק שוב'}
          </button>
        </>
      ) : (
        <button className="btn btn-primary btn-lg" onClick={onBuy} disabled={!paddleReady}>קנה עכשיו</button>
      )}
      {paddleFailed && (
        <p className="form-error">
          לא ניתן לטעון את מערכת התשלום כרגע (ייתכן שחוסם פרסומות/פרטיות חוסם אותה). נסה לרענן את העמוד, או נטרל חוסם פרסומות ונסה שוב.
        </p>
      )}
      {paddleNotConfigured && (
        <p className="form-error">מערכת התשלומים עדיין לא מוגדרת למוצר זה — לא ניתן לרכוש כרגע.</p>
      )}
    </div>
  );
}
