// Ações de alto nível ("adicionar acordes", "colocar pattern na playlist").
// Cada ação lê o projeto e devolve Ops; quem chama aplica e sincroniza.
// O MCP expõe estas ações quase 1:1, e a interface reaproveita várias.

import type { AutoTarget, Channel, Clip, Effect, EffectType, InstrumentType, Note, Params, Pattern, Project } from './model.js';
import { MIXER_SIZE, PPQ, STEP, color, findChannel, findPattern, makeInsert, noteName as noteNameOf, parseNote, patternLength, ticksPerBar, uid } from './model.js';
import { EFFECTS, INSTRUMENTS, defaults, presetParams, sanitizeParams } from './registry.js';
import { chordNotes, romanChord, voiceLead } from './theory.js';
import { Op, ins, insMany, rem, set } from './ops.js';
import { dbToGain } from './dsp.js';

export interface ActionResult {
  ops: Op[];
  result?: unknown;
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined || v === null) throw new Error(`${what} não encontrado`);
  return v;
};

export function channelRef(p: Project, ref: string): Channel {
  return need(findChannel(p, ref), `Canal "${ref}"`);
}
export function patternRef(p: Project, ref: string): Pattern {
  return need(findPattern(p, ref), `Pattern "${ref}"`);
}
export function insertRef(p: Project, ref: string | number): number {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const i = Number(ref);
    if (i < 0 || i >= p.mixer.length) throw new Error(`Insert ${i} não existe (0..${p.mixer.length - 1})`);
    return i;
  }
  const i = p.mixer.findIndex((m) => m.name.toLowerCase() === String(ref).toLowerCase());
  if (i < 0) throw new Error(`Insert "${ref}" não encontrado`);
  return i;
}

/** Primeiro insert sem canais nem nome customizado. */
function freeInsert(p: Project): number {
  for (let i = 1; i < p.mixer.length; i++) {
    const used = p.channels.some((c) => c.insert === i);
    if (!used && /^Insert \d+$/.test(p.mixer[i].name) && p.mixer[i].effects.length === 0) return i;
  }
  return 0;
}

// ------------------------------------------------------------ canais

export function addChannel(
  p: Project,
  a: { name?: string; preset?: string; type?: InstrumentType; params?: Record<string, unknown>; insert?: number | 'auto' | 'master'; volumeDb?: number; pan?: number },
): ActionResult {
  let type: InstrumentType = a.type ?? 'synth';
  let params: Params = defaults(INSTRUMENTS[type].params);
  if (a.preset) {
    const pr = presetParams(a.preset);
    if (!pr) throw new Error(`Preset desconhecido: ${a.preset}`);
    type = pr.type;
    params = pr.params;
  }
  if (a.params) params = { ...params, ...sanitizeParams(INSTRUMENTS[type].params, a.params) };
  const ops: Op[] = [];
  let insert = 0;
  const name = a.name ?? a.preset ?? INSTRUMENTS[type].label;
  if (a.insert === undefined || a.insert === 'auto') {
    insert = freeInsert(p);
    if (insert > 0) ops.push(set(['mixer', insert, 'name'], name));
  } else if (a.insert !== 'master') insert = insertRef(p, a.insert);
  const ch: Channel = {
    id: uid('c'),
    name,
    color: color(p.channels.length),
    type,
    params,
    volume: a.volumeDb !== undefined ? dbToGain(a.volumeDb) : 0.78,
    pan: a.pan ?? 0,
    pitch: 0,
    mute: false,
    insert,
  };
  ops.unshift(ins(['channels'], ch));
  return { ops, result: { id: ch.id, name: ch.name, type, insert } };
}

