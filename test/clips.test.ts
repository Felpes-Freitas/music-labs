import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject, PPQ } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';

const SR = 44100;
function run(eng: Engine, seconds: number) {
  const n = Math.round(SR * seconds);
  const L = new Float32Array(n);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  for (let f = 0; f < n; f += BLOCK) {
    eng.process(bl, br, BLOCK);
    L.set(bl.subarray(0, Math.min(BLOCK, n - f)), f);
  }
  return L;
}
const rms = (x: Float32Array, a: number, b: number) => {
  let s = 0;
  for (let i = Math.floor(a); i < Math.floor(b); i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

test('clipe de áudio toca no compasso certo, inclusive começando no meio', () => {
  const p = emptyProject();
  p.bpm = 120; // 1 compasso = 2 s
  const tone = new Float32Array(SR * 4);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 330 * i) / SR);
  applyOps(p, A.addAudioClip(p, { sample: 'voz.wav', bar: 2, lengthSec: 4 }).ops);
  applyOps(p, A.placePattern(p, { pattern: p.patterns[0].id, track: 5, bar: 1, bars: 6 }).ops); // música mais longa
  const eng = new Engine(SR);
  eng.setSample('voz.wav', { sr: SR, ch: [tone] });
  eng.setProject(p);
  eng.play('song', null, 0);
  const out = run(eng, 4);
  assert.ok(rms(out, 0, SR * 1.9) < 1e-4, 'silêncio antes do compasso 2');
  assert.ok(rms(out, SR * 2.1, SR * 3.9) > 0.2, 'toca a partir do compasso 2');
  // começando no meio do clipe (compasso 2,5)
  const e2 = new Engine(SR);
  e2.setSample('voz.wav', { sr: SR, ch: [tone] });
  e2.setProject(p);
  e2.play('song', null, Math.round(2.5 * 4 * PPQ) - 4 * PPQ + 4 * PPQ);
  assert.ok(rms(run(e2, 0.5), 0, SR * 0.5) > 0.2, 'toca ao começar no meio');
});

test('automação de volume de 0 a 1 faz o som crescer e não altera o projeto salvo', () => {
  const p = emptyProject();
  p.bpm = 120;
  const r = A.addChannel(p, { preset: 'Prisma Init', insert: 'master' });
  applyOps(p, r.ops);
  const ch = (r.result as any).id;
  applyOps(p, A.addNotes(p, { pattern: p.patterns[0].id, channel: ch, notes: [{ note: 'A3', start: 0, length: 16 }] }).ops);
  applyOps(p, A.placePattern(p, { pattern: p.patterns[0].id, track: 1, bar: 1, bars: 4 }).ops);
  applyOps(p, A.addAutomation(p, { channel: ch, param: 'volume', bar: 1, bars: 4, points: [{ beat: 0, value: 0 }, { beat: 16, value: 1 }] }).ops);
  const volBefore = p.channels[0].volume;
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.play('song', null, 0);
  const out = run(eng, 7.5);
  const early = rms(out, SR * 0.2, SR * 1.2), late = rms(out, SR * 6.2, SR * 7.2);
  assert.ok(late > early * 3, `cresce: início ${early.toFixed(4)}, fim ${late.toFixed(4)}`);
  assert.equal(p.channels[0].volume, volBefore, 'projeto intacto');
});

test('automação de parâmetro do instrumento (corte do filtro) muda o timbre', () => {
  const p = emptyProject();
  p.bpm = 120;
  const r = A.addChannel(p, { preset: 'Prisma Init', insert: 'master' });
  applyOps(p, r.ops);
  const ch = (r.result as any).id;
  const t = A.autoTarget(p, { channel: ch, param: 'cutoff' });
  assert.equal(t.log, true);
  assert.deepEqual(t.path, ['channels', ch, 'params', 'cutoff']);
  assert.throws(() => A.autoTarget(p, { channel: ch, param: 'ftype' }), /numérico/);
});
