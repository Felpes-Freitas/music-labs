// Importador de projetos .flp (FL Studio) para o modelo do Music Labs.
//
// Implementação clean-room: o layout foi levantado a partir dos arquivos de
// dados (.flp) gerados por uma instalação legítima e da documentação pública
// do formato. Nenhum código da Image-Line foi decompilado ou copiado. O objetivo
// é só interoperabilidade: abrir os seus projetos no Music Labs.

import type { Channel, Clip, InstrumentType, Note, Params, Pattern, Project } from './model.js';
import { PPQ, color, emptyProject, makeInsert, uid } from './model.js';
import { INSTRUMENTS, defaults, presetParams } from './registry.js';

export interface FlpEvent {
  id: number;
  data: Uint8Array;
}

export interface FlpFile {
  format: number;
  channelCount: number;
  ppq: number;
  events: FlpEvent[];
}

export const EV = {
  ChannelEnabled: 0,
  ChannelType: 21,
  ChannelFxTarget: 22, // BYTE: insert do mixer (validado nos .flp de exemplo)
  ChannelNew: 64,
  PatternNew: 65,
  PatternSelected: 67,
  ChannelVolumeWord: 72,
  ChannelPanWord: 73,
  ArrangementNew: 99,
  InsertEnd: 147,
  Tempo: 156,
  PatternLength: 164,
  ChannelName: 192,
  PatternName: 193,
  ChannelSamplePath: 196,
  Version: 199,
  PluginInternalName: 201,
  PluginName: 203,
  InsertName: 204,
  ChannelLevels: 219,
  PatternNotes: 224,
  PlaylistItems: 233,
  InsertRouting: 235,
  TrackData: 238, // abre o bloco de uma track da playlist
  TrackName: 239,
  MixerParams: 236,
} as const;

/** Eventos que encerram a seção de canais (o que vem depois é playlist/mixer). */
const ENDS_CHANNEL_SCOPE = new Set<number>([99, 147, 233, 236, 238]);

const u16 = (d: Uint8Array, o: number) => (o + 2 <= d.length ? d[o] | (d[o + 1] << 8) : 0);
const u32 = (d: Uint8Array, o: number) => (o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);
const s32 = (d: Uint8Array, o: number) => u32(d, o) | 0;

