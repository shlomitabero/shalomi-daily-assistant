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

export default function ProductPage() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [paddleReady, setPaddleReady] = useState(false);
  const [paddleFailed, setPaddleFailed] = useState(false);

  useEffect(() => {
    api.getProduct(slug).then(async (r) => {
      setData(r);
      if (!r.clientToken) return;
      const paddle = await waitForPaddle();
      if (!paddle) {
        setPaddleFailed(true);
        return;
      }
      if (r.sandbox) paddle.Environment.set('sandbox');
      paddle.Initialize({ token: r.clientToken });
      setPaddleReady(true);
    }).catch((err) => setError(err.data?.error || err.message));
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

  return (
    <div className="public-page">
      {product.demo && <div className="demo-banner">זהו תוכן דמו להמחשה — לא מוצר אמיתי</div>}
      <h1>{product.salesHeadline}</h1>
      <ul className="sales-bullets">
        {product.salesBullets.map((b, i) => <li key={i}>{b}</li>)}
      </ul>
      <p>{product.salesParagraph}</p>
      <div className="price-tag">${product.priceUSD}</div>
      <button className="btn btn-primary btn-lg" onClick={onBuy} disabled={!paddleReady}>קנה עכשיו</button>
      {paddleFailed && (
        <p className="form-error">
          לא ניתן לטעון את מערכת התשלום כרגע (ייתכן שחוסם פרסומות/פרטיות חוסם אותה). נסה לרענן את העמוד, או נטרל חוסם פרסומות ונסה שוב.
        </p>
      )}
    </div>
  );
}
