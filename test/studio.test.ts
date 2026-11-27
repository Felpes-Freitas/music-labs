import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, PPQ, type Project } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import * as S from '../src/core/studio.ts';

const BAR = PPQ * 4;
type Fn = (p: Project, a: any) => { ops: any[]; result?: any };
const run = (p: Project, fn: Fn, args: any) => {
  const r = fn(p, args);
  applyOps(p, r.ops);
  return r.result;
};

/** O projeto da conversa: Prisma com efeitos, Pattern 1 de 4 compassos e um wobble no corte. */
function base() {
  const p = emptyProject();
  p.bpm = 120;
  const ch = run(p, A.addChannel, { type: 'prisma', name: 'Prisma', insert: 3 });
  run(p, A.addChannelEffect, { channel: 'Prisma', type: 'distortion', params: { drive: 6 }, mix: 0.13 });
  run(p, A.addChannelEffect, { channel: 'Prisma', type: 'reverb', mix: 0.34 });
  run(p, A.updateInsert, { insert: 1, name: 'Harp' });
  run(p, A.updatePattern, { pattern: p.patterns[0].id, name: 'Pattern 1', lengthBars: 4 });
  run(p, A.addChords, { pattern: 'Pattern 1', channel: 'Prisma', chords: ['F', 'G', 'C', 'Am'], beatsPerChord: 4 });
  run(p, A.placePattern, { pattern: 'Pattern 1', track: 1, bar: 1, bars: 4 });
  run(p, S.automate, { channel: 'Prisma', param: 'cutoff', bar: 1, bars: 4, track: 2, fn: { preset: 'wobble', min: 600, max: 6000 } });
  return { p, ch };
}

test('o pedido "intro 2x + verso mais distorcido" sem nenhum código', () => {
  const { p } = base();
  // lixo: insert "Harp" sem uso volta ao padrão
  run(p, S.resetInsert, { insert: 1 });
  assert.equal(p.mixer[1].name, 'Insert 1');
  // intro duas vezes: o trecho 1-4 inteiro (pattern + automação com a função) no compasso 5
  run(p, S.copySection, { fromBar: 1, toBar: 4, atBar: 5 });
  const autos = p.clips.filter((c) => c.kind === 'auto');
  assert.equal(autos.length, 2);
  assert.equal(autos[1].pos, 4 * BAR);
  assert.equal(autos[1].gen?.preset, 'wobble');
  assert.equal(p.clips.filter((c) => c.patternId && c.kind !== 'auto').length, 2);
  // verso: canal igual (efeitos inclusos) com outro corte, no próprio insert
  const dup = run(p, S.duplicateChannel, { channel: 'Prisma', name: 'Prisma Verso', insert: 'auto', params: { cutoff: 4500 } });
  const verso = p.channels.find((c) => c.id === dup.id)!;
  assert.equal(verso.effects?.length, 2);
  assert.notEqual(verso.effects![0].id, p.channels[0].effects![0].id);
  assert.equal(verso.params.cutoff, 4500);
  assert.equal(p.mixer[verso.insert].name, 'Prisma Verso');
  run(p, A.updateChannelEffect, { channel: 'Prisma Verso', effect: 'distortion', params: { mode: 'tube', drive: 18 }, mix: 0.55 });
  assert.equal(p.channels[0].effects![0].params.drive, 6, 'o original não muda');
  // notas: cópia do Pattern 1 para um pattern novo no canal novo
  const cn = run(p, S.copyNotes, { fromPattern: 'Pattern 1', toPattern: 'Verso', toChannel: 'Prisma Verso' });
  assert.ok(cn.created && cn.notes > 0);
  const vp = p.patterns.find((x) => x.name === 'Verso')!;
  assert.equal(vp.notes[verso.id].length, p.patterns[0].notes[p.channels[0].id].length);
  run(p, A.placePattern, { pattern: 'Verso', track: 3, bar: 9, bars: 4 });
  assert.equal(Math.max(...p.clips.map((c) => c.pos + c.len)) / BAR, 12);
});