export function updateChannel(
  p: Project,
  a: {
    channel: string;
    name?: string;
    volumeDb?: number;
    pan?: number;
    pitch?: number;
    /** Nota que toca o instrumento na altura original (ex.: "D4"); define a transposição. */
    root?: number | string;
    /** Ajuste fino em cents (-100..100). */
    fine?: number;
    pitchMode?: 'stretch' | 'resample';
    mute?: boolean;
    insert?: number | string;
    params?: Record<string, unknown>;
    preset?: string;
    type?: InstrumentType;
    color?: string;
  },
): ActionResult {
  const ch = channelRef(p, a.channel);
  const ops: Op[] = [];
  const path = ['channels', ch.id];
  if (a.root !== undefined) ops.push(set([...path, 'pitch'], 60 - parseNote(a.root)));
  if (a.fine !== undefined) ops.push(set([...path, 'fine'], Math.max(-100, Math.min(100, Number(a.fine)))));
  if (a.pitchMode !== undefined) ops.push(set([...path, 'pitchMode'], a.pitchMode));
  if (a.name !== undefined) ops.push(set([...path, 'name'], a.name));
  if (a.color !== undefined) ops.push(set([...path, 'color'], a.color));
  if (a.volumeDb !== undefined) ops.push(set([...path, 'volume'], dbToGain(a.volumeDb)));
  if (a.pan !== undefined) ops.push(set([...path, 'pan'], Math.max(-1, Math.min(1, a.pan))));
  if (a.pitch !== undefined) ops.push(set([...path, 'pitch'], Math.round(a.pitch)));
  if (a.mute !== undefined) ops.push(set([...path, 'mute'], a.mute));
  if (a.insert !== undefined) ops.push(set([...path, 'insert'], insertRef(p, a.insert)));
  let type = ch.type;
  let params = ch.params;
  if (a.preset) {
    const pr = need(presetParams(a.preset), `Preset ${a.preset}`);
    type = pr.type;
    // mantém o sample se o canal já for sampler
    params = { ...pr.params };
  } else if (a.type && a.type !== ch.type) {
    type = a.type;
    params = defaults(INSTRUMENTS[type].params);
  }
  if (a.params) params = { ...params, ...sanitizeParams(INSTRUMENTS[type].params, a.params) };
  if (type !== ch.type) ops.push(set([...path, 'type'], type));
  if (params !== ch.params) ops.push(set([...path, 'params'], params));
  return { ops };
}

export function removeChannel(p: Project, a: { channel: string }): ActionResult {
  const ch = channelRef(p, a.channel);
  const ops: Op[] = [rem(['channels', ch.id])];
  for (const pat of p.patterns) if (pat.notes[ch.id]) ops.push(rem(['patterns', pat.id, 'notes', ch.id]));
  return { ops };
}

// ------------------------------------------------------------ patterns

export function addPattern(p: Project, a: { name?: string; lengthBars?: number }): ActionResult {
  const pat: Pattern = {
    id: uid('p'),
    name: a.name ?? `Pattern ${p.patterns.length + 1}`,
    color: color(p.patterns.length),
    length: a.lengthBars ? (a.lengthBars * ticksPerBar(p)) / STEP : 0,
    notes: {},
  };
  return { ops: [ins(['patterns'], pat)], result: { id: pat.id, name: pat.name } };
}

export function updatePattern(p: Project, a: { pattern: string; name?: string; lengthBars?: number; color?: string }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const ops: Op[] = [];
  if (a.name !== undefined) ops.push(set(['patterns', pat.id, 'name'], a.name));
  if (a.color !== undefined) ops.push(set(['patterns', pat.id, 'color'], a.color));
  if (a.lengthBars !== undefined) ops.push(set(['patterns', pat.id, 'length'], a.lengthBars <= 0 ? 0 : (a.lengthBars * ticksPerBar(p)) / STEP));
  return { ops };
}

export function removePattern(p: Project, a: { pattern: string }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const ops: Op[] = [rem(['patterns', pat.id])];
  for (const c of p.clips) if (c.patternId === pat.id) ops.push(rem(['clips', c.id]));
  return { ops };
}

export function duplicatePattern(p: Project, a: { pattern: string; name?: string }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const copy: Pattern = JSON.parse(JSON.stringify(pat));
  copy.id = uid('p');
  copy.name = a.name ?? `${pat.name} (cópia)`;
  for (const list of Object.values(copy.notes)) for (const n of list) n.id = uid('n');
  const idx = p.patterns.findIndex((x) => x.id === pat.id);
  return { ops: [ins(['patterns'], copy, idx + 1)], result: { id: copy.id, name: copy.name } };
}

// ------------------------------------------------------------ notas

/** Tempo musical: número = semínimas (beats); string "c:b:s" = compasso:tempo:step (base 1). */
export function toTicks(p: Project, v: number | string): number {
  if (typeof v === 'number') return Math.round(v * PPQ);
  const m = /^(\d+)(?::(\d+))?(?::(\d+))?$/.exec(v.trim());
  if (!m) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n * PPQ);
    throw new Error(`Posição inválida: ${v}`);
  }
  const bar = Number(m[1]) - 1;
  const beat = m[2] ? Number(m[2]) - 1 : 0;
  const stp = m[3] ? Number(m[3]) - 1 : 0;
  return bar * ticksPerBar(p) + beat * PPQ + stp * STEP;
}

