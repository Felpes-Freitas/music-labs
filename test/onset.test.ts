import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TakeDetector } from '../src/core/onset.ts';

const SR = 48000;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** Chiado de headset (ruído branco) + notas de guitarra dedilhadas em certos instantes. */
function scene(sec: number, noiseDb: (t: number) => number, notes: number[]) {
  const x = new Float32Array(SR * sec);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    let v = rnd() * Math.pow(10, noiseDb(t) / 20) * 1.7;
    for (const n of notes) {
      const d = t - n;
      if (d >= 0 && d < 3) v += 0.25 * Math.exp(-d * 2.2) * (Math.sin(2 * Math.PI * 196 * d) + 0.5 * Math.sin(2 * Math.PI * 392 * d) + 0.3 * Math.sin(2 * Math.PI * 588 * d));
    }
    x[i] = v;
  }
  return x;
}

/** Mesma lógica de takes da gravação: abre quando ativo, fecha depois de `hold` inativo. */
function takes(x: Float32Array, hold = 0.8, margin = 10, thresholdDb = -90) {
  const det = new TakeDetector(SR, margin, 0.12, thresholdDb);
  const out: [number, number][] = [];
  let open: number | null = null, last = 0;
  for (const s of det.push(x)) {
    if (s.active) {
      if (open === null) open = s.since / SR;
      last = s.end / SR;
    } else if (open !== null && s.end / SR - last > hold) {
      out.push([open, s.end / SR]);
      open = null;
    }
  }
  if (open !== null) out.push([open, x.length / SR]);
  return out;
}

test('com chiado constante, cada nota vira um take e o silêncio volta', () => {
  const t = takes(scene(12, () => -45, [2, 7]));
  assert.equal(t.length, 2, JSON.stringify(t));
  assert.ok(Math.abs(t[0][0] - 2) < 0.1 && Math.abs(t[1][0] - 7) < 0.1, `começos: ${JSON.stringify(t)}`);
  assert.ok(t[0][1] < 6.5, 'o primeiro take fecha antes da segunda nota');
});

test('se o ambiente fica mais barulhento, o detector se adapta e os takes ainda fecham', () => {
  // ruído sobe de -50 para -32 dB aos 4 s; notas aos 1 s e aos 11 s
  const t = takes(scene(16, (s) => (s < 4 ? -50 : -32), [1, 11]));
  const second = t.find((x) => Math.abs(x[0] - 11) < 0.2);
  assert.ok(second, `a nota aos 11 s abre um take: ${JSON.stringify(t)}`);
  assert.ok(t.every((x) => x[1] - x[0] < 7), `nenhum take fica preso aberto: ${JSON.stringify(t)}`);
});

test('ruído sozinho não abre take', () => {
  assert.equal(takes(scene(8, () => -40, [])).length, 0);
});

/** Microfone de notebook: a bateria da música vaza dos alto-falantes e duas frases são cantadas. */
function bleed(sec: number, phrases: number[]) {
  const x = new Float32Array(SR * sec);
  const beat = 60 / 128;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    let v = rnd() * 0.006;
    const ph = t % beat;
    v += 0.05 * Math.exp(-ph * 30) * Math.sin(2 * Math.PI * 60 * ph);
    v += 0.02 * Math.exp(-((t + beat / 2) % beat) * 40) * rnd();
    for (const n of phrases) {
      const d = t - n;
      if (d >= 0 && d < 1.5) v += 0.2 * Math.min(1, d * 20) * Math.min(1, (1.5 - d) * 20) * (Math.sin(2 * Math.PI * 220 * d + 0.3 * Math.sin(2 * Math.PI * 5 * d)) + 0.4 * Math.sin(2 * Math.PI * 440 * d));
    }
    x[i] = v;
  }
  return x;
}

test('com a bateria vazando no microfone, o limiar de volume separa as frases', () => {
  const t = takes(bleed(11, [2, 6.5]), 0.8, 10, -20);
  assert.equal(t.length, 2, JSON.stringify(t));
  assert.ok(Math.abs(t[0][0] - 2) < 0.15 && Math.abs(t[1][0] - 6.5) < 0.15, JSON.stringify(t));
});
