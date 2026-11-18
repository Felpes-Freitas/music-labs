import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curveDb, readNodes, resolveNodes } from '../src/core/prisma.ts';
import { analyzeSpectrum, bandFreq, BANDS } from '../src/core/analyzer.ts';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';

const st = { t: 0, fenv: 0, vel: 0.75, lfo: 0, phaser: 0 };
const at = (p: any, f: number) => curveDb(resolveNodes(p, 261.63, st), Math.log2(f));

test('filtro de nós: pico, corte à esquerda e linha por pontos', () => {
  const peak = { ftype: 'off', f2_type: 'peak', f2_freq: 1000, f2_gain: 12, f2_res: 0.6, f2_amt: 1 };
  assert.ok(Math.abs(at(peak, 1000) - 12) < 0.01, `pico em 1 kHz: ${at(peak, 1000)}`);
  assert.ok(at(peak, 100) < 1, 'longe do pico fica plano');
  // intensidade escala o efeito
  assert.ok(Math.abs(at({ ...peak, f2_amt: 0.5 }, 1000) - 6) < 0.01);
  const hp = { ftype: 'highpass', cutoff: 500, res: 0, slope: 24, keytrack: 0, velCutoff: 0 };
  assert.ok(at(hp, 100) < -40, `100 Hz cortado: ${at(hp, 100).toFixed(1)} dB`);
  assert.ok(at(hp, 4000) > -1, 'agudos passam');
  const line = { ftype: 'off', f2_type: 'point', f2_freq: 200, f2_gain: 0, f3_type: 'point', f3_freq: 3200, f3_gain: -24 };
  const mid = at(line, 800); // 2 oitavas depois de 200 Hz, de 4 no total
  assert.ok(Math.abs(mid + 12) < 0.01, `linha no meio: ${mid}`);
  assert.ok(Math.abs(at(line, 50) - 0) < 0.01 && Math.abs(at(line, 10000) + 24) < 0.01, 'fora dos pontos fica no valor da ponta');
});

test('filtro de nós: o nó 1 continua lendo os parâmetros antigos', () => {
  const n = readNodes({ ftype: 'lowpass', cutoff: 900, res: 0.25, slope: 36, keytrack: 0.3, velCutoff: 2 })[0];
  assert.deepEqual([n.type, n.freq, n.res, n.slope, n.key, n.vel], ['lowpass', 900, 0.25, 36, 0.3, 2]);
  const lp = { ftype: 'lowpass', cutoff: 900, res: 0, slope: 24, keytrack: 0, velCutoff: 0 };
  assert.ok(at(lp, 200) > -1 && at(lp, 7200) < -60, 'passa-baixa: graves passam, agudos caem');
});

test('analisador: o pico aparece na frequência da nota', () => {
  const sr = 44100;
  const ring = new Float32Array(2048);
  for (let i = 0; i < ring.length; i++) ring[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  const s = analyzeSpectrum(ring, 0, sr);
  let best = 0;
  for (let b = 1; b < BANDS; b++) if (s[b] > s[best]) best = b;
  const f = bandFreq(best);
  assert.ok(f > 400 && f < 480, `pico em ${f.toFixed(0)} Hz`);
  assert.ok(Math.abs(s[best] + 6) < 2.5, `nível ${s[best]} dB (senoide de 0,5 ≈ -6 dB)`);
});

test('engine: espectro do canal observado vem no status', () => {
  const p = emptyProject();
  const r = A.addChannel(p, { preset: 'Prisma Init', insert: 'master' });
  applyOps(p, r.ops);
  const ch = (r.result as any).id;
  const eng = new Engine(44100);
  eng.setProject(p);
  eng.watch(ch);
  eng.liveOn(ch, 57, 0.9); // A3 = 220 Hz
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  for (let i = 0; i < 40; i++) eng.process(L, R, BLOCK);
  const s = eng.status().spectrum!;
  assert.ok(s, 'há espectro');
  let best = 0;
  for (let b = 1; b < BANDS; b++) if (s[b] > s[best]) best = b;
  assert.ok(bandFreq(best) > 190 && bandFreq(best) < 250, `fundamental em ${bandFreq(best).toFixed(0)} Hz`);
  assert.equal(eng.status().spectrum, null, 'sem bloco novo, sem espectro novo');
});
