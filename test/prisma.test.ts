import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import { detectPitch } from '../src/core/pitch.ts';
import { PRESETS } from '../src/core/registry.ts';

function setup(preset: string) {
  const eng = new Engine(44100);
  const p = emptyProject();
  const r = A.addChannel(p, { preset, insert: 'master' });
  applyOps(p, r.ops);
  eng.setProject(p);
  return { eng, ch: (r.result as any).id as string };
}
function run(eng: Engine, seconds: number) {
  const n = Math.round(44100 * seconds);
  const L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  for (let f = 0; f < n; f += BLOCK) {
    eng.process(bl, br, BLOCK);
    L.set(bl.subarray(0, Math.min(BLOCK, n - f)), f);
    R.set(br.subarray(0, Math.min(BLOCK, n - f)), f);
  }
  return [L, R];
}
const rms = (x: Float32Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

test('Prisma: afinação, sustentação e release', () => {
  const { eng, ch } = setup('Prisma Init');
  eng.liveOn(ch, 60, 0.9);
  const [L] = run(eng, 1.2);
  const pr = detectPitch(L.subarray(4410), 44100)!;
  assert.ok(Math.abs(pr.midi - 60) < 0.3, `C4 soou como ${pr.midi.toFixed(2)}`);
  assert.ok(rms(L, 44100, 52920) > 0.01, 'sustenta enquanto a tecla está pressionada');
  eng.liveOff(ch, 60);
  const [L2] = run(eng, 1);
  assert.ok(rms(L2, 30000, 44100) < 1e-4, 'para depois do release');
});

test('Prisma: todos os presets geram som finito e sem clipar', () => {
  for (const [name, pr] of Object.entries(PRESETS)) {
    if (pr.type !== 'prisma') continue;
    const { eng, ch } = setup(name);
    for (const k of [48, 55, 60, 64]) eng.liveOn(ch, k, 0.8);
    const [L, R] = run(eng, 1.5);
    let peak = 0;
    for (let i = 0; i < L.length; i++) {
      assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${name}: amostra inválida`);
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    assert.ok(peak > 0.02, `${name}: silencioso (${peak})`);
    assert.ok(peak < 4, `${name}: alto demais (${peak})`);
  }
});

test('Prisma: custo de CPU (acorde de 6 notas, supersaw de 8 vozes)', () => {
  // Mede relativo a uma nota simples na mesma hora: notebook na bateria pode
  // estar com a CPU 6x mais lenta, e o teste não deve depender disso.
  const time = (preset: string, keys: number[]) => {
    const { eng, ch } = setup(preset);
    for (const k of keys) eng.liveOn(ch, k, 0.8);
    const t = performance.now();
    run(eng, 3);
    return performance.now() - t;
  };
  const one = time('Prisma Init', [60]);
  const heavy = time('Prisma Supersaw', [48, 52, 55, 60, 64, 67]);
  console.log(`nota simples: ${((one / 3000) * 100).toFixed(1)}% de um núcleo; acorde pesado: ${((heavy / 3000) * 100).toFixed(1)}% (${(heavy / one).toFixed(1)}x)`);
  assert.ok(heavy / one < 25, `acorde pesado custa ${(heavy / one).toFixed(1)}x uma nota simples`);
});
