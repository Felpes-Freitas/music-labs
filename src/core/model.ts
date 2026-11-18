// Modelo de projeto do Music Labs. Tudo aqui é JSON puro para poder viajar entre
// navegador, servidor, engine de áudio e MCP sem conversão.

export const PPQ = 96; // ticks por semínima
export const STEP = PPQ / 4; // uma semicolcheia (um "step" do rack)

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

export interface Note {
  id: string;
  key: number; // MIDI, 60 = C4
  pos: number; // ticks desde o início do pattern
  len: number; // ticks
  vel: number; // 0..1
  pan?: number; // -1..1
  slide?: boolean;
  mute?: boolean;
}

export type InstrumentType = 'synth' | 'sampler' | 'drum' | 'pluck' | 'fm';

export interface Channel {
  id: string;
  name: string;
  color: string;
  type: InstrumentType;
  params: Params;
  volume: number; // ganho linear, 0.78 ≈ -2 dB (padrão)
  pan: number; // -1..1
  pitch: number; // semitons
  mute: boolean;
  insert: number; // índice do insert do mixer (0 = master)
}

export interface Pattern {
  id: string;
  name: string;
  color: string;
  /** Comprimento em steps; 0 = automático (arredonda para o compasso). */
  length: number;
  notes: Record<string, Note[]>; // por channel id
}

export interface Clip {
  id: string;
  track: number;
  pos: number; // ticks
  len: number; // ticks
  patternId: string;
  offset: number; // ticks dentro do pattern
  muted?: boolean;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  mute: boolean;
}

export type EffectType =
  | 'eq'
  | 'filter'
  | 'compressor'
  | 'delay'
  | 'reverb'
  | 'chorus'
  | 'distortion'
  | 'bitcrusher'
  | 'stereo'
  | 'limiter';

export interface Effect {
  id: string;
  type: EffectType;
  enabled: boolean;
  mix: number; // 0..1 dry/wet
  params: Params;
}

export interface Insert {
  id: string;
  name: string;
  color: string;
  volume: number; // ganho linear
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Para onde o insert envia; -1 só para o master (índice 0 não roteia). */
  output: number;
  effects: Effect[];
}

export interface Project {
  format: 'batuque';
  version: 1;
  name: string;
  bpm: number;
  timeSig: [number, number];
  swing: number; // 0..1
  channels: Channel[];
  patterns: Pattern[];
  tracks: Track[];
  clips: Clip[];
  mixer: Insert[]; // mixer[0] = master
  loop?: { start: number; end: number } | null;
  meta: { createdAt: string; source?: string; notes?: string };
}

export const MIXER_SIZE = 17; // master + 16 inserts

const PALETTE = [
  '#e4a23a', '#5fb3d9', '#9bd16a', '#d9657a', '#b48ce0', '#e0d06a',
  '#6ad6b8', '#e3875a', '#7c95e6', '#c9c9c9',
];
export const color = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

let counter = 0;
export function uid(prefix = 'x'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${counter.toString(36)}`;
}

export function ticksPerBar(p: Pick<Project, 'timeSig'>): number {
  return (PPQ * 4 * p.timeSig[0]) / p.timeSig[1];
}

export function makeInsert(i: number): Insert {
  return {
    id: String(i),
    name: i === 0 ? 'Master' : `Insert ${i}`,
    color: i === 0 ? '#cfcfcf' : color(i - 1),
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    output: 0,
    effects: [],
  };
}

export function emptyProject(name = 'Sem título'): Project {
  return {
    format: 'batuque',
    version: 1,
    name,
    bpm: 128,
    timeSig: [4, 4],
    swing: 0,
    channels: [],
    patterns: [{ id: uid('p'), name: 'Pattern 1', color: color(0), length: 0, notes: {} }],
    tracks: Array.from({ length: 16 }, (_, i) => ({
      id: uid('t'),
      name: `Track ${i + 1}`,
      color: color(i),
      mute: false,
    })),
    clips: [],
    mixer: Array.from({ length: MIXER_SIZE }, (_, i) => makeInsert(i)),
    loop: null,
    meta: { createdAt: new Date().toISOString() },
  };
}

/** Comprimento efetivo do pattern em ticks (arredondado para compassos). */
export function patternLength(p: Project, pat: Pattern): number {
  const bar = ticksPerBar(p);
  if (pat.length > 0) return pat.length * STEP;
  let end = 0;
  for (const list of Object.values(pat.notes)) for (const n of list) end = Math.max(end, n.pos + n.len);
  return Math.max(bar, Math.ceil(end / bar) * bar);
}

export function songLength(p: Project): number {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, c.pos + c.len);
  return end;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(key: number): string {
  return `${NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`;
}

/** Aceita 60, "C4", "c#3", "Db5", "F#-1". */
export function parseNote(v: string | number): number {
  if (typeof v === 'number') return v;
  const m = /^\s*([A-Ga-g])([#b♯♭]*)(-?\d+)\s*$/.exec(v);
  if (!m) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    throw new Error(`Nota inválida: ${v}`);
  }
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase() as 'C'];
  let acc = 0;
  for (const ch of m[2]) acc += ch === '#' || ch === '♯' ? 1 : -1;
  return (Number(m[3]) + 1) * 12 + base + acc;
}

export function findChannel(p: Project, ref: string): Channel | undefined {
  return p.channels.find((c) => c.id === ref) ?? p.channels.find((c) => c.name.toLowerCase() === ref.toLowerCase());
}
export function findPattern(p: Project, ref: string): Pattern | undefined {
  return p.patterns.find((c) => c.id === ref) ?? p.patterns.find((c) => c.name.toLowerCase() === ref.toLowerCase());
}