export function readFlp(buf: Uint8Array): FlpFile {
  const td = new TextDecoder('latin1');
  if (td.decode(buf.subarray(0, 4)) !== 'FLhd') throw new Error('Não é um .flp (falta FLhd)');
  const hdrLen = u32(buf, 4);
  const format = u16(buf, 8);
  const channelCount = u16(buf, 10);
  const ppq = u16(buf, 12) || 96;
  const dataOff = 8 + hdrLen;
  if (td.decode(buf.subarray(dataOff, dataOff + 4)) !== 'FLdt') throw new Error('Falta o bloco FLdt');
  const len = u32(buf, dataOff + 4);
  let p = dataOff + 8;
  const end = Math.min(buf.length, p + len);
  const events: FlpEvent[] = [];
  while (p < end) {
    const id = buf[p++];
    let n: number;
    if (id < 64) n = 1;
    else if (id < 128) n = 2;
    else if (id < 192) n = 4;
    else {
      n = 0;
      let shift = 0;
      while (p < end) {
        const b = buf[p++];
        n |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
    }
    if (p + n > end) break;
    events.push({ id, data: buf.subarray(p, p + n) });
    p += n;
  }
  return { format, channelCount, ppq, events };
}

/** Texto: UTF-16LE no FL 12+, ANSI nos antigos. */
export function flpText(d: Uint8Array): string {
  const utf16 = d.length >= 2 && d[1] === 0 && (d.length < 4 || d[3] === 0);
  if (utf16) {
    let s = new TextDecoder('utf-16le').decode(d);
    const z = s.indexOf('\0');
    if (z >= 0) s = s.slice(0, z);
    return s;
  }
  let s = new TextDecoder('latin1').decode(d);
  const z = s.indexOf('\0');
  return z >= 0 ? s.slice(0, z) : s;
}

export interface FlpImportOptions {
  /** Converte caminhos do FL (Windows/Wine, %FLStudioFactoryData%) para caminhos locais. */
  resolveSample?: (flPath: string) => string;
  /** Diz se o sample resolvido existe; se não, o canal vira um instrumento sintetizado. */
  exists?: (path: string) => boolean;
}

/** Heurística: escolhe um instrumento nativo do Music Labs para plugins do FL. */
function guessInstrument(name: string, plugin: string): { type: InstrumentType; params: Params } {
  const n = `${name} ${plugin}`.toLowerCase();
  const pick = (preset: string) => presetParams(preset)!;
  if (/\bfpc\b|drum ?kit|drums\b|\bkit\b/.test(n)) return pick('Drum Kit');
  if (/808/.test(n)) return pick('808');
  if (/kick|bd\b|bass ?drum/.test(n)) return pick('Kick');
  if (/snare|sd\b/.test(n)) return pick('Snare');
  if (/clap/.test(n)) return pick('Clap');
  if (/open ?h|oh\b|ride|crash|cymb/.test(n)) return pick('Open Hat');
  if (/hat|hh|hihat|shaker/.test(n)) return pick('Hat');
  if (/tom/.test(n)) return pick('Tom');
  if (/rim|perc|conga|bongo|tamb/.test(n)) return pick('Perc');
  if (/sub/.test(n)) return pick('Sub Bass');
  if (/bass|bas\b/.test(n)) return pick('Reese Bass');
  if (/pad|string|choir|atmo/.test(n)) return pick('Warm Pad');
  if (/piano|grand|keys|rhodes|ep\b/.test(n)) return pick('E-Piano');
  if (/bell|mallet|glock|marimba/.test(n)) return pick('Bell');
  if (/pluck|guitar|harp/.test(n)) return pick('Pluck Lead');
  if (/brass|horn/.test(n)) return pick('Brass');
  if (/lead|saw|synth/.test(n)) return pick('Supersaw');
  return { type: 'synth', params: defaults(INSTRUMENTS.synth.params) };
}

export interface FlpImportReport {
  version: string;
  channels: number;
  patterns: number;
  clips: number;
  notes: number;
  substituted: { channel: string; plugin: string; as: string }[];
  missingSamples: string[];
  automationSkipped: number;
}

export function importFlp(buf: Uint8Array, name: string, opts: FlpImportOptions = {}): { project: Project; report: FlpImportReport } {
  const f = readFlp(buf);
  const scale = PPQ / f.ppq;
  const pr = emptyProject(name);
  pr.patterns = [];
  pr.clips = [];
  pr.meta.source = `FL Studio .flp`;
  const report: FlpImportReport = { version: '', channels: 0, patterns: 0, clips: 0, notes: 0, substituted: [], missingSamples: [], automationSkipped: 0 };

  interface RawCh { iid: number; type: number; name: string; plugin: string; pluginName: string; sample: string; vol: number; pan: number; pitch: number; fx: number; enabled: boolean }
  const chans = new Map<number, RawCh>();
  const pats = new Map<number, { name: string; notes: { rack: number; n: Note }[] }>();
  const insertNames: string[] = [];
  const trackNames: string[] = [];
  let insertBlocks = 0;
  let curCh: RawCh | null = null;
  let curPat: { name: string; notes: { rack: number; n: Note }[] } | null = null;
  let arrangement = 0;
  let trackIndex = -1;
  const playlist: { pos: number; len: number; item: number; track: number; start: number; muted: boolean }[] = [];

  for (const e of f.events) {
    const d = e.data;
    if (ENDS_CHANNEL_SCOPE.has(e.id)) curCh = null;
    switch (e.id) {
      case EV.Version:
        report.version = flpText(d);
        break;
      case EV.Tempo:
        if (u32(d, 0)) pr.bpm = u32(d, 0) / 1000;
        break;
      case EV.ChannelNew: {
        const iid = u16(d, 0);
        curCh = chans.get(iid) ?? { iid, type: 0, name: '', plugin: '', pluginName: '', sample: '', vol: 0.78, pan: 0, pitch: 0, fx: 0, enabled: true };
        chans.set(iid, curCh);
        curPat = null;
        break;
      }
      case EV.PatternNew: {
        const iid = u16(d, 0);
        curPat = pats.get(iid) ?? { name: '', notes: [] };
        pats.set(iid, curPat);
        break;
      }
      case EV.ArrangementNew:
        arrangement++;
        break;
      case EV.PatternName:
        if (curPat) curPat.name = flpText(d);
        break;
      case EV.PatternNotes:
        if (curPat)
          for (let o = 0; o + 24 <= d.length; o += 24) {
            const flags = u16(d, o + 4);
            const key = Math.max(0, Math.min(127, u16(d, o + 12)));
            curPat.notes.push({
              rack: u16(d, o + 6),
              n: {
                id: uid('n'),
                pos: Math.round(u32(d, o) * scale),
                len: Math.max(1, Math.round(u32(d, o + 8) * scale)),
                key,
                vel: Math.min(1, d[o + 21] / 128),
                pan: Math.max(-1, Math.min(1, (d[o + 20] - 64) / 64)),
                slide: (flags & 8) !== 0 || undefined,
              },
            });
          }
        break;
      case EV.InsertEnd:
        insertBlocks++;
        break;
      case EV.InsertName:
        insertNames[insertBlocks] = flpText(d);
        break;
      case EV.TrackData:
        trackIndex++;
        curCh = null;
        break;
      case EV.TrackName:
        if (trackIndex >= 0) trackNames[trackIndex] = flpText(d);
        break;
      case EV.PlaylistItems: {
        if (arrangement > 1) break; // só o primeiro arranjo
        let rec = 0;
        for (const cand of [80, 60, 32]) {
          if (d.length % cand) continue;
          const total = d.length / cand;
          let good = 0;
          for (let i = 0; i < total; i++) if (u16(d, i * cand + 4) === 20480) good++;
          if (total && good * 10 >= total * 9) {
            rec = cand;
            break;
          }
        }
        if (!rec) rec = d.length % 60 === 0 ? 60 : 32;
        for (let o = 0; o + rec <= d.length; o += rec) {
          const rv = u16(d, o + 12);
          let start = 0;
          if (rec >= 60) start = new DataView(d.buffer, d.byteOffset + o + 24, 4).getFloat32(0, true);
          playlist.push({
            pos: u32(d, o),
            item: u16(d, o + 6),
            len: u32(d, o + 8),
            track: rv < 500 ? 499 - rv : rv,
            start: Number.isFinite(start) && start > 0 ? start : 0,
            muted: (u16(d, o + 18) & 0x4) !== 0,
          });
        }
        break;
      }
    }
    if (curCh && !curPat) {
      switch (e.id) {
        case EV.ChannelEnabled:
          curCh.enabled = d[0] !== 0;
          break;
        case EV.ChannelType:
          curCh.type = d[0];
          break;
        case EV.ChannelFxTarget:
          curCh.fx = d[0];
          break;
        case EV.ChannelName:
          if (!curCh.name) curCh.name = flpText(d);
          break;
        case EV.PluginInternalName:
          curCh.plugin = flpText(d);
          break;
        case EV.PluginName:
          curCh.pluginName = flpText(d);
          break;
        case EV.ChannelSamplePath:
          curCh.sample = flpText(d);
          break;
        case EV.ChannelLevels:
          if (curCh.type !== 5 && d.length >= 8) {
            curCh.pan = Math.max(-1, Math.min(1, (s32(d, 0) - 6400) / 6400));
            curCh.vol = Math.min(1.25, u32(d, 4) / 12800);
          }
          if (d.length >= 12) curCh.pitch = Math.round(s32(d, 8) / 100);
          break;
      }
    }
  }

  // Canais: FL numera o rack por ordem de criação; notas apontam para essa posição.
  const rackOrder = [...chans.values()];
  const rackToId = new Map<number, string>();
  rackOrder.forEach((c, i) => {
    // tipo 5 = automação, não é instrumento
    if (c.type === 5) {
      report.automationSkipped++;
      return;
    }
    const nameRaw = c.pluginName || c.name || c.plugin || `Canal ${i + 1}`;
    let type: InstrumentType;
    let params: Params;
    const resolved = c.sample ? (opts.resolveSample ? opts.resolveSample(c.sample) : c.sample) : '';
    if (c.sample && opts.exists && !opts.exists(resolved)) report.missingSamples.push(c.sample);
    if (c.sample && (!opts.exists || opts.exists(resolved))) {
      const path = resolved;
      type = 'sampler';
      params = { ...defaults(INSTRUMENTS.sampler.params), sample: path, keytrack: true, oneshot: true };
    } else {
      const g = guessInstrument(nameRaw, c.plugin);
      type = g.type;
      params = g.params;
      report.substituted.push({ channel: nameRaw, plugin: c.sample ? `sample ausente: ${c.sample.split(/[\\/]/).pop()}` : c.plugin || '(nativo)', as: `${type}${params.kind ? ':' + params.kind : ''}` });
    }
    const ch: Channel = {
      id: uid('c'),
      name: nameRaw,
      color: color(i),
      type,
      params,
      volume: c.vol,
      pan: c.pan,
      pitch: 0,
      mute: !c.enabled,
      insert: c.fx,
    };
    pr.channels.push(ch);
    rackToId.set(i, ch.id);
  });

  const patIdByIid = new Map<number, string>();
  for (const [iid, rp] of [...pats.entries()].sort((a, b) => a[0] - b[0])) {
    const pat: Pattern = { id: uid('p'), name: rp.name || `Pattern ${iid}`, color: color(iid - 1), length: 0, notes: {} };
    for (const { rack, n } of rp.notes) {
      const chId = rackToId.get(rack);
      if (!chId) continue;
      (pat.notes[chId] ??= []).push(n);
      report.notes++;
    }
    pr.patterns.push(pat);
    patIdByIid.set(iid, pat.id);
  }
  if (pr.patterns.length === 0) pr.patterns.push({ id: uid('p'), name: 'Pattern 1', color: color(0), length: 0, notes: {} });

  let maxTrack = 0;
  for (const it of playlist) {
    if (it.item <= 20480) continue; // clips de áudio/automação: ainda não importados
    const patId = patIdByIid.get(it.item - 20480);
    if (!patId || !it.len) continue;
    const clip: Clip = {
      id: uid('k'),
      track: it.track,
      pos: Math.round(it.pos * scale),
      len: Math.round(it.len * scale),
      patternId: patId,
      offset: Math.round(it.start * scale),
      muted: it.muted || undefined,
    };
    pr.clips.push(clip);
    maxTrack = Math.max(maxTrack, it.track);
  }
  while (pr.tracks.length <= maxTrack) pr.tracks.push({ id: uid('t'), name: `Track ${pr.tracks.length + 1}`, color: color(pr.tracks.length), mute: false });
  trackNames.forEach((t, i) => {
    if (t && pr.tracks[i]) pr.tracks[i].name = t;
  });

  // O mixer cresce até o maior insert usado (o FL tem até 125).
  const maxInsert = Math.max(16, ...pr.channels.map((c) => c.insert));
  while (pr.mixer.length <= maxInsert) pr.mixer.push(makeInsert(pr.mixer.length));
  insertNames.forEach((n, i) => {
    if (n && pr.mixer[i]) pr.mixer[i].name = n;
  });

  report.channels = pr.channels.length;
  report.patterns = pr.patterns.length;
  report.clips = pr.clips.length;
  return { project: pr, report };
}
