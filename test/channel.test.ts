import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject, type Project } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import { detectPitch } from '../src/core/pitch.ts';

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
const midiOf = (x: Float32Array) => detectPitch(x, SR, 40, 3000)!.midi;
/** Último instante (s) com sinal acima do limiar. */
function soundEnd(x: Float32Array, thr = 0.01) {
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > thr) return i / SR;
  return 0;
}
function proj(): Project {
  return emptyProject();
}
function add(p: Project, args: any) {
  const r = A.addChannel(p, { ...args, insert: 'master' });
  applyOps(p, r.ops);
  return (r.result as any).id as string;
}

test('ajuste fino no Prisma: +50 cents', () => {
  const p = proj();
  const ch = add(p, { preset: 'Prisma Init' });
  applyOps(p, A.updateChannel(p, { channel: ch, fine: 50 }).ops);
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.liveOn(ch, 60, 0.9);
  const m = midiOf(run(eng, 1).subarray(4410));
  assert.ok(Math.abs(m - 60.5) < 0.08, `soou ${m.toFixed(3)}`);
});

test('nota raiz D4: tocar D4 soa como C4', () => {
  const p = proj();
  const ch = add(p, { preset: 'Prisma Init' });
  applyOps(p, A.updateChannel(p, { channel: ch, root: 'D4' }).ops);
  assert.equal(p.channels[0].pitch, -2);
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.liveOn(ch, 62, 0.9);
  const m = midiOf(run(eng, 1).subarray(4410));
  assert.ok(Math.abs(m - 60) < 0.08, `soou ${m.toFixed(3)}`);
});

test('sampler: ajuste fino preserva o andamento no modo stretch e encurta no resample', () => {
  // sample sintético: A3 (220 Hz) por 1 s
  const len = SR;
  const sig = new Float32Array(len);
  for (let i = 0; i < len; i++) sig[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR) * Math.min(1, (len - i) / 200);
  const measure = (mode: 'stretch' | 'resample') => {
    const p = proj();
    const ch = add(p, { type: 'sampler', params: { sample: 'tom.wav', oneshot: true, keytrack: true, root: 57 } });
    applyOps(p, A.updateChannel(p, { channel: ch, fine: 100, pitchMode: mode }).ops);
    const eng = new Engine(SR);
    eng.setSample('tom.wav', { sr: SR, ch: [sig, sig] });
    eng.setProject(p);
    eng.liveOn(ch, 57, 1);
    const out = run(eng, 1.5);
    return { midi: midiOf(out.subarray(8000)), end: soundEnd(out) };
  };
  const st = measure('stretch');
  const rs = measure('resample');
  assert.ok(Math.abs(st.midi - 58) < 0.15, `stretch soou ${st.midi.toFixed(3)}`);
  assert.ok(Math.abs(rs.midi - 58) < 0.08, `resample soou ${rs.midi.toFixed(3)}`);
  assert.ok(Math.abs(st.end - 1.0) < 0.05, `stretch durou ${st.end.toFixed(3)} s (esperado ~1,0)`);
  assert.ok(Math.abs(rs.end - 1 / Math.pow(2, 1 / 12)) < 0.02, `resample durou ${rs.end.toFixed(3)} s (esperado ~0,944)`);
});

test('efeito do canal: o reverb continua soando depois da nota', () => {
  const p = proj();
  const ch = add(p, { preset: 'Prisma Pluck' });
  applyOps(p, A.addChannelEffect(p, { channel: ch, type: 'reverb', mix: 0.6, params: { size: 0.9 } }).ops);
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.liveOn(ch, 60, 0.9, 48);
  const out = run(eng, 3);
  const dry = (() => {
    const q = proj();
    const c2 = add(q, { preset: 'Prisma Pluck' });
    const e2 = new Engine(SR);
    e2.setProject(q);
    e2.liveOn(c2, 60, 0.9, 48);
    return run(e2, 3);
  })();
  assert.ok(soundEnd(out, 0.002) > soundEnd(dry, 0.002) + 0.3, `com reverb termina em ${soundEnd(out, 0.002).toFixed(2)} s, seco em ${soundEnd(dry, 0.002).toFixed(2)} s`);
});

test('teclas acesas do canal observado', () => {
  const p = proj();
  const ch = add(p, { preset: 'Prisma Init' });
  applyOps(p, A.updateChannel(p, { channel: ch, root: 'D4' }).ops); // transposição não muda a tecla mostrada
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.watch(ch);
  eng.liveOn(ch, 64, 0.9);
  run(eng, 0.05);
  assert.deepEqual(eng.status().lit, [64]);
  eng.liveOff(ch, 64);
  run(eng, 0.05);
  assert.deepEqual(eng.status().lit, []);
});