export interface NoteInput {
  key?: number | string;
  note?: number | string;
  start: number | string;
  length?: number;
  velocity?: number;
  pan?: number;
  slide?: boolean;
}

export function addNotes(p: Project, a: { pattern: string; channel: string; notes: NoteInput[]; replace?: boolean }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const ch = channelRef(p, a.channel);
  const notes: Note[] = a.notes.map((n) => {
    const keySrc = n.key ?? n.note;
    if (keySrc === undefined) throw new Error('Cada nota precisa de "note" (ex.: "C4") ou "key" (MIDI)');
    const key = parseNote(keySrc);
    if (key < 0 || key > 127) throw new Error(`Nota fora da faixa MIDI: ${keySrc}`);
    return {
      id: uid('n'),
      key,
      pos: Math.max(0, toTicks(p, n.start)),
      len: Math.max(1, Math.round((n.length ?? 0.25) * PPQ)),
      vel: Math.max(0, Math.min(1, n.velocity ?? 0.8)),
      ...(n.pan ? { pan: n.pan } : {}),
      ...(n.slide ? { slide: true } : {}),
    };
  });
  const ops: Op[] = [];
  if (a.replace || !pat.notes[ch.id]) ops.push(set(['patterns', pat.id, 'notes', ch.id], []));
  ops.push(insMany(['patterns', pat.id, 'notes', ch.id], notes));
  return { ops, result: { added: notes.length } };
}

/**
 * Steps estilo rack: "x---x---x---x---". x = nota, X = acento, - ou . = vazio,
 * espaços e | são ignorados. Substitui as notas do canal no pattern.
 */
export function setSteps(p: Project, a: { pattern: string; channel: string; steps: string; note?: number | string; velocity?: number; accent?: number }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const ch = channelRef(p, a.channel);
  const key = a.note !== undefined ? parseNote(a.note) : 60;
  const clean = a.steps.replace(/[\s|]/g, '');
  const notes: Note[] = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '-' || c === '.' || c === '0' || c === '_') continue;
    const accent = c === 'X' || c === '!';
    const soft = c === 'o';
    notes.push({ id: uid('n'), key, pos: i * STEP, len: STEP, vel: accent ? a.accent ?? 1 : soft ? 0.5 : a.velocity ?? 0.78 });
  }
  const ops: Op[] = [set(['patterns', pat.id, 'notes', ch.id], notes)];
  // Se o pattern tinha comprimento fixo menor, acompanha os steps.
  if (pat.length && pat.length < clean.length) ops.push(set(['patterns', pat.id, 'length'], clean.length));
  return { ops, result: { steps: clean.length, hits: notes.length } };
}