test('edit_clips: mover, cortar o começo (áudio, pattern, automação), redimensionar e duplicar', () => {
  const { p } = base();
  const auto = p.clips.find((c) => c.kind === 'auto')!;
  const pat = p.clips.find((c) => c.kind !== 'auto')!;
  // cortar 1 compasso do começo do pattern: anda o início e o offset acompanha
  run(p, S.editClips, { clipIds: [pat.id], trimStartBars: 1 });
  const pc = p.clips.find((c) => c.id === pat.id)!;
  assert.deepEqual([pc.pos, pc.len, pc.offset], [BAR, 3 * BAR, BAR]);
  // automação de função: redimensionar recalcula (wobble continua com o mesmo período)
  const before = auto.points!.length;
  run(p, S.editClips, { automation: 'corte', lengthBars: 8 });
  const ac = p.clips.find((c) => c.id === auto.id)!;
  assert.equal(ac.len, 8 * BAR);
  assert.ok(ac.points!.length > 1.8 * before, `${before} → ${ac.points!.length}`);
  // duplicar o grupo logo depois, 2 vezes
  const r = run(p, S.editClips, { kind: 'auto', duplicate: { times: 2 } });
  assert.equal(r.copies.length, 2);
  const starts = p.clips.filter((c) => c.kind === 'auto').map((c) => c.pos / BAR).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 8, 16]);
  // mover para outra track e apagar
  run(p, S.editClips, { kind: 'auto', fromBar: 9, toTrack: 5 });
  assert.equal(p.clips.filter((c) => c.track === 4).length, 2);
  run(p, S.editClips, { track: 5, remove: true });
  assert.equal(p.clips.filter((c) => c.kind === 'auto').length, 1);
});

test('insert_bars e delete_bars abrem e fecham espaço', () => {
  const { p } = base();
  run(p, S.copySection, { fromBar: 1, toBar: 4, atBar: 5 });
  run(p, S.insertBars, { atBar: 5, bars: 2 });
  assert.deepEqual(p.clips.filter((c) => c.kind !== 'auto').map((c) => c.pos / BAR).sort(), [0, 6]);
  run(p, S.deleteBars, { fromBar: 5, toBar: 6 });
  assert.deepEqual(p.clips.filter((c) => c.kind !== 'auto').map((c) => c.pos / BAR).sort(), [0, 4]);
  // apagar no meio de um clipe corta ele
  run(p, S.deleteBars, { fromBar: 3, toBar: 3 });
  const first = p.clips.find((c) => c.kind !== 'auto' && c.pos === 0)!;
  assert.equal(first.len, 2 * BAR + 0 * BAR + BAR, 'atravessava: perdeu 1 compasso');
});

test('copy_section com insert abre espaço antes de copiar', () => {
  const { p } = base();
  run(p, A.placePattern, { pattern: 'Pattern 1', track: 1, bar: 5, bars: 4 });
  run(p, S.copySection, { fromBar: 1, toBar: 4, atBar: 5, insert: true, tracks: [1] });
  assert.deepEqual(p.clips.filter((c) => c.kind !== 'auto').map((c) => c.pos / BAR).sort((a, b) => a - b), [0, 4, 8]);
});

test('automação do BPM com função e edição depois', () => {
  const { p } = base();
  const r = run(p, S.automate, { param: 'bpm', bar: 9, bars: 4, fn: { preset: 'riser', from: 120, to: 140 } });
  const c = p.clips.find((x) => x.id === r.clip)!;
  assert.deepEqual(c.target!.path, ['bpm']);
  assert.equal(c.points!.length, 2);
  assert.ok(Math.abs(S.fromNorm(c.target!, c.points![0].v) - 120) < 0.01 && Math.abs(S.fromNorm(c.target!, c.points![1].v) - 140) < 0.01);
  // vira um seno entre 118 e 122 a cada compasso
  const e = run(p, S.editAutomation, { clip: c.id, fn: { preset: 'sine', min: 118, max: 122, period: 4, periodEnd: 4 } });
  assert.equal(e.fn.kind, 'lfo');
  assert.ok(Math.abs(e.fn.min - 118) < 0.01 && Math.abs(e.fn.max - 122) < 0.01);
  // pontos à mão: vira personalizada; custom:false volta à função
  run(p, S.editAutomation, { clip: c.id, points: [{ beat: 0, value: 100 }, { beat: 16, value: 130 }] });
  assert.equal(p.clips.find((x) => x.id === c.id)!.gen?.custom, true);
  run(p, S.editAutomation, { clip: c.id, custom: false });
  const back = p.clips.find((x) => x.id === c.id)!;
  assert.equal(back.gen?.custom, false);
  assert.ok(back.points!.length > 2);
  // a leitura mostra a função em BPM
  const d = S.clipsDetail(p, { automation: 'bpm' })[0] as any;
  assert.equal(d.fn.kind, 'lfo');
});

