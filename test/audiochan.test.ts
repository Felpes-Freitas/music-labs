// Áudios como canais do rack: canal criado sozinho (com insert e pattern-grupo), clipes do
// mesmo arquivo no mesmo canal, tracks criadas conforme o uso e o som passando pelo canal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject, PPQ, type Project } from '../src/core/model.ts';
import { applyOps, ins, set } from '../src/core/ops.ts';
import { completeOps, channelInPattern } from '../src/core/audiochan.ts';

const settle = (p: Project) => applyOps(p, completeOps(p));
const clip = (id: string, sample: string, track = 0, pos = 0) => ({ id, kind: 'audio', track, pos, len: PPQ * 8, patternId: '', offset: 0, sample, startSec: 0 });

test('clipe de áudio novo ganha canal de áudio, insert com o nome e pattern-grupo', () => {
  let p = emptyProject();
  p.tracks = [];
  p = applyOps(p, [ins(['audios'], { id: 'au1', name: 'Guitarra base', path: '/g.wav', original: '/g.wav' }), ins(['clips'], clip('k1', '/g.wav', 20))]);
  p = settle(p);
  const ch = p.channels.find((c) => c.type === 'audio')!;
  assert.equal(ch.name, 'Guitarra base');
  assert.equal(p.clips[0].channel, ch.id);
  assert.equal(p.audios![0].channel, ch.id);
  assert.ok(ch.insert > 0, 'vai para um insert livre');
  assert.equal(p.mixer[ch.insert].name, 'Guitarra base');
  const pat = p.patterns.find((x) => x.name === 'Guitarra base')!;
  assert.ok(channelInPattern(pat, ch.id), 'pattern-grupo com o canal');
  assert.equal(p.tracks.length, 21, 'tracks até a usada (a playlist mostra infinitas)');
  assert.equal(completeOps(p).length, 0, 'estável: nada mais a completar');
  // outro clipe do mesmo arquivo usa o mesmo canal
  p = settle(applyOps(p, [ins(['clips'], clip('k2', '/g.wav', 1, PPQ * 16))]));
  assert.equal(p.clips[1].channel, ch.id);
  assert.equal(p.channels.filter((c) => c.type === 'audio').length, 1);
});

test('projeto antigo: clipe com insert próprio mantém o insert no canal novo', () => {
  let p = emptyProject();
  p.clips.push({ ...clip('k1', '/v.wav'), insert: 5 } as any);
  p = settle(p);
  assert.equal(p.channels[0].insert, 5);
  assert.equal(p.channels[0].name, 'v');
});

const SR = 48000;
function render(p: Project) {
  const eng = new Engine(SR);
  const n = SR; // 1 s de seno
  const x = new Float32Array(n * 2);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.05) * 0.5;
  eng.setSample('/s.wav', { sr: SR, ch: [x] });
  eng.setProject(p);
  eng.play('song', null, 0);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  let e = 0;
  for (let f = 0; f < n; f += BLOCK) {
    eng.process(bl, br, BLOCK);
    for (let i = 0; i < BLOCK; i++) e += bl[i] * bl[i];
  }
  return Math.sqrt(e / n);
}

test('o clipe toca pelo canal: volume e mute do canal valem', () => {
  let p = emptyProject();
  p.bpm = 120;
  p = settle(applyOps(p, [ins(['clips'], clip('k1', '/s.wav'))]));
  const ch = p.channels[0];
  const on = render(p);
  assert.ok(on > 0.05, `toca: ${on}`);
  const half = render(applyOps(p, [set(['channels', ch.id, 'volume'], ch.volume / 2)]));
  assert.ok(Math.abs(half / on - 0.5) < 0.05, `metade do volume: ${half / on}`);
  assert.ok(render(applyOps(p, [set(['channels', ch.id, 'mute'], true)])) < 1e-4, 'mute cala');
});