export function addChords(
  p: Project,
  a: {
    pattern: string;
    channel: string;
    chords: string[];
    key?: string; // para graus romanos
    scale?: string;
    beatsPerChord?: number;
    octave?: number;
    rhythm?: string; // steps por acorde, ex. "x--x--x-" ; padrão = acorde sustentado
    velocity?: number;
    voiceLeading?: boolean;
    bassChannel?: string; // opcional: escreve a fundamental num canal de baixo
    bassOctave?: number;
    arp?: 'up' | 'down' | 'updown' | null;
    arpRate?: number; // beats por nota do arpejo
    startBeat?: number;
    replace?: boolean;
  },
): ActionResult {
  const beats = a.beatsPerChord ?? 4;
  const octave = a.octave ?? 4;
  let chords = a.chords.map((c) => (/^[b#]?[ivIV]+/.test(c) ? romanChord(c, a.key ?? 'C', a.scale ?? 'major', octave) : chordNotes(c, octave)));
  if (a.voiceLeading !== false) chords = voiceLead(chords, octave * 12 + 14);
  const vel = a.velocity ?? 0.75;
  const out: NoteInput[] = [];
  const bass: NoteInput[] = [];
  const start0 = a.startBeat ?? 0;
  chords.forEach((notes, ci) => {
    const t0 = start0 + ci * beats;
    if (a.arp) {
      const rate = a.arpRate ?? 0.25;
      const seq = a.arp === 'down' ? [...notes].reverse() : a.arp === 'updown' ? [...notes, ...notes.slice(1, -1).reverse()] : notes;
      for (let k = 0, t = 0; t < beats - 1e-6; k++, t += rate) out.push({ key: seq[k % seq.length], start: t0 + t, length: rate * 0.9, velocity: vel });
    } else if (a.rhythm) {
      const r = a.rhythm.replace(/[\s|]/g, '');
      const stepBeats = beats / r.length;
      for (let i = 0; i < r.length; i++) {
        if (r[i] === '-' || r[i] === '.') continue;
        let len = 1;
        while (i + len < r.length && r[i + len] === '_') len++;
        for (const k of notes) out.push({ key: k, start: t0 + i * stepBeats, length: len * stepBeats * 0.95, velocity: r[i] === 'X' ? 1 : vel });
      }
    } else for (const k of notes) out.push({ key: k, start: t0, length: beats * 0.98, velocity: vel });
    if (a.bassChannel) {
      const root = Math.min(...notes);
      const bo = (a.bassOctave ?? 2) + 1;
      bass.push({ key: (root % 12) + bo * 12, start: t0, length: beats * 0.98, velocity: 0.85 });
    }
  });
  const ops = addNotes(p, { pattern: a.pattern, channel: a.channel, notes: out, replace: a.replace ?? true }).ops;
  if (a.bassChannel) ops.push(...addNotes(p, { pattern: a.pattern, channel: a.bassChannel, notes: bass, replace: a.replace ?? true }).ops);
  return { ops, result: { chords: chords.map((c) => c.length), notes: out.length + bass.length } };
}

function selectNotes(p: Project, pat: Pattern, channel?: string): [string, Note[]][] {
  if (channel) {
    const ch = channelRef(p, channel);
    return [[ch.id, pat.notes[ch.id] ?? []]];
  }
  return Object.entries(pat.notes);
}

export function clearNotes(p: Project, a: { pattern: string; channel?: string; fromBeat?: number; toBeat?: number }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const ops: Op[] = [];
  const lo = (a.fromBeat ?? 0) * PPQ;
  const hi = a.toBeat !== undefined ? a.toBeat * PPQ : Infinity;
  let removed = 0;
  for (const [chId, notes] of selectNotes(p, pat, a.channel)) {
    const keep = notes.filter((n) => n.pos < lo || n.pos >= hi);
    removed += notes.length - keep.length;
    ops.push(set(['patterns', pat.id, 'notes', chId], keep));
  }
  return { ops, result: { removed } };
}

export function transformNotes(
  p: Project,
  a: { pattern: string; channel?: string; transpose?: number; quantize?: number; strength?: number; humanizeTiming?: number; humanizeVelocity?: number; velocityScale?: number; lengthScale?: number; seed?: number },
): ActionResult {
  const pat = patternRef(p, a.pattern);
  let seed = a.seed ?? 1234;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const ops: Op[] = [];
  let count = 0;
  for (const [chId, notes] of selectNotes(p, pat, a.channel)) {
    const next = notes.map((n0) => {
      const n = { ...n0 };
      if (a.transpose) n.key = Math.max(0, Math.min(127, n.key + a.transpose));
      if (a.quantize) {
        const g = a.quantize * PPQ;
        const q = Math.round(n.pos / g) * g;
        n.pos = Math.round(n.pos + (q - n.pos) * (a.strength ?? 1));
      }
      if (a.lengthScale) n.len = Math.max(1, Math.round(n.len * a.lengthScale));
      if (a.velocityScale) n.vel = Math.max(0, Math.min(1, n.vel * a.velocityScale));
      if (a.humanizeTiming) n.pos = Math.max(0, Math.round(n.pos + rnd() * 2 * a.humanizeTiming * PPQ));
      if (a.humanizeVelocity) n.vel = Math.max(0.05, Math.min(1, n.vel + rnd() * 2 * a.humanizeVelocity));
      count++;
      return n;
    });
    ops.push(set(['patterns', pat.id, 'notes', chId], next));
  }
  return { ops, result: { notes: count } };
}

// ------------------------------------------------------------ playlist

export function placePattern(p: Project, a: { pattern: string; track?: number; bar: number; bars?: number; repeat?: number }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const bar = ticksPerBar(p);
  const plen = patternLength(p, pat);
  const len = a.bars ? a.bars * bar : plen;
  const track = a.track !== undefined ? a.track - 1 : Math.max(0, p.patterns.indexOf(pat));
  if (track < 0) throw new Error('track começa em 1');
  const ops: Op[] = [];
  const ids: string[] = [];
  const times = Math.max(1, a.repeat ?? 1);
  for (let i = 0; i < times; i++) {
    const clip: Clip = { id: uid('k'), track, pos: Math.round((a.bar - 1) * bar + i * len), len, patternId: pat.id, offset: 0 };
    ops.push(ins(['clips'], clip));
    ids.push(clip.id);
  }
  for (let t = p.tracks.length; t <= track; t++) ops.push(ins(['tracks'], { id: uid('t'), name: `Track ${t + 1}`, color: color(t), mute: false }));
  return { ops, result: { clips: ids, track: track + 1 } };
}

export function removeClips(p: Project, a: { track?: number; fromBar?: number; toBar?: number; pattern?: string; clipIds?: string[] }): ActionResult {
  const bar = ticksPerBar(p);
  const lo = a.fromBar ? (a.fromBar - 1) * bar : 0;
  const hi = a.toBar ? a.toBar * bar : Infinity;
  const patId = a.pattern ? patternRef(p, a.pattern).id : null;
  const victims = p.clips.filter((c) => {
    if (a.clipIds) return a.clipIds.includes(c.id);
    if (a.track !== undefined && c.track !== a.track - 1) return false;
    if (patId && c.patternId !== patId) return false;
    return c.pos >= lo && c.pos < hi;
  });
  return { ops: victims.map((c) => rem(['clips', c.id])), result: { removed: victims.length } };
}

export function updateTrack(p: Project, a: { track: number; name?: string; mute?: boolean; color?: string }): ActionResult {
  const t = need(p.tracks[a.track - 1], `Track ${a.track}`);
  const ops: Op[] = [];
  if (a.name !== undefined) ops.push(set(['tracks', t.id, 'name'], a.name));
  if (a.mute !== undefined) ops.push(set(['tracks', t.id, 'mute'], a.mute));
  if (a.color !== undefined) ops.push(set(['tracks', t.id, 'color'], a.color));
  return { ops };
}

// ------------------------------------------------------------ clipes de áudio e automação

/** Primeira track sem clipes no intervalo [pos, pos+len). */
export function freeTrack(p: Project, pos: number, len: number): number {
  for (let t = 0; t < p.tracks.length; t++) if (!p.clips.some((c) => c.track === t && c.pos < pos + len && c.pos + c.len > pos)) return t;
  return p.tracks.length;
}

function trackOps(p: Project, track: number): Op[] {
  const ops: Op[] = [];
  for (let t = p.tracks.length; t <= track; t++) ops.push(ins(['tracks'], { id: uid('t'), name: `Track ${t + 1}`, color: color(t), mute: false }));
  return ops;
}

export function addAudioClip(
  p: Project,
  a: { sample: string; bar?: number; beat?: number; track?: number; bars?: number; lengthSec?: number; startSec?: number; gain?: number; insert?: number | string },
): ActionResult {
  const bar = ticksPerBar(p);
  const pos = Math.round(((a.bar ?? 1) - 1) * bar + (a.beat ?? 0) * PPQ);
  const secPerTick = 60 / (p.bpm * PPQ);
  const len = a.bars ? Math.round(a.bars * bar) : Math.max(1, Math.round((a.lengthSec ?? 4 * bar * secPerTick) / secPerTick));
  const track = a.track !== undefined ? a.track - 1 : freeTrack(p, pos, len);
  const clip: Clip = {
    id: uid('k'),
    kind: 'audio',
    track,
    pos,
    len,
    patternId: '',
    offset: 0,
    sample: a.sample,
    startSec: a.startSec ?? 0,
    gain: a.gain ?? 1,
    insert: a.insert !== undefined ? insertRef(p, a.insert) : 0,
  };
  return { ops: [...trackOps(p, track), ins(['clips'], clip)], result: { clip: clip.id, track: track + 1 } };
}

export interface AutoDescriptor {
  channel?: string;
  insert?: number | string;
  effect?: string | number; // id, tipo ou posição do efeito (no canal ou no insert)
  param: string; // 'volume', 'pan' ou um parâmetro do instrumento/efeito
}

/** Monta o alvo da automação a partir de uma descrição ("corte do canal Pad"). */
export function autoTarget(p: Project, d: AutoDescriptor): AutoTarget {
  const vp = (path: (string | number)[], label: string, param: string): AutoTarget =>
    param === 'volume' ? { path: [...path, 'volume'], min: 0, max: 1.25, label: `${label} · volume` } : { path: [...path, 'pan'], min: -1, max: 1, label: `${label} · pan` };
  const fromDef = (path: (string | number)[], defs: { key: string; kind: string; min?: number; max?: number; curve?: string; label: string }[], param: string, label: string): AutoTarget => {
    const def = defs.find((x) => x.key === param);
    if (!def || def.kind !== 'num') throw new Error(`"${param}" não é um parâmetro numérico. Opções: ${defs.filter((x) => x.kind === 'num').map((x) => x.key).join(', ')}`);
    return { path: [...path, param], min: def.min!, max: def.max!, log: def.curve === 'log' && def.min! > 0, label: `${label} · ${def.label}` };
  };
  if (d.channel) {
    const ch = channelRef(p, d.channel);
    if (d.effect !== undefined) {
      const fx = channelEffectRef(p, ch.id, d.effect);
      return fromDef(['channels', ch.id, 'effects', fx.id, 'params'], EFFECTS[fx.type].params, d.param, `${ch.name} · ${EFFECTS[fx.type].label}`);
    }
    if (d.param === 'volume' || d.param === 'pan') return vp(['channels', ch.id], ch.name, d.param);
    return fromDef(['channels', ch.id, 'params'], INSTRUMENTS[ch.type].params, d.param, ch.name);
  }
  if (d.insert !== undefined) {
    const i = insertRef(p, d.insert);
    const m = p.mixer[i];
    if (d.effect !== undefined) {
      const fx = effectRef(p, i, d.effect);
      return fromDef(['mixer', i, 'effects', fx.id, 'params'], EFFECTS[fx.type].params, d.param, `${m.name} · ${EFFECTS[fx.type].label}`);
    }
    if (d.param === 'volume' || d.param === 'pan') return vp(['mixer', i], m.name, d.param);
  }
  throw new Error('Informe channel (e opcionalmente effect) ou insert, e o param');
}

/** Valor atual do parâmetro, normalizado 0..1 na faixa do alvo. */
export function normalizedNow(p: Project, t: AutoTarget): number {
  let cur: any = p;
  for (const seg of t.path) {
    if (Array.isArray(cur)) cur = typeof seg === 'number' ? cur[seg] : cur.find((x: any) => x?.id === seg) ?? cur[Number(seg)];
    else cur = cur?.[seg];
  }
  const v = typeof cur === 'number' ? cur : t.min;
  return toNorm(t, v);
}

export const toNorm = (t: AutoTarget, v: number) =>
  Math.max(0, Math.min(1, t.log && t.min > 0 ? Math.log(v / t.min) / Math.log(t.max / t.min) : (v - t.min) / (t.max - t.min)));

export function addAutomation(
  p: Project,
  a: AutoDescriptor & { target?: AutoTarget; bar?: number; bars?: number; track?: number; points?: { beat: number; value: number }[] },
): ActionResult {
  const target = a.target ?? autoTarget(p, a);
  const bar = ticksPerBar(p);
  const pos = Math.round(((a.bar ?? 1) - 1) * bar);
  const song = p.clips.reduce((m, c) => Math.max(m, c.pos + c.len), 0);
  const len = a.bars ? Math.round(a.bars * bar) : Math.max(4 * bar, song - pos);
  const track = a.track !== undefined ? a.track - 1 : freeTrack(p, pos, len);
  const now = normalizedNow(p, target);
  const points = a.points?.length
    ? a.points.map((x) => ({ t: Math.max(0, Math.min(len, Math.round(x.beat * PPQ))), v: toNorm(target, x.value) })).sort((x, y) => x.t - y.t)
    : [
        { t: 0, v: now },
        { t: len, v: now },
      ];
  const clip: Clip = { id: uid('k'), kind: 'auto', track, pos, len, patternId: '', offset: 0, target, points };
  return { ops: [...trackOps(p, track), ins(['clips'], clip)], result: { clip: clip.id, track: track + 1, target: target.label } };
}

// ------------------------------------------------------------ mixer

export function updateInsert(p: Project, a: { insert: number | string; name?: string; volumeDb?: number; pan?: number; mute?: boolean; solo?: boolean; output?: number | string }): ActionResult {
  const i = insertRef(p, a.insert);
  const ops: Op[] = [];
  if (a.name !== undefined) ops.push(set(['mixer', i, 'name'], a.name));
  if (a.volumeDb !== undefined) ops.push(set(['mixer', i, 'volume'], dbToGain(a.volumeDb)));
  if (a.pan !== undefined) ops.push(set(['mixer', i, 'pan'], Math.max(-1, Math.min(1, a.pan))));
  if (a.mute !== undefined) ops.push(set(['mixer', i, 'mute'], a.mute));
  if (a.solo !== undefined) ops.push(set(['mixer', i, 'solo'], a.solo));
  if (a.output !== undefined) {
    const o = insertRef(p, a.output);
    if (o === i) throw new Error('Um insert não pode rotear para ele mesmo');
    ops.push(set(['mixer', i, 'output'], o));
  }
  return { ops };
}

export function addEffect(p: Project, a: { insert: number | string; type: EffectType; params?: Record<string, unknown>; mix?: number; index?: number }): ActionResult {
  const i = insertRef(p, a.insert);
  const def = need(EFFECTS[a.type], `Efeito ${a.type}`);
  const fx: Effect = {
    id: uid('e'),
    type: a.type,
    enabled: true,
    mix: a.mix ?? (a.type === 'reverb' || a.type === 'delay' ? 0.25 : a.type === 'chorus' ? 0.5 : 1),
    params: { ...defaults(def.params), ...sanitizeParams(def.params, a.params ?? {}) },
  };
  if (p.mixer[i].effects.length >= 10) throw new Error('Máximo de 10 efeitos por insert');
  return { ops: [ins(['mixer', i, 'effects'], fx, a.index)], result: { id: fx.id, insert: i } };
}

function effectRef(p: Project, i: number, ref: string | number): Effect {
  const list = p.mixer[i].effects;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return need(list[Number(ref)], `Efeito #${ref}`);
  return need(list.find((e) => e.id === ref) ?? list.find((e) => e.type === ref), `Efeito ${ref}`);
}

export function updateEffect(p: Project, a: { insert: number | string; effect: string | number; params?: Record<string, unknown>; mix?: number; enabled?: boolean }): ActionResult {
  const i = insertRef(p, a.insert);
  const fx = effectRef(p, i, a.effect);
  const ops: Op[] = [];
  const path = ['mixer', i, 'effects', fx.id];
  if (a.params) ops.push(set([...path, 'params'], { ...fx.params, ...sanitizeParams(EFFECTS[fx.type].params, a.params) }));
  if (a.mix !== undefined) ops.push(set([...path, 'mix'], Math.max(0, Math.min(1, a.mix))));
  if (a.enabled !== undefined) ops.push(set([...path, 'enabled'], a.enabled));
  return { ops };
}

// ------------------------------------------------------------ efeitos do canal

export const CHANNEL_FX_MAX = 4;

export function addChannelEffect(p: Project, a: { channel: string; type: EffectType; params?: Record<string, unknown>; mix?: number; index?: number }): ActionResult {
  const ch = channelRef(p, a.channel);
  const def = need(EFFECTS[a.type], `Efeito ${a.type}`);
  const list = ch.effects ?? [];
  if (list.length >= CHANNEL_FX_MAX) throw new Error(`Máximo de ${CHANNEL_FX_MAX} efeitos por canal`);
  const fx: Effect = {
    id: uid('e'),
    type: a.type,
    enabled: true,
    mix: a.mix ?? (a.type === 'reverb' || a.type === 'delay' ? 0.3 : a.type === 'chorus' ? 0.5 : 1),
    params: { ...defaults(def.params), ...sanitizeParams(def.params, a.params ?? {}) },
  };
  const ops: Op[] = ch.effects ? [] : [set(['channels', ch.id, 'effects'], [])];
  ops.push(ins(['channels', ch.id, 'effects'], fx, a.index));
  return { ops, result: { id: fx.id, channel: ch.name } };
}

function channelEffectRef(p: Project, chId: string, ref: string | number): Effect {
  const list = channelRef(p, chId).effects ?? [];
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return need(list[Number(ref)], `Efeito #${ref}`);
  return need(list.find((e) => e.id === ref) ?? list.find((e) => e.type === ref), `Efeito ${ref}`);
}

export function updateChannelEffect(p: Project, a: { channel: string; effect: string | number; params?: Record<string, unknown>; mix?: number; enabled?: boolean; type?: EffectType }): ActionResult {
  const ch = channelRef(p, a.channel);
  const fx = channelEffectRef(p, a.channel, a.effect);
  const path = ['channels', ch.id, 'effects', fx.id];
  const ops: Op[] = [];
  if (a.type && a.type !== fx.type) {
    const def = need(EFFECTS[a.type], `Efeito ${a.type}`);
    ops.push(set([...path, 'type'], a.type), set([...path, 'params'], { ...defaults(def.params), ...sanitizeParams(def.params, a.params ?? {}) }));
  } else if (a.params) ops.push(set([...path, 'params'], { ...fx.params, ...sanitizeParams(EFFECTS[fx.type].params, a.params) }));
  if (a.mix !== undefined) ops.push(set([...path, 'mix'], Math.max(0, Math.min(1, a.mix))));
  if (a.enabled !== undefined) ops.push(set([...path, 'enabled'], a.enabled));
  return { ops };
}

export function removeChannelEffect(p: Project, a: { channel: string; effect: string | number }): ActionResult {
  const ch = channelRef(p, a.channel);
  const fx = channelEffectRef(p, a.channel, a.effect);
  return { ops: [rem(['channels', ch.id, 'effects', fx.id])] };
}

export function removeEffect(p: Project, a: { insert: number | string; effect: string | number }): ActionResult {
  const i = insertRef(p, a.insert);
  const fx = effectRef(p, i, a.effect);
  return { ops: [rem(['mixer', i, 'effects', fx.id])] };
}

export function setProjectProps(p: Project, a: { bpm?: number; swing?: number; name?: string; timeSig?: [number, number]; loopBars?: [number, number] | null }): ActionResult {
  const ops: Op[] = [];
  if (a.bpm !== undefined) ops.push(set(['bpm'], Math.max(20, Math.min(400, a.bpm))));
  if (a.swing !== undefined) ops.push(set(['swing'], Math.max(0, Math.min(1, a.swing))));
  if (a.name !== undefined) ops.push(set(['name'], a.name));
  if (a.timeSig !== undefined) ops.push(set(['timeSig'], a.timeSig));
  if (a.loopBars !== undefined) {
    const bar = ticksPerBar(p);
    ops.push(set(['loop'], a.loopBars ? { start: (a.loopBars[0] - 1) * bar, end: a.loopBars[1] * bar } : null));
  }
  return { ops };
}

export function ensureMixer(p: Project): Op[] {
  const ops: Op[] = [];
  for (let i = p.mixer.length; i < MIXER_SIZE; i++) ops.push(ins(['mixer'], makeInsert(i)));
  return ops;
}

/** Resumo legível do projeto (para o MCP e para logs). */
export function describe(p: Project) {
  const bar = ticksPerBar(p);
  return {
    name: p.name,
    bpm: p.bpm,
    timeSig: p.timeSig,
    swing: p.swing,
    songBars: Math.ceil(p.clips.reduce((m, c) => Math.max(m, c.pos + c.len), 0) / bar),
    channels: p.channels.map((c, i) => ({
      n: i + 1,
      id: c.id,
      name: c.name,
      type: c.type,
      insert: c.insert,
      volumeDb: Math.round(20 * Math.log10(Math.max(1e-6, c.volume)) * 10) / 10,
      pan: c.pan,
      mute: c.mute,
      ...(c.pitch ? { root: noteNameOf(60 - c.pitch) } : {}),
      ...(c.fine ? { fineCents: c.fine } : {}),
      ...(c.effects?.length ? { effects: c.effects.map((e) => `${e.type}${e.enabled ? '' : ' (off)'}#${e.id}`) } : {}),
      ...(c.type === 'sampler' ? { sample: c.params.sample } : {}),
    })),
    patterns: p.patterns.map((pt) => ({
      id: pt.id,
      name: pt.name,
      bars: patternLength(p, pt) / bar,
      notes: Object.fromEntries(Object.entries(pt.notes).filter(([, v]) => v.length).map(([k, v]) => [p.channels.find((c) => c.id === k)?.name ?? k, v.length])),
    })),
    playlist: p.clips
      .slice()
      .sort((a, b) => a.pos - b.pos || a.track - b.track)
      .map((c) => ({
        id: c.id,
        track: c.track + 1,
        bar: c.pos / bar + 1,
        bars: c.len / bar,
        ...(c.kind === 'audio' ? { audio: c.sample?.split(/[\\/]/).pop(), insert: c.insert ?? 0 } : c.kind === 'auto' ? { automation: c.target?.label, points: c.points?.length } : { pattern: p.patterns.find((x) => x.id === c.patternId)?.name }),
        muted: c.muted || undefined,
      })),
    mixer: p.mixer
      .map((m, i) => ({ i, name: m.name, volumeDb: Math.round(20 * Math.log10(Math.max(1e-6, m.volume)) * 10) / 10, pan: m.pan, mute: m.mute || undefined, output: i > 0 && m.output > 0 ? m.output : undefined, effects: m.effects.map((e) => `${e.type}${e.enabled ? '' : ' (off)'}#${e.id}`) }))
      .filter((m, i) => i === 0 || p.channels.some((c) => c.insert === i) || m.effects.length || !/^Insert \d+$/.test(m.name)),
  };
}
