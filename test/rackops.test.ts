import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, STEP, type Project } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import * as S from '../src/core/studio.ts';
import { PRESETS } from '../src/core/registry.ts';

const run = (p: Project, fn: any, args: any) => {
  const r = fn(p, args);
  applyOps(p, r.ops);
  return r.result;
};

test('preencher: a cada N steps, com offset, mantendo a nota do canal', () => {
  const p = emptyProject();
  run(p, A.addChannel, { type: 'drum', name: 'Hat' });
  const pat = p.patterns[0];
  run(p, A.updatePattern, { pattern: pat.id, lengthBars: 1 });
  run(p, A.addNotes, { pattern: pat.id, channel: 'Hat', notes: [{ note: 'F#4', start: 0 }] });
  run(p, S.fillSteps, { pattern: pat.id, channel: 'Hat', every: 2 });
  const notes = pat.notes[p.channels[0].id];
  assert.equal(notes.length, 8);
  assert.ok(notes.every((n) => n.key === 66 && n.pos % (2 * STEP) === 0));
  run(p, S.fillSteps, { pattern: pat.id, channel: 'Hat', every: 4, offset: 2 });
  assert.deepEqual(pat.notes[p.channels[0].id].map((n) => n.pos / STEP), [2, 6, 10, 14]);
});

test('substituir instrumento mantém notas, efeitos, insert e volume', () => {
  const p = emptyProject();
  run(p, A.addChannel, { type: 'drum', name: 'Clap', insert: 5, volumeDb: -4.8 });
  run(p, A.addChannelEffect, { channel: 'Clap', type: 'reverb' });
  const ch = p.channels[0];
  run(p, A.addNotes, { pattern: p.patterns[0].id, channel: 'Clap', notes: [{ note: 'D4', start: 1 }, { note: 'D4', start: 3 }] });
  run(p, A.addPattern, { name: 'B' });
  run(p, A.addNotes, { pattern: 'B', channel: 'Clap', notes: [{ note: 'D4', start: 1 }] });
  // troca por um sample de bateria (um tiro): a raiz vira a nota que o canal toca (D4)
  const r = run(p, S.replaceInstrument, { channel: 'Clap', type: 'sampler', params: { sample: '/x/clap.wav', oneshot: true, keytrack: true }, name: 'FL Clap' });
  const c = p.channels[0];
  assert.equal(c.id, ch.id);
  assert.equal(c.type, 'sampler');
  assert.equal(c.name, 'FL Clap');
  assert.equal(c.insert, 5);
  assert.equal(Math.round(20 * Math.log10(c.volume) * 10) / 10, -4.8);
  assert.equal(c.effects?.length, 1);
  assert.equal(c.pitch, 60 - 62);
  assert.equal(r.root, 'D4');
  assert.equal(p.patterns[0].notes[c.id].length, 2);
  assert.equal(p.patterns[1].notes[c.id].length, 1);
  // por um preset melódico: as notas continuam e a raiz não muda
  run(p, S.replaceInstrument, { channel: c.id, preset: Object.keys(PRESETS)[0], name: 'Lead' });
  assert.equal(p.patterns[0].notes[c.id].length, 2);
  assert.equal(p.channels[0].pitch, -2);
});
