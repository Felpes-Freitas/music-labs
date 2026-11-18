import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import { renderProject } from '../src/server/render.ts';
import { analyzeMix } from '../src/core/analysis.ts';
import { chordNotes, romanChord } from '../src/core/theory.ts';

function run(p: any, r: { ops: any[]; result?: any }) { applyOps(p, r.ops); return r.result; }

export function demoSong() {
  const p = emptyProject('Teste');
  p.bpm = 124;
  const pat = p.patterns[0].id;
  const kick = run(p, A.addChannel(p, { preset: 'Kick' })).id;
  const hat = run(p, A.addChannel(p, { preset: 'Hat' })).id;
  const clap = run(p, A.addChannel(p, { preset: 'Clap' })).id;
  const bass = run(p, A.addChannel(p, { preset: 'Sub Bass' })).id;
  const pad = run(p, A.addChannel(p, { preset: 'Warm Pad' })).id;
  run(p, A.setSteps(p, { pattern: pat, channel: kick, steps: 'x---x---x---x---' }));
  run(p, A.setSteps(p, { pattern: pat, channel: hat, steps: '--x---x---x---x-' }));
  run(p, A.setSteps(p, { pattern: pat, channel: clap, steps: '----x-------x---' }));
  const chords = run(p, A.addPattern(p, { name: 'Acordes' })).id;
  run(p, A.addChords(p, { pattern: chords, channel: pad, chords: ['Am7', 'Fmaj7', 'C', 'G'], bassChannel: bass }));
  run(p, A.placePattern(p, { pattern: pat, track: 1, bar: 1, bars: 8 }));
  run(p, A.placePattern(p, { pattern: chords, track: 2, bar: 1, bars: 8 }));
  const padIns = p.channels.find((c) => c.id === pad)!.insert;
  run(p, A.addEffect(p, { insert: padIns, type: 'reverb', mix: 0.3 }));
  run(p, A.addEffect(p, { insert: padIns, type: 'compressor', params: { sidechain: p.channels.find((c) => c.id === kick)!.insert, threshold: -30, ratio: 6 } }));
  run(p, A.addEffect(p, { insert: 0, type: 'limiter' }));
  return p;
}

test('teoria', () => {
  assert.deepEqual(chordNotes('Am7', 4), [69, 72, 76, 79]);
  assert.deepEqual(romanChord('vi', 'C', 'major', 4), [69, 72, 76]);
});

test('render de uma música curta', async () => {
  const p = demoSong();
  const r = await renderProject(p, { tailSeconds: 1 });
  const a = analyzeMix(r.L, r.R, r.sr);
  console.log(JSON.stringify(a), r.inserts.filter((i) => Number.isFinite(i.peakDb)).map((i) => `${i.name}:${i.peakDb.toFixed(1)}`).join(' '));
  assert.ok(a.durationSec > 15 && a.durationSec < 18);
  assert.ok(a.peakDb > -20 && a.peakDb <= 0.01, `pico ${a.peakDb}`);
  assert.ok(a.integratedLufs > -40);
  for (const x of r.L) assert.ok(Number.isFinite(x));
});
