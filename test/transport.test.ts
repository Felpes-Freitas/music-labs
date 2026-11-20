import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject, PPQ } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';

const SR = 48000;
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

test('loop fica na área selecionada', () => {
  const p = emptyProject();
  p.bpm = 120; // 1 tempo = 0,5 s; compasso = 2 s
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.setTransport({ region: [PPQ * 4, PPQ * 6], loopOn: true }); // compasso 2, dois tempos
  eng.play('song', null, PPQ * 4);
  run(eng, 2.2); // 2,2 s = 4,4 tempos: deu duas voltas na área de 2 tempos
  assert.ok(eng.loops >= 2, `voltas: ${eng.loops}`);
  assert.ok(eng.tick >= PPQ * 4 && eng.tick < PPQ * 6, `agulha dentro da área: ${eng.tick}`);
});

test('sem loop, a seleção só define de onde começa (a música segue)', () => {
  const p = emptyProject();
  p.bpm = 120;
  applyOps(p, A.placePattern(p, { pattern: p.patterns[0].id, track: 1, bar: 1, bars: 8 }).ops);
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.setTransport({ region: [PPQ * 4, PPQ * 6], loopOn: false });
  eng.play('song', null, PPQ * 4);
  run(eng, 2);
  assert.ok(eng.tick > PPQ * 6, `passou do fim da área: ${eng.tick}`);
});

test('contagem: 3 tempos só de metrônomo e depois a música anda', () => {
  const p = emptyProject();
  p.bpm = 120;
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.play('song', null, 0, 3);
  const x = run(eng, 1.4); // dentro da contagem (1,5 s)
  assert.equal(eng.tick, 0, 'a música não andou durante a contagem');
  assert.equal(eng.status().countIn, 1, 'falta 1 tempo');
  // três cliques: no começo de cada tempo (0; 0,5; 1,0 s)
  for (const t of [0.01, 0.51, 1.01]) assert.ok(rms(x, t * SR, (t + 0.02) * SR) > 0.05, `clique em ${t}s`);
  assert.ok(rms(x, 0.2 * SR, 0.45 * SR) < 1e-4, 'silêncio entre os cliques');
  run(eng, 0.5);
  assert.ok(eng.tick > 0 && eng.status().countIn === 0, 'depois da contagem a música começa');
});

test('metrônomo clica a cada tempo durante a música', () => {
  const p = emptyProject();
  p.bpm = 120;
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.setTransport({ metronome: true, loopOn: true });
  eng.play('song', null, 0);
  const x = run(eng, 1.2);
  for (const t of [0.01, 0.51, 1.01]) assert.ok(rms(x, t * SR, (t + 0.02) * SR) > 0.05, `clique em ${t}s`);
});

test('gravando sem área selecionada: não volta nem para no fim da música', () => {
  const p = emptyProject();
  p.bpm = 120;
  applyOps(p, A.placePattern(p, { pattern: p.patterns[0].id, track: 1, bar: 1, bars: 1 }).ops); // música de 1 compasso (2 s)
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.setTransport({ loopOn: true, region: null, endless: true });
  eng.play('song', null, 0);
  run(eng, 3);
  assert.ok(eng.playing && eng.tick > PPQ * 4 && eng.loops === 0, `seguiu em frente: tick ${eng.tick}, voltas ${eng.loops}`);
});

test('gravando com área e loop: volta na área', () => {
  const p = emptyProject();
  p.bpm = 120;
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.setTransport({ loopOn: true, region: [PPQ * 4, PPQ * 6], endless: true });
  eng.play('song', null, PPQ * 4);
  run(eng, 1.6);
  assert.ok(eng.loops >= 1 && eng.tick >= PPQ * 4 && eng.tick < PPQ * 6);
});

test('cada play tem um número e zera as voltas (gravação ignora status de plays antigos)', () => {
  const p = emptyProject();
  p.bpm = 120;
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.setTransport({ region: [0, PPQ * 2], loopOn: true });
  eng.play('song', null, 0, 0, 41);
  run(eng, 3.2); // 1 s por volta
  const old = eng.status();
  assert.equal(old.playId, 41);
  assert.ok(old.loops >= 3);
  eng.play('song', null, PPQ, 0, 42);
  const st = eng.status();
  assert.equal(st.playId, 42);
  assert.equal(st.loops, 0);
  eng.play('song', null, 0);
  assert.equal(eng.status().playId, 43); // sem número: o seguinte
});

for (const mode of ['pattern', 'song'] as const)
  test(`loop (${mode}): a nota no começo toca em toda volta`, () => {
    const p = emptyProject();
    p.bpm = 120; // compasso = 2 s
    const r = A.addChannel(p, { type: 'synth' });
    applyOps(p, r.ops);
    const ch = (r.result as { id: string }).id;
    const pat = p.patterns[0];
    pat.length = 16; // 1 compasso
    pat.notes[ch] = [{ id: 'n0', key: 60, pos: 0, len: PPQ / 2, vel: 0.9 }];
    if (mode === 'song') applyOps(p, A.placePattern(p, { pattern: pat.id, track: 1, bar: 1, bars: 1 }).ops);
    const eng = new Engine(SR);
    eng.setProject(p);
    eng.setTransport({ region: mode === 'song' ? [0, PPQ * 4] : null, loopOn: true });
    eng.play(mode, pat.id, 0);
    const x = run(eng, 8.2); // 4 voltas
    for (let k = 0; k < 4; k++) assert.ok(rms(x, (k * 2 + 0.02) * SR, (k * 2 + 0.2) * SR) > 0.01, `volta ${k + 1}: a nota do começo tocou`);
  });

test('loop com volta caindo bem no fim de um bloco: a nota do começo toca', () => {
  const p = emptyProject();
  // 125 BPM: 1 tempo = 0,48 s = 23040 amostras = 180 blocos de 128 — a volta cai no fim do bloco
  p.bpm = 125;
  const r = A.addChannel(p, { type: 'synth' });
  applyOps(p, r.ops);
  const ch = (r.result as { id: string }).id;
  const pat = p.patterns[0];
  pat.length = 4; // 1 tempo
  pat.notes[ch] = [{ id: 'n0', key: 60, pos: 0, len: PPQ / 4, vel: 0.9 }];
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.setTransport({ loopOn: true });
  eng.play('pattern', pat.id, 0);
  const beat = 0.48;
  const x = run(eng, beat * 4 + 0.1);
  for (let k = 0; k < 4; k++) assert.ok(rms(x, (k * beat + 0.01) * SR, (k * beat + 0.08) * SR) > 0.01, `volta ${k + 1}`);
});
