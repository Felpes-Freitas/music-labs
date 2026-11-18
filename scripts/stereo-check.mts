import { emptyProject } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
import { renderProject } from '../src/server/render.ts';
import { analyzeMix } from '../src/core/analysis.ts';
for (const [preset, fx] of [['Warm Pad', null], ['Supersaw', null], ['E-Piano', 'reverb'], ['E-Piano', 'delay'], ['E-Piano', 'chorus']] as const) {
  const p = emptyProject();
  const r = A.addChannel(p, { preset }); applyOps(p, r.ops);
  const id = (r.result as any).id; const ins = (r.result as any).insert;
  applyOps(p, A.addChords(p, { pattern: p.patterns[0].id, channel: id, chords: ['Am', 'F'], beatsPerChord: 2 }).ops);
  if (fx) applyOps(p, A.addEffect(p, { insert: ins, type: fx as any, mix: 1 }).ops);
  const out = await renderProject(p, { mode: 'pattern', tailSeconds: 1 });
  const a = analyzeMix(out.L, out.R, out.sr);
  console.log(preset, fx, 'corr', a.stereoCorrelation, 'rms', a.rmsDb, 'peak', a.peakDb);
}
