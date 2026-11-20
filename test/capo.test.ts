// Capotraste: o tom muda pelo intervalo pedido (medido por cruzamentos de zero de um seno).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEffect } from '../src/core/effects.ts';

const SR = 48000;
function shifted(freq: number, params: Record<string, number>) {
  const fx = createEffect(SR, 'capo', params);
  const n = SR; // 1 s em blocos de 128
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = R[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  const ctx = { sr: SR, bpm: 120, insertBus: () => undefined, beat: 0 };
  for (let o = 0; o < n; o += 128) {
    const l = L.subarray(o, o + 128), r = R.subarray(o, o + 128);
    fx.process(l, r, 128, ctx);
  }
  return L.subarray(SR / 4); // ignora o começo
}
/** Frequência pelos cruzamentos de zero subindo (o seno deslocado continua um seno). */
function pitch(x: Float32Array) {
  let z = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) z++;
  return z / (x.length / SR);
}
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

test('oitava abaixo: guitarra vira baixo', () => {
  assert.ok(Math.abs(cents(pitch(shifted(440, { octave: -1 })), 220)) < 35);
});
test('semitons para cima (capotraste na 7ª casa)', () => {
  assert.ok(Math.abs(cents(pitch(shifted(440, { semis: 7 })), 440 * 2 ** (7 / 12))) < 35);
});
test('sem mudança: o som passa igual', () => {
  const y = shifted(440, {});
  const t = SR / 4 + 100;
  assert.ok(Math.abs(y[100] - Math.sin((2 * Math.PI * 440 * t) / SR)) < 1e-6);
});
