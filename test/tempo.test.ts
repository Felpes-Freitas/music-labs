// Andamento: tap tempo e detecção do BPM de áudios sintéticos (cliques e "palhetadas").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBpm, tapBpm } from '../src/core/tempo.ts';

const SR = 44100;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** Áudio com um som a cada batida: hits = [{beat, gain}] repetidos por `bars` compassos. */
function render(bpm: number, secs: number, start: number, hit: (t: number) => number, pattern: [number, number][]) {
  const x = new Float32Array(Math.round(secs * SR));
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.002; // ruído de fundo
  const beat = 60 / bpm;
  for (let bar = 0; ; bar++) {
    const t0 = start + bar * 4 * beat;
    if (t0 > secs) break;
    for (const [b, g] of pattern) {
      const s = Math.round((t0 + b * beat) * SR);
      for (let i = 0; i < SR * 0.4 && s + i < x.length; i++) x[s + i] += g * hit(i / SR);
    }
  }
  return x;
}
const click = (t: number) => rnd() * Math.exp(-t * 60);
const strum = (t: number) => Math.exp(-t * 6) * (Math.sin(2 * Math.PI * 196 * t) + 0.7 * Math.sin(2 * Math.PI * 247 * t) + 0.5 * Math.sin(2 * Math.PI * 294 * t)) * Math.min(1, t * 400) * 0.4;

test('cliques a 97 BPM, começando em 0,3 s', () => {
  const g = detectBpm(render(97, 20, 0.3, click, [[0, 1], [1, 0.6], [2, 0.8], [3, 0.6]]), SR)!;
  assert.ok(Math.abs(g.bpm - 97) < 0.3, `bpm ${g.bpm}`);
  const beat = 60 / 97;
  const off = Math.abs(((g.firstBeat - 0.3) % beat + beat * 1.5) % beat - beat / 2);
  assert.ok(off < 0.03, `primeiro tempo ${g.firstBeat}`);
  assert.ok(g.confidence > 0.3, `confiança ${g.confidence}`);
});

test('violão em colcheias a 128 BPM (tempos mais fortes)', () => {
  const pat: [number, number][] = [];
  for (let i = 0; i < 8; i++) pat.push([i / 2, i % 2 ? 0.45 : 1]);
  const g = detectBpm(render(128, 20, 0.05, strum, pat), SR)!;
  assert.ok(Math.abs(g.bpm - 128) < 0.3, `bpm ${g.bpm}`);
});

test('balada a 72 BPM não vira 144', () => {
  const g = detectBpm(render(72, 24, 0.5, strum, [[0, 1], [1, 0.7], [2, 0.85], [3, 0.7]]), SR)!;
  assert.ok(Math.abs(g.bpm - 72) < 0.3, `bpm ${g.bpm}`);
  assert.ok(g.alternatives.some((a) => Math.abs(a - 144) < 1), 'oferece o dobro como alternativa');
});

test('silêncio ou áudio curto: sem palpite', () => {
  assert.equal(detectBpm(new Float32Array(SR * 10), SR), null);
  assert.equal(detectBpm(render(120, 2, 0, click, [[0, 1]]), SR), null);
});

test('tap tempo', () => {
  assert.equal(tapBpm([0]), null);
  assert.equal(tapBpm([0, 500]), 120);
  // cliques humanos imprecisos em torno de 90 BPM
  const t = [0, 668, 1330, 2004, 2664, 3336, 4000];
  assert.ok(Math.abs(tapBpm(t)! - 90) < 0.6);
});

import { emptyProject, PPQ } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import { applyTempo } from '../src/core/studio.ts';

test('aplicar o BPM do áudio: áudios mantêm a duração e o clipe vai para a grade', () => {
  let p = emptyProject();
  p.bpm = 120;
  const tps = (120 * PPQ) / 60; // ticks por segundo a 120
  p.clips.push({ id: 'g', track: 0, pos: 4 * PPQ * 4, len: Math.round(10 * tps), patternId: '', offset: 0, kind: 'audio', sample: '/x.wav', startSec: 0 });
  p.clips.push({ id: 'o', track: 1, pos: 0, len: Math.round(5 * tps), patternId: '', offset: 0, kind: 'audio', sample: '/y.wav' });
  // o violão está a 90 BPM e o primeiro tempo cai em 0,4 s do arquivo
  const r = applyTempo(p, { bpm: 90, clip: 'g', firstBeat: 0.4 });
  p = applyOps(p, r.ops);
  assert.equal(p.bpm, 90);
  const tps2 = (90 * PPQ) / 60;
  const g = p.clips.find((c) => c.id === 'g')!, o = p.clips.find((c) => c.id === 'o')!;
  assert.ok(Math.abs(g.len / tps2 - 10) < 0.02, 'clipe continua com 10 s');
  assert.ok(Math.abs(o.len / tps2 - 5) < 0.02, 'outros áudios também');
  // o primeiro tempo (0,4 s depois do começo do clipe) cai num começo de compasso
  const beatAt = g.pos + 0.4 * tps2;
  const bar = PPQ * 4;
  assert.ok(Math.abs(beatAt / bar - Math.round(beatAt / bar)) * bar < 1, `primeiro tempo em ${beatAt}`);
  assert.ok(Math.abs(g.pos - 4 * bar) < bar, 'fica perto de onde estava');
});
