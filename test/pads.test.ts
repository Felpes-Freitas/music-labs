import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject, PPQ } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import { PAD_BASE, parsePads, stringifyPads, padIndex, padKey, padColor, channelSamples, PAD_ROW_COLORS } from '../src/core/pads.ts';

const SR = 48000;
function hit(key: number, pads?: string) {
  const p = emptyProject();
  const r = A.addChannel(p, { type: 'pads', name: 'Pads', ...(pads ? { params: { pads } } : {}) });
  applyOps(p, r.ops);
  const ch = (r.result as { id: string }).id;
  p.patterns[0].notes[ch] = [{ id: 'n', key, pos: 0, len: PPQ / 2, vel: 0.9 }];
  const eng = new Engine(SR);
  eng.setProject(p);
  eng.play('pattern', p.patterns[0].id, 0);
  const out = new Float32Array(SR / 2);
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  for (let f = 0; f < out.length; f += BLOCK) {
    eng.process(L, R, BLOCK);
    out.set(L.subarray(0, Math.min(BLOCK, out.length - f)), f);
  }
  return out;
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

test('kit básico: cada pad toca o seu som; fora dos pads, silêncio', () => {
  const kick = hit(PAD_BASE), snare = hit(PAD_BASE + 1), hat = hit(PAD_BASE + 3);
  assert.ok(rms(kick) > 0.01 && rms(snare) > 0.01 && rms(hat) > 0.003, `${rms(kick)} ${rms(snare)} ${rms(hat)}`);
  // sons diferentes: correlação baixa entre kick e snare
  let c = 0;
  for (let i = 0; i < kick.length; i++) c += kick[i] * snare[i];
  assert.ok(Math.abs(c / (rms(kick) * rms(snare) * kick.length)) < 0.5);
  assert.equal(rms(hit(60)), 0);
  assert.equal(rms(hit(PAD_BASE - 1)), 0);
});

test('pad vazio não toca; ganho e afinação por pad', () => {
  const pads = parsePads(undefined);
  pads[0] = { name: 'Kick', type: 'drum', params: { kind: 'kick' } };
  const s = stringifyPads(pads);
  assert.ok(rms(hit(PAD_BASE, s)) > 0.01);
  assert.equal(rms(hit(PAD_BASE + 1, s)), 0);
  pads[0] = { ...pads[0]!, gain: -12 };
  const quiet = rms(hit(PAD_BASE, stringifyPads(pads)));
  assert.ok(quiet < rms(hit(PAD_BASE, s)) * 0.4, 'ganho -12 dB');
});

test('grade: tecla, cor e índice batem com a tela', () => {
  assert.equal(padIndex(3, 0), 0); // embaixo à esquerda = pad 1
  assert.equal(padKey(0), 'z');
  assert.equal(padKey(padIndex(0, 0)), '1'); // em cima à esquerda
  assert.equal(padColor(padIndex(0, 2)), PAD_ROW_COLORS[0]);
  const pads = parsePads(undefined);
  pads[5] = { name: 'x', sample: '/a/b.wav' };
  assert.deepEqual(channelSamples({ type: 'pads', params: { pads: stringifyPads(pads) } }), ['/a/b.wav']);
});

import * as S from '../src/core/studio.ts';

test('setPad: escolhe som, renomeia, ganho, limpa e troca o kit', () => {
  const p = emptyProject();
  applyOps(p, A.addChannel(p, { type: 'pads', name: 'Pads' }).ops);
  const ch = p.channels[0];
  const run = (args: any) => {
    const r = S.setPad(p, { channel: 'Pads', ...args });
    applyOps(p, r.ops);
    return r.result as any;
  };
  const r = run({ pad: 16, sample: '/x/Grv Clap 01.wav', gain: -6 });
  assert.equal(r.note, 'D#3');
  let pads = parsePads(p.channels[0].params.pads);
  assert.equal(pads[15]?.name, 'Grv Clap 01');
  assert.equal(pads[15]?.gain, -6);
  run({ pad: 16, name: 'Palma', tune: 2 });
  pads = parsePads(ch.params.pads);
  assert.deepEqual([pads[15]?.name, pads[15]?.tune, pads[15]?.sample], ['Palma', 2, '/x/Grv Clap 01.wav']);
  run({ pad: 2, type: 'drum', params: { kind: 'rim' } });
  assert.equal(parsePads(ch.params.pads)[1]?.type, 'drum');
  run({ pad: 2, clear: true });
  assert.equal(parsePads(ch.params.pads)[1], null);
  run({ kit: 'break' });
  assert.equal(parsePads(ch.params.pads)[0]?.name, 'Kick');
  assert.throws(() => S.setPad(p, { channel: 'Pads', pad: 17, name: 'x' }));
  applyOps(p, A.addChannel(p, { type: 'synth', name: 'Lead' }).ops);
  assert.throws(() => S.setPad(p, { channel: 'Lead', pad: 1, name: 'x' }), /não é um Soundpad/);
});

test('preencher num Soundpad sem notas usa o pad 1 (C2)', () => {
  const p = emptyProject();
  applyOps(p, A.addChannel(p, { type: 'pads', name: 'Pads' }).ops);
  applyOps(p, S.fillSteps(p, { pattern: p.patterns[0].id, channel: 'Pads', every: 4 }).ops);
  assert.ok(p.patterns[0].notes[p.channels[0].id].every((n) => n.key === PAD_BASE));
});
