// Lightweight feedback chimes (section 36) via Web Audio oscillators — no
// external audio files to ship or fetch. Every call is best-effort: audio
// can't play before a user gesture in most browsers, and that's fine here.

let ctx = null;
function getCtx() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, startTime, duration, gain = 0.08, type = 'sine') {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = 0;
  osc.connect(g);
  g.connect(c.destination);
  const t0 = c.currentTime + startTime;
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export const sfx = {
  dealClosed: () => {
    try { tone(523.25, 0, 0.14); tone(659.25, 0.08, 0.16); tone(783.99, 0.16, 0.22); } catch {}
  },
  rankUp: () => {
    try { tone(392, 0, 0.12); tone(523.25, 0.1, 0.12); tone(659.25, 0.2, 0.12); tone(783.99, 0.3, 0.3); } catch {}
  },
  million: () => {
    try {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.09, 0.28, 0.07));
    } catch {}
  },
  loss: () => {
    try { tone(300, 0, 0.18, 0.06, 'sawtooth'); tone(220, 0.1, 0.28, 0.06, 'sawtooth'); } catch {}
  },
  tap: () => {
    try { tone(880, 0, 0.05, 0.04); } catch {}
  },
};
