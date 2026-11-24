// Reamp: versão processada quando está em dia; bruto + pedais em tempo real quando a cadeia
// mudou ou há automação num pedal; prévias de gravação ("live:") não criam canal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject, PPQ, type Project } from '../src/core/model.ts';
import { applyOps, ins } from '../src/core/ops.ts';
import { completeOps, newAudioChannel } from '../src/core/audiochan.ts';
import { ampLive, ampSig, ampParamPath } from '../src/core/reamp.ts';

const SR = 48000;
function project(stale: boolean) {
  let p = emptyProject();
  p.bpm = 120;
  const amp = { chain: [], outGainDb: -6.0206 } as any; // metade do volume
  amp.sig = stale ? 'velha' : ampSig(amp);
  const nc = newAudioChannel(p, 'Guitarra 1', '/wet.wav', { amp });
  p = applyOps(p, nc.ops);
  p = applyOps(p, [ins(['audios'], { id: 'au', name: 'Guitarra 1', path: '/wet.wav', original: '/wet.wav', raw: '/raw.wav', channel: nc.id }), ins(['clips'], { id: 'k', kind: 'audio', track: 0, pos: 0, len: PPQ * 8, patternId: '', offset: 0, sample: '/wet.wav', channel: nc.id })]);
  return { p, ch: nc.id };
}
function level(p: Project) {
  const eng = new Engine(SR);
  const raw = new Float32Array(SR * 2).fill(0.4);
  const wet = new Float32Array(SR * 2).fill(0.1);
  eng.setSample('/raw.wav', { sr: SR, ch: [raw] });
  eng.setSample('/wet.wav', { sr: SR, ch: [wet] });
  eng.setProject(p);
  eng.play('song', null, 0);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  for (let i = 0; i < 20; i++) eng.process(l, r, BLOCK);
  return l[BLOCK - 1] / p.channels[0].volume; // tira o volume do canal (pan central ≈ 0,707)
}

test('em dia e sem automação: toca a versão processada', () => {
  const { p } = project(false);
  assert.equal(ampLive(p, p.channels[0]), false);
  const ref = level(project(true).p);
  // processada (0,1) contra o bruto pela cadeia (0,4 × −6 dB = 0,2): metade
  assert.ok(Math.abs(level(p) / ref - 0.5) < 0.02, `processada/tempo real: ${level(p) / ref}`);
});

test('cadeia mudou: toca o bruto pelos pedais (aqui, -6 dB) até refazer', () => {
  const { p } = project(true);
  assert.equal(ampLive(p, p.channels[0]), true);
  // mesmo projeto sem o bruto carregado tocaria a processada; aqui o bruto (0,4) a −6 dB
  const fresh = level(project(false).p);
  assert.ok(Math.abs(level(p) / fresh - 2) < 0.05, `bruto pela cadeia / processada: ${level(p) / fresh}`);
});

test('automação num pedal também liga o tempo real', () => {
  const { p, ch } = project(false);
  const q = applyOps(p, [ins(['clips'], { id: 'a', kind: 'auto', track: 1, pos: 0, len: PPQ * 4, patternId: '', offset: 0, target: { path: ampParamPath(ch, 'x', 'drive'), min: 0, max: 1, label: 'drive' }, points: [] })]);
  assert.equal(ampLive(q, q.channels[0]), true);
});

test('prévia de gravação ("live:") não ganha canal', () => {
  const p = applyOps(emptyProject(), [ins(['clips'], { id: 'k', kind: 'audio', track: 0, pos: 0, len: PPQ, patternId: '', offset: 0, sample: 'live:take1' })]);
  const ops = completeOps(p);
  assert.equal(ops.filter((o) => o.op === 'insert' && o.path[0] === 'channels').length, 0);
});

import { completeAll } from '../src/core/audiochan.ts';
test('projeto inundado de versões antigas: canais de prévia sem clipe somem ao abrir', () => {
  let p = emptyProject();
  const junk = newAudioChannel(p, 'take1', 'live:take1');
  p = applyOps(p, junk.ops);
  p = applyOps(p, [ins(['clips'], { id: 'k', kind: 'audio', track: 0, pos: 0, len: PPQ, patternId: '', offset: 0, sample: '/g.wav' })]);
  const r = completeAll(p, applyOps);
  assert.equal(r.project.channels.filter((c) => c.name === 'take1').length, 0, 'canal de prévia saiu');
  assert.equal(r.project.patterns.filter((x) => x.name === 'take1').length, 0, 'pattern-grupo vazio saiu');
  assert.equal(r.project.channels.filter((c) => c.type === 'audio').length, 1, 'o clipe real ganhou o canal dele');
});

// Gravações antigas guardavam os pedais sem id: na engine todos viravam um só (o último,
// aplicado várias vezes com os parâmetros dos outros) e o som estourava ao mexer na cadeia.
function noIds() {
  const { p, ch } = project(true);
  const chain = [
    { type: 'compressor', enabled: true, mix: 1, params: { threshold: -30, ratio: 17, makeup: 4 } },
    { type: 'cab', enabled: true, mix: 1, params: { level: 12 } },
    { type: 'reverb', enabled: true, mix: 0.3, params: {} },
  ];
  p.channels[0].amp = { chain: chain as any, outGainDb: 0, sig: 'velha' };
  return { p, ch };
}
test('pedais sem id: tempo real não estoura (cada pedal com o seu estado)', () => {
  const { p } = noIds();
  const eng = new Engine(SR);
  const raw = new Float32Array(SR * 2);
  for (let i = 0; i < raw.length; i++) raw[i] = 0.3 * Math.sin((2 * Math.PI * 196 * i) / SR);
  eng.setSample('/raw.wav', { sr: SR, ch: [raw] });
  eng.setSample('/wet.wav', { sr: SR, ch: [raw] });
  eng.setProject(p);
  eng.play('song', null, 0);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let peak = 0;
  for (let i = 0; i < 400; i++) {
    eng.process(l, r, BLOCK);
    for (const v of l) peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(Number.isFinite(peak) && peak < 4, `pico ${peak}`);
});
test('pedais sem id ganham id ao abrir/editar o projeto', () => {
  const { p } = noIds();
  const fixed = completeAll(p, applyOps).project.channels[0].amp!.chain;
  assert.equal(new Set(fixed.map((e) => e.id)).size, 3);
  assert.ok(fixed.every((e) => e.id));
});