test('transform_notes: legato, strum, chop, reverse, oitava e filtros', () => {
  const p = emptyProject();
  run(p, A.addChannel, { type: 'synth', name: 'S' });
  const pat = p.patterns[0].id;
  run(p, A.addNotes, { pattern: pat, channel: 'S', notes: [{ note: 'C4', start: 0, length: 0.5 }, { note: 'E4', start: 0, length: 0.5 }, { note: 'G4', start: 2, length: 1 }] });
  const notes = () => p.patterns[0].notes[p.channels[0].id].slice().sort((a, b) => a.pos - b.pos || a.key - b.key);
  run(p, A.transformNotes, { pattern: pat, legato: true, toBeat: 2 });
  assert.deepEqual(notes().slice(0, 2).map((n) => n.len), [2 * PPQ, 2 * PPQ]);
  run(p, A.transformNotes, { pattern: pat, strum: 0.25, toBeat: 1 });
  assert.deepEqual(notes().slice(0, 2).map((n) => n.pos), [0, PPQ / 4]);
  run(p, A.transformNotes, { pattern: pat, lowNote: 'G4', chop: 0.25 });
  assert.equal(notes().filter((n) => n.key === 67).length, 4);
  run(p, A.transformNotes, { pattern: pat, lowNote: 'G4', addOctave: 1 });
  assert.equal(notes().filter((n) => n.key === 79).length, 4);
  const before = notes().length;
  run(p, A.transformNotes, { pattern: pat, reverse: true });
  assert.equal(notes().length, before);
  assert.ok(notes()[0].key === 67 || notes()[0].key === 79, 'o fim virou começo');
});

test('lista de áudios: add, renomear, colocar e ligar/desligar edições', () => {
  const p = emptyProject();
  const a = run(p, S.addAudio, { path: '/tmp/x/voz.wav' });
  assert.equal(p.audios![0].name, 'voz');
  run(p, S.renameAudio, { audio: 'voz', name: 'Voz principal' });
  run(p, A.addAudioClip, { sample: '/tmp/x/voz.wav', bar: 1, lengthSec: 2 });
  // simula uma edição do Afinador aplicada no próprio áudio
  applyOps(p, [{ op: 'set', path: ['audios', a.id, 'path'], value: '/tmp/x/voz-ed.wav' }, { op: 'set', path: ['clips', p.clips[0].id, 'sample'], value: '/tmp/x/voz-ed.wav' }]);
  run(p, S.toggleAudioEdits, { audio: 'Voz principal', on: false });
  assert.equal(p.clips[0].sample, '/tmp/x/voz.wav');
  run(p, S.toggleAudioEdits, { audio: 'Voz principal', on: true });
  assert.equal(p.clips[0].sample, '/tmp/x/voz-ed.wav');
  run(p, S.removeAudio, { audio: 'Voz principal' });
  assert.equal(p.audios!.length, 0);
});

test('copy_effects e leitura detalhada', () => {
  const { p } = base();
  run(p, A.addChannel, { type: 'synth', name: 'Lead' });
  run(p, S.copyEffects, { fromChannel: 'Prisma', toChannel: 'Lead' });
  assert.equal(p.channels[1].effects!.length, 2);
  run(p, S.copyEffects, { fromChannel: 'Prisma', toInsert: 5 });
  assert.equal(p.mixer[5].effects.length, 2);
  const d = S.channelDetail(p, 'Prisma');
  assert.equal(d.effects.length, 2);
  assert.ok(d.params.cutoff !== undefined);
  assert.equal(d.automations.length, 1);
  assert.ok(S.mixerDetail(p).some((m) => m.i === 5 && m.effects.length === 2));
});

test('variante de áudio (timbre transfer): fica ligada ao original', () => {
  const p = emptyProject();
  const a = run(p, S.addAudio, { path: '/tmp/x/guitarra.wav', name: 'Guitarra' });
  const v = run(p, S.addAudio, { path: '/tmp/x/guitarra-violino.wav', name: 'Guitarra (violino)', variantOf: 'Guitarra' });
  assert.equal(p.audios!.find((x) => x.id === v.id)!.variantOf, a.id);
});
