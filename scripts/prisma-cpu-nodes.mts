// CPU do Prisma com os 6 nós do filtro ligados (pior caso).
import { Engine, BLOCK } from '../src/core/engine.ts';
import { emptyProject } from '../src/core/model.ts';
import { applyOps } from '../src/core/ops.ts';
import * as A from '../src/core/actions.ts';
const p = emptyProject();
const r = A.addChannel(p, { preset: 'Prisma Supersaw', insert: 'master' });
applyOps(p, r.ops);
const ch = (r.result as any).id;
const params: Record<string, unknown> = { ftype: 'lowpass', cutoff: 5000, f2_type: 'highpass', f2_freq: 80, f3_type: 'peak', f3_freq: 400, f3_gain: 6, f4_type: 'notch', f4_freq: 1200, f5_type: 'point', f5_freq: 2000, f5_gain: -6, f6_type: 'point', f6_freq: 8000, f6_gain: -18, phaser: 0.4, pluck: 0.3 };
applyOps(p, A.updateChannel(p, { channel: ch, params }).ops);
const eng = new Engine(44100);
eng.setProject(p);
for (const k of [48, 52, 55, 60, 64, 67]) eng.liveOn(ch, k, 0.8);
const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
const t = performance.now();
for (let i = 0; i < (44100 * 5) / BLOCK; i++) eng.process(L, R, BLOCK);
const ms = performance.now() - t;
console.log(`6 nós + phaser + pluck, acorde de 6 notas com 8 vozes: ${((ms / 5000) * 100).toFixed(1)}% de um núcleo`);
