// Renders a shareable, screenshot-worthy profile card (sections 15, 38) onto
// a canvas. No server round-trip — pure client-side drawing, downloadable
// as a PNG via canvas.toDataURL.
import { formatMoney, formatCompact } from './format';

const W = 1080;
const H = 1350;

export function renderShareCard(canvas, { profile, rank, businessCount, employeeCount }) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1a1030');
  bg.addColorStop(0.55, '#0c0e15');
  bg.addColorStop(1, '#08090d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // subtle border frame
  ctx.strokeStyle = 'rgba(240,185,61,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  ctx.textAlign = 'center';

  ctx.fillStyle = '#f0b93d';
  ctx.font = '700 30px Sora, sans-serif';
  ctx.fillText('FROM ZERO', W / 2, 130);

  ctx.font = '160px sans-serif';
  ctx.fillText(profile.avatar || '💼', W / 2, 340);

  ctx.fillStyle = '#f4f5f7';
  ctx.font = '800 58px Sora, sans-serif';
  ctx.fillText(profile.display_name, W / 2, 430);

  ctx.fillStyle = '#8b7cff';
  ctx.font = '700 30px Sora, sans-serif';
  ctx.fillText(`RANK ${rank.rank} — ${rank.title.toUpperCase()}`, W / 2, 480);

  if (profile.specialization && profile.specialization !== 'RISING ENTREPRENEUR') {
    roundedBadge(ctx, W / 2, 540, profile.specialization, '#6d5efc');
  }

  ctx.fillStyle = '#34d399';
  ctx.font = '800 110px Sora, sans-serif';
  ctx.fillText(formatMoney(profile.netWorth), W / 2, 700);
  ctx.fillStyle = '#9aa0b0';
  ctx.font = '400 28px Inter, sans-serif';
  ctx.fillText('NET WORTH', W / 2, 745);

  const stats = [
    ['COMPANIES', String(businessCount)],
    ['EMPLOYEES', String(employeeCount)],
    ['CITY', profile.city],
  ];
  const statY = 880;
  const colW = W / stats.length;
  stats.forEach(([label, value], i) => {
    const x = colW * i + colW / 2;
    ctx.fillStyle = '#f4f5f7';
    ctx.font = '800 42px Sora, sans-serif';
    ctx.fillText(value, x, statY);
    ctx.fillStyle = '#666c7c';
    ctx.font = '400 22px Inter, sans-serif';
    ctx.fillText(label, x, statY + 34);
  });

  ctx.fillStyle = '#666c7c';
  ctx.font = '400 26px Inter, sans-serif';
  ctx.fillText('Start with nothing. Own everything.', W / 2, H - 90);
  ctx.fillStyle = '#f0b93d';
  ctx.font = '700 24px Sora, sans-serif';
  ctx.fillText('FROMZERO.GAME', W / 2, H - 50);

  return canvas.toDataURL('image/png');
}

function roundedBadge(ctx, cx, y, text, color) {
  ctx.font = '700 26px Sora, sans-serif';
  const textW = ctx.measureText(text).width;
  const pad = 26;
  const w = textW + pad * 2;
  const h = 48;
  const x = cx - w / 2;
  const r = h / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + r, y - h / 2);
  ctx.arcTo(x + w, y - h / 2, x + w, y + h / 2, r);
  ctx.arcTo(x + w, y + h / 2, x, y + h / 2, r);
  ctx.arcTo(x, y + h / 2, x, y - h / 2, r);
  ctx.arcTo(x, y - h / 2, x + w, y - h / 2, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'white';
  ctx.fillText(text, cx, y + 9);
}
