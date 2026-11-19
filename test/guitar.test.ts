import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEffect } from '../src/core/effects.ts';
import { EFFECTS, GUITAR_FX } from '../src/core/registry.ts';
import type { EffectType } from '../src/core/model.ts';

const SR = 48000;
const ctx = { sr: SR, bpm: 120, insertBus: () => undefined, beat: 0 };

/** Corda dedilhada: 110 Hz com harmônicos e decaimento, mais um chiado de fundo. */
function pluck(seconds: number) {
  const n = SR * seconds;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < 1 ? Math.exp(-t * 3) : 0;
    L[i] = 0.3 * env * (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.25 * Math.sin(2 * Math.PI * 330 * t)) + (Math.random() - 0.5) * 0.002;
  }
  return L;
}
const peak = (x: Float32Array, a = 0, b = x.length) => {
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};

test('todos os efeitos de guitarra produzem som estável', () => {
  for (const type of GUITAR_FX) {
    const fx = createEffect(SR, type as EffectType, {});
    const L = pluck(1.5), R = L.slice();
    for (let i = 0; i < L.length; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i), ctx);
    assert.ok(L.every(Number.isFinite), `${type}: valores finitos`);
    assert.ok(peak(L) > 0.01, `${type}: não silencia`);
    assert.ok(peak(L) < 2.5, `${type}: sem explodir (pico ${peak(L).toFixed(2)})`);
    assert.ok(EFFECTS[type].label, `${type}: tem nome`);
  }
});

test('noise gate fecha no silêncio e o amp distorce mais no canal lead', () => {
  const g = createEffect(SR, 'gate', { threshold: -40 });
  const L = pluck(1.5), R = L.slice();
  g.process(L, R, L.length, ctx);
  assert.ok(peak(L, SR * 1.4) < 3e-5, 'chiado cortado depois que a nota acaba');
  const thd = (channel: string) => {
    const a = createEffect(SR, 'amp', { channel, gain: 0.8, master: -12 });
    const x = new Float32Array(SR), y = x.slice();
    for (let i = 0; i < x.length; i++) x[i] = y[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR);
    a.process(x, y, x.length, ctx);
    // energia fora da fundamental ~ distorção
    let fund = 0, tot = 0;
    for (let i = SR / 2; i < SR; i++) {
      tot += x[i] * x[i];
      fund += x[i] * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    const f2 = (2 * fund * fund) / (SR / 2) / (SR / 2);
    return 1 - f2 / (tot / (SR / 2));
  };
  assert.ok(thd('lead') > thd('clean'), 'lead mais distorcido que clean');
});

test('reamp em alta qualidade reduz o aliasing do amp', async () => {
  const { renderChain } = await import('../src/core/effects.ts');
  const f = 4700; // harmônicos altos dobram de volta para frequências que não são múltiplas de f
  const x = new Float32Array(SR);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR);
  const chain = [{ type: 'amp' as EffectType, enabled: true, mix: 1, params: { channel: 'lead', gain: 0.9, master: -6 } }];
  // versão leve (a do retorno), processada direto
  const lo = createEffect(SR, 'amp', chain[0].params);
  const a = x.slice(), b = x.slice();
  for (let i = 0; i < a.length; i += 128) lo.process(a.subarray(i, i + 128), b.subarray(i, i + 128), Math.min(128, a.length - i), ctx);
  const [hq] = renderChain(SR, chain, x.slice(), x.slice(), { tailSec: 0 });
  /** Energia fora dos harmônicos de f (aliasing), relativa à total. */
  const alias = (y: Float32Array) => {
    let out = 0, tot = 0;
    const N = 8192, s0 = SR / 2;
    for (let k = 20; k < N / 2; k += 3) {
      const fr = (k * SR) / N;
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
        re += y[s0 + i] * w * Math.cos((2 * Math.PI * k * i) / N);
        im -= y[s0 + i] * w * Math.sin((2 * Math.PI * k * i) / N);
      }
      const e = re * re + im * im;
      tot += e;
      const h = fr / f;
      if (Math.abs(h - Math.round(h)) * f > 120) out += e;
    }
    return out / tot;
  };
  const al = alias(a), ah = alias(hq);
  assert.ok(ah < al * 0.25, `aliasing: leve ${al.toExponential(2)} · alta qualidade ${ah.toExponential(2)}`);
});
