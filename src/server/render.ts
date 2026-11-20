// Render offline (sem tempo real) usando a mesma engine do navegador.

import { channelSamples } from '../core/pads.js';
import type { Project } from '../core/model.js';
import { patternLength, songLength, findPattern } from '../core/model.js';
import { BLOCK, Engine, InsertStats } from '../core/engine.js';
import { loadSample } from './samples.js';
import { getSet, setFolder } from './sampleset.js';

export interface RenderOptions {
  mode?: 'song' | 'pattern';
  pattern?: string;
  sampleRate?: number;
  tailSeconds?: number;
  fromBar?: number;
  toBar?: number;
  maxSeconds?: number;
}

export interface RenderResult {
  L: Float32Array;
  R: Float32Array;
  sr: number;
  inserts: InsertStats[];
  missingSamples: string[];
}

export async function renderProject(p: Project, o: RenderOptions = {}): Promise<RenderResult> {
  const sr = o.sampleRate ?? 44100;
  const eng = new Engine(sr);
  const missing: string[] = [];
  // samples dos canais e dos clipes de áudio da playlist
  const sources = [
    ...p.channels.flatMap((ch) => channelSamples(ch)),
    ...p.clips.map((c) => (c.kind === 'audio' ? c.sample ?? '' : '')),
  ];
  for (const s of sources) {
    if (!s || eng.hasSample(s)) continue;
    try {
      const dir = setFolder(s);
      if (dir) {
        const b = await getSet(dir);
        b.data.forEach((d, i) => eng.setSample(`${dir}#${i}`, d));
        // a chave do conjunto é o caminho guardado no canal (pasta ou .fst)
        eng.setSampleSet(s, b.set);
      } else eng.setSample(s, await loadSample(s));
    } catch {
      missing.push(s);
    }
  }
  const mode = o.mode ?? (p.clips.length ? 'song' : 'pattern');
  const proj: Project = JSON.parse(JSON.stringify(p));
  const bar = (384 * proj.timeSig[0]) / proj.timeSig[1];
  let startTick = 0;
  let endTick: number;
  let patId: string | null = null;
  if (mode === 'pattern') {
    const pat = o.pattern ? findPattern(proj, o.pattern) : proj.patterns[0];
    if (!pat) throw new Error(`Pattern ${o.pattern} não encontrado`);
    patId = pat.id;
    endTick = patternLength(proj, pat);
    // Toca o pattern uma vez como um clip isolado (sem repetir no fim).
    proj.clips = [{ id: 'render', track: 0, pos: 0, len: endTick, patternId: pat.id, offset: 0 }];
    proj.tracks.forEach((t) => (t.mute = false));
  } else {
    startTick = o.fromBar ? (o.fromBar - 1) * bar : 0;
    endTick = o.toBar ? o.toBar * bar : songLength(proj);
    if (endTick <= startTick) throw new Error('A playlist está vazia: coloque patterns nela ou renderize em modo pattern.');
  }
  proj.loop = { start: startTick, end: endTick + bar * 64 }; // evita o stop automático; cortamos manualmente
  eng.setProject(proj);
  eng.play('song', patId, startTick);
  const ticks = endTick - startTick;
  const playFrames = Math.ceil((ticks * 60 * sr) / (proj.bpm * 96));
  const tail = Math.round((o.tailSeconds ?? 2) * sr);
  const total = Math.min(playFrames + tail, Math.round((o.maxSeconds ?? 900) * sr));
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  for (let f = 0; f < total; f += BLOCK) {
    const n = Math.min(BLOCK, total - f);
    if (f >= playFrames && eng.playing) eng.stop(false);
    eng.process(bl, br, n, true);
    L.set(bl.subarray(0, n), f);
    R.set(br.subarray(0, n), f);
  }
  return { L, R, sr, inserts: eng.insertStats(), missingSamples: missing };
}
