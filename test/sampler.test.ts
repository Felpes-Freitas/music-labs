import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import { detectPitch } from '../src/core/pitch.ts';
import { getSet, samplerParamsFor } from '../src/server/sampleset.ts';
import { loadSample, FL_DIR } from '../src/server/samples.ts';

const INST = `${FL_DIR}/Data/Patches/Packs/Instruments`;
const DRUMS = `${FL_DIR}/Data/Patches/Packs/Drums`;
const haveFL = existsSync(INST);

async function engineWith(sample: string, given: Record<string, unknown> = {}) {
  const sr = 44100;
  const eng = new Engine(sr);
  const { info, params } = await samplerParamsFor(sample, given);
  if (info.kind === 'set') {
    const b = await getSet(info.path);
    b.data.forEach((d, i) => eng.setSample(`${info.path}#${i}`, d));
    eng.setSampleSet(String(params.sample), b.set);
  } else eng.setSample(sample, await loadSample(sample));
  const p = emptyProject();
  const r = A.addChannel(p, { type: 'sampler', params, insert: 'master' });
  applyOps(p, r.ops);
  eng.setProject(p);
  return { eng, ch: (r.result as any).id as string, info, params };
}

function run(eng: Engine, seconds: number) {
  const n = Math.round(44100 * seconds);
  const L = new Float32Array(n);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  for (let f = 0; f < n; f += BLOCK) {
    eng.process(bl, br, BLOCK);
    L.set(bl.subarray(0, Math.min(BLOCK, n - f)), f);
  }
  return L;
}
const rms = (x: Float32Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

test('cordas: segura enquanto a tecla está pressionada, com loop, e para ao soltar', { skip: !haveFL }, async () => {
  const { eng, ch, info, params } = await engineWith(`${INST}/Orchestral/Strings Section`);
  assert.equal(info.kind, 'set');
  assert.equal(params.oneshot, false);
  assert.equal(params.loop, true);
  eng.liveOn(ch, 60, 0.9);
  const held = run(eng, 6); // o sample tem 3 s: só continua por causa do loop
  const late = rms(held, 44100 * 5, 44100 * 6);
  assert.ok(late > 0.01, `ainda soando aos 5-6 s (rms ${late.toFixed(4)})`);
  // afinação: C4 tem que soar ~261,6 Hz
  const pr = detectPitch(held.subarray(44100 * 1), 44100)!;
  assert.ok(Math.abs(pr.midi - 60) < 0.5, `C4 soou como MIDI ${pr.midi.toFixed(2)}`);
  eng.liveOff(ch, 60);
  const after = run(eng, 1.5);
  assert.ok(rms(after, 44100, 44100 * 1.5) < 1e-4, 'parou depois do release');
});

test('piano: segura e solta (sem loop), e A4 soa em 440 Hz', { skip: !haveFL }, async () => {
  const { eng, ch, params } = await engineWith(`${INST}/Keyboard/Rhodes`);
  assert.equal(params.oneshot, false);
  eng.liveOn(ch, 69, 0.9);
  const held = run(eng, 1);
  const pr = detectPitch(held.subarray(4410), 44100)!;
  assert.ok(Math.abs(pr.midi - 69) < 0.5, `A4 soou como MIDI ${pr.midi.toFixed(2)}`);
  eng.liveOff(ch, 69);
  const after = run(eng, 1.5);
  assert.ok(rms(after, 44100, 44100 * 1.5) < 1e-4, 'parou depois do release');
});

test('bateria: one-shot toca o arquivo inteiro mesmo soltando a tecla na hora', { skip: !haveFL }, async () => {
  const { eng, ch, params } = await engineWith(`${DRUMS}/Kicks/808 Kick.wav`);
  assert.equal(params.oneshot, true);
  eng.liveOn(ch, 60, 0.9);
  eng.liveOff(ch, 60);
  const out = run(eng, 1.5);
  assert.ok(rms(out, 44100 * 0.5, 44100 * 1.0) > 0.005, 'o 808 continua depois de soltar');
});

test('arquivo sem metadado (pasta numerada de baixo): afinação detectada', { skip: !haveFL }, async () => {
  const { eng, ch } = await engineWith(`${INST}/Bass/Acoustic`);
  eng.liveOn(ch, 40, 0.9); // E2
  const held = run(eng, 1);
  const pr = detectPitch(held.subarray(4410), 44100, 25, 2000)!;
  assert.ok(Math.abs(pr.midi - 40) < 0.6, `E2 soou como MIDI ${pr.midi.toFixed(2)}`);
});
