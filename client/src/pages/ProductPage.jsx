import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

export default function ProductPage() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [paddleReady, setPaddleReady] = useState(false);

  useEffect(() => {
    api.getProduct(slug).then((r) => {
      setData(r);
      if (r.clientToken && window.Paddle) {
        if (r.sandbox) window.Paddle.Environment.set('sandbox');
        window.Paddle.Initialize({ token: r.clientToken });
        setPaddleReady(true);
      }
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
    </div>
  );
}
