import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignOffset } from '../src/core/align.ts';

const SR = 48000;
function phrase(delay: number, total = 4) {
  const x = new Float32Array(SR * total);
  const notes = [0.45, 0.45, 0.45, 0.45, 0.45];
  let t0 = delay, ph = 0;
  notes.forEach((dur, k) => {
    const f = 261.6 * Math.pow(2, [0, 2, 4, 5, 7][k] / 12);
    for (let i = Math.round(t0 * SR); i < Math.round((t0 + dur) * SR); i++) {
      const t = i / SR - t0;
      ph += (2 * Math.PI * f) / SR;
      x[i] = 0.3 * Math.min(1, t * 30, (dur - t) * 30) * Math.sin(ph);
    }
    t0 += dur;
  });
  return x;
}

test('acha o atraso entre dois takes da mesma frase', () => {
  for (const [a, b] of [[0.29, 0.64], [0.29, 0.15], [0.12, 0.89]]) {
    const d = alignOffset(phrase(a), phrase(b), SR);
    assert.ok(Math.abs(d - (b - a)) < 0.03, `${a} → ${b}: ${d.toFixed(3)}`);
  }
});
