// Ações de estúdio: o que o usuário faz na interface e que o MCP precisa conseguir fazer
// sem gambiarra — duplicar canal (com efeitos e notas), copiar notas entre patterns e
// canais, editar clipes da playlist (mover, redimensionar, cortar o começo, duplicar),
// copiar/abrir/apagar trechos da música, automação com as funções da Central (inclusive
// BPM), mixer (resetar insert, copiar efeitos) e a lista de áudios do projeto.
// Mesmo formato de actions.ts: (projeto, args) → { ops, result }.

import type { AudioItem, AutoTarget, Channel, Clip, Effect, InstrumentType, Note, Pattern, Project } from './model.js';
import { PPQ, STEP, color, findPattern, makeInsert, noteName, parseNote, patternLength, ticksPerBar, uid } from './model.js';
import { ins, rem, set, type Op } from './ops.js';
import { autoTarget, channelRef, freeTrack, insertRef, normalizedNow, patternRef, toNorm, updateChannel, type ActionResult, type AutoDescriptor } from './actions.js';
import { GEN_DEFAULTS, GEN_PRESETS, renderGen, regen, trimAutoStart, type AutoGen, type GenKind, type Wave } from './autogen.js';
import { INSTRUMENTS, presetParams, sanitizeParams } from './registry.js';
import { PAD_BASE, PAD_COUNT, PAD_KITS, parsePads, stringifyPads, type PadSlot } from './pads.js';
import { dbToGain } from './dsp.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new Error(`${what} não encontrado`);
  return v;
};

/** Tracks que faltam até `track` (índice 0). */
function trackOps(p: Project, track: number): Op[] {
  const ops: Op[] = [];
  for (let t = p.tracks.length; t <= track; t++) ops.push(ins(['tracks'], { id: uid('t'), name: `Track ${t + 1}`, color: color(t), mute: false }));
  return ops;
}

/** Primeiro insert livre (sem canais, sem efeitos, nome padrão). */
function freeInsert(p: Project): number {
  for (let i = 1; i < p.mixer.length; i++) {
    const used = p.channels.some((c) => c.insert === i);
    if (!used && /^Insert \d+$/.test(p.mixer[i].name) && p.mixer[i].effects.length === 0) return i;
  }
  return 0;
}

/** Valor normalizado (0..1) → unidade do parâmetro. */
export const fromNorm = (t: AutoTarget, v: number) => (t.log && t.min > 0 ? t.min * Math.pow(t.max / t.min, v) : t.min + v * (t.max - t.min));

// ------------------------------------------------------------ canais

/**
 * Duplica um canal: instrumento, parâmetros, efeitos do canal, volume, pan, nota raiz.
 * insert: 'same' (padrão, o mesmo do original), 'auto' (insert livre com o nome do canal),
 * 'master' ou número/nome. copyNotes: copia as notas do original para o novo em todos os
 * patterns (true) ou só nos patterns listados.
 */
export function duplicateChannel(
  p: Project,
  a: { channel: string; name?: string; insert?: number | string; copyNotes?: boolean | string[]; params?: Record<string, unknown>; volumeDb?: number },
): ActionResult {
  const src = channelRef(p, a.channel);
  const ch: Channel = clone(src);
  ch.id = uid('c');
  ch.name = a.name ?? `${src.name} (cópia)`;
  ch.effects = (src.effects ?? []).map((e) => ({ ...clone(e), id: uid('e') }));
  if (a.params) ch.params = { ...ch.params, ...sanitizeParams(INSTRUMENTS[ch.type].params, a.params) };
  if (a.volumeDb !== undefined) ch.volume = dbToGain(a.volumeDb);
  const ops: Op[] = [];
  const ins0 = a.insert ?? 'same';
  if (ins0 === 'same') ch.insert = src.insert;
  else if (ins0 === 'master') ch.insert = 0;
  else if (ins0 === 'auto') {
    ch.insert = freeInsert(p);
    if (ch.insert > 0) ops.push(set(['mixer', ch.insert, 'name'], ch.name));
  } else ch.insert = insertRef(p, ins0);
  const idx = p.channels.findIndex((c) => c.id === src.id);
  ops.unshift(ins(['channels'], ch, idx + 1));
  let copied = 0;
  if (a.copyNotes) {
    const only = Array.isArray(a.copyNotes) ? a.copyNotes.map((r) => patternRef(p, r).id) : null;
    for (const pat of p.patterns) {
      if (only && !only.includes(pat.id)) continue;
      const list = pat.notes[src.id];
      if (!list?.length) continue;
      ops.push(set(['patterns', pat.id, 'notes', ch.id], list.map((n) => ({ ...n, id: uid('n') }))));
      copied += list.length;
    }
  }
  return { ops, result: { id: ch.id, name: ch.name, insert: ch.insert, effects: ch.effects.length, notesCopied: copied } };
}

// ------------------------------------------------------------ notas

/**
 * Copia notas de um pattern/canal para outro pattern/canal. toPattern que não existe é
 * criado (mesmo tamanho do original). Trecho opcional (fromBeat..toBeat) e destino
 * (atBeat; padrão: mesma posição). transpose em semitons; replace apaga antes as notas
 * do canal de destino no pattern de destino.
 */
export function copyNotes(
  p: Project,
  a: { fromPattern: string; fromChannel?: string; toPattern: string; toChannel?: string; fromBeat?: number; toBeat?: number; atBeat?: number; transpose?: number; replace?: boolean },
): ActionResult {
  const src = patternRef(p, a.fromPattern);
  const ops: Op[] = [];
  let dst = findPattern(p, a.toPattern);
  let created = false;
  if (!dst) {
    dst = { id: uid('p'), name: a.toPattern, color: color(p.patterns.length), length: src.length, notes: {} } as Pattern;
    ops.push(ins(['patterns'], dst, p.patterns.findIndex((x) => x.id === src.id) + 1));
    created = true;
  }
  const lo = (a.fromBeat ?? 0) * PPQ, hi = a.toBeat !== undefined ? a.toBeat * PPQ : Infinity;
  const shift = a.atBeat !== undefined ? a.atBeat * PPQ - lo : 0;
  const fromCh = a.fromChannel ? channelRef(p, a.fromChannel).id : null;
  const toCh = a.toChannel ? channelRef(p, a.toChannel).id : null;
  const out = new Map<string, Note[]>();
  let n = 0;
  for (const [chId, list] of Object.entries(src.notes)) {
    if (fromCh && chId !== fromCh) continue;
    const target = toCh ?? chId;
    for (const note of list) {
      if (note.pos < lo || note.pos >= hi) continue;
      if (!out.has(target)) out.set(target, []);
      out.get(target)!.push({ ...note, id: uid('n'), pos: Math.max(0, note.pos + shift), key: Math.max(0, Math.min(127, note.key + (a.transpose ?? 0))) });
      n++;
    }
  }
  for (const [chId, list] of out) {
    const before = a.replace || created ? [] : (dst.notes[chId] ?? []);
    ops.push(set(['patterns', dst.id, 'notes', chId], [...before, ...list]));
  }
  return { ops, result: { pattern: dst.name, id: dst.id, created, notes: n } };
}

// ------------------------------------------------------------ clipes da playlist

export interface ClipFilter {
  clipIds?: string[];
  /** Track (base 1). */
  track?: number;
  /** Clipes que começam a partir deste compasso (base 1)... */
  fromBar?: number;
  /** ...e antes do fim deste compasso (inclusive). */
  toBar?: number;
  pattern?: string;
  kind?: 'pattern' | 'audio' | 'auto';
  /** Automação: parte do nome do alvo ("corte", "BPM"). */
  automation?: string;
}

/** Clipes que casam com o filtro (todos, se o filtro estiver vazio). */
export function findClips(p: Project, f: ClipFilter): Clip[] {
  const bar = ticksPerBar(p);
  if (f.clipIds?.length) return f.clipIds.map((id) => need(p.clips.find((c) => c.id === id), `Clipe ${id}`));
  const lo = f.fromBar ? (f.fromBar - 1) * bar : 0;
  const hi = f.toBar ? f.toBar * bar : Infinity;
  const patId = f.pattern ? patternRef(p, f.pattern).id : null;
  return p.clips.filter((c) => {
    if (f.track !== undefined && c.track !== f.track - 1) return false;
    if (c.pos < lo || c.pos >= hi) return false;
    if (patId && c.patternId !== patId) return false;
    const kind = c.kind ?? 'pattern';
    if (f.kind && kind !== f.kind) return false;
    if (f.automation && !(kind === 'auto' && c.target?.label.toLowerCase().includes(f.automation.toLowerCase()))) return false;
    return true;
  });
}

/** Anda o começo de um clipe d ticks sem mexer no conteúdo (como puxar a borda esquerda). */
export function trimClipStart(p: Project, c: Clip, d: number): Clip {
  d = Math.max(-c.pos, Math.min(c.len - 1, Math.round(d)));
  if (c.kind === 'auto') return trimAutoStart(c, d);
  if (c.kind === 'audio') {
    const secPerTick = 60 / (p.bpm * PPQ);
    d = Math.max(d, -Math.floor((c.startSec ?? 0) / secPerTick));
    return { ...c, pos: c.pos + d, len: c.len - d, startSec: Math.max(0, (c.startSec ?? 0) + d * secPerTick) };
  }
  const pat = p.patterns.find((q) => q.id === c.patternId);
  const plen = pat ? patternLength(p, pat) : c.len;
  return { ...c, pos: c.pos + d, len: c.len - d, offset: (((c.offset + d) % plen) + plen) % plen };
}

/**
 * Edita clipes (por ids ou filtro): mover (moveBars/moveTracks relativos, ou toBar/toTrack
 * para o primeiro do grupo), tamanho (lengthBars; automação de função se recalcula),
 * cortar/estender o começo (trimStartBars), mudo, ganho/insert de áudio, duplicar
 * (duplicate: cópias logo depois do grupo ou em toBar/toTrack) e apagar.
 */
export function editClips(
  p: Project,
  a: ClipFilter & {
    moveBars?: number;
    moveTracks?: number;
    toBar?: number;
    toTrack?: number;
    lengthBars?: number;
    trimStartBars?: number;
    mute?: boolean;
    gainDb?: number;
    insert?: number | string;
    duplicate?: { times?: number; toBar?: number; toTrack?: number };
    remove?: boolean;
  },
): ActionResult {
  const bar = ticksPerBar(p);
  const clips = findClips(p, a);
  if (!clips.length) throw new Error('Nenhum clipe casou com o filtro');
  if (a.remove) return { ops: clips.map((c) => rem(['clips', c.id])), result: { removed: clips.length } };
  const minPos = Math.min(...clips.map((c) => c.pos));
  const minTrack = Math.min(...clips.map((c) => c.track));
  const dt = a.toBar !== undefined ? Math.round((a.toBar - 1) * bar) - minPos : Math.round((a.moveBars ?? 0) * bar);
  const dtr = a.toTrack !== undefined ? a.toTrack - 1 - minTrack : (a.moveTracks ?? 0);
  if (minPos + dt < 0) throw new Error('O grupo ficaria antes do compasso 1');
  if (minTrack + dtr < 0) throw new Error('O grupo ficaria acima da track 1');
  const ops: Op[] = [];
  const edited = clips.map((c0) => {
    let c: Clip = { ...c0, pos: c0.pos + dt, track: c0.track + dtr };
    if (a.trimStartBars) c = trimClipStart(p, c, a.trimStartBars * bar);
    if (a.lengthBars !== undefined) c = regen({ ...c, len: Math.max(1, Math.round(a.lengthBars * bar)) });
    if (a.mute !== undefined) c = { ...c, muted: a.mute || undefined };
    if (c.kind === 'audio' && a.gainDb !== undefined) c = { ...c, gain: dbToGain(a.gainDb) };
    if (c.kind === 'audio' && a.insert !== undefined) c = { ...c, insert: insertRef(p, a.insert) };
    return c;
  });
  const maxTrack = Math.max(...edited.map((c) => c.track));
  ops.push(...trackOps(p, maxTrack));
  if (a.duplicate) {
    // cópias do grupo já editado: logo depois do fim dele, ou a partir de toBar/toTrack
    const g0 = Math.min(...edited.map((c) => c.pos)), g1 = Math.max(...edited.map((c) => c.pos + c.len));
    const gTrack = Math.min(...edited.map((c) => c.track));
    const times = Math.max(1, a.duplicate.times ?? 1);
    const ids: string[] = [];
    for (let k = 0; k < times; k++) {
      const base = a.duplicate.toBar !== undefined ? Math.round((a.duplicate.toBar - 1) * bar) + k * (g1 - g0) : g1 + k * (g1 - g0);
      const tr = a.duplicate.toTrack !== undefined ? a.duplicate.toTrack - 1 - gTrack : 0;
      for (const c of edited) {
        const copy = { ...clone(c), id: uid('k'), pos: base + (c.pos - g0), track: c.track + tr };
        ops.push(...trackOps(p, copy.track), ins(['clips'], copy));
        ids.push(copy.id);
      }
    }
    // o original também recebe o que foi editado
    for (const c of edited) ops.unshift(set(['clips', c.id], c));
    return { ops, result: { edited: edited.length, copies: ids } };
  }
  for (const c of edited) ops.push(set(['clips', c.id], c));
  return { ops, result: { edited: edited.length } };
}

/** Clipes que tocam em [lo, hi) cortados para caber nesse trecho (cópia; o original fica). */
function sliceClips(p: Project, lo: number, hi: number, tracks?: number[]) {
  const out: Clip[] = [];
  for (const c of p.clips) {
    if (tracks && !tracks.includes(c.track + 1)) continue;
    if (c.pos >= hi || c.pos + c.len <= lo) continue;
    let k: Clip = clone(c);
    if (k.pos < lo) k = trimClipStart(p, k, lo - k.pos);
    if (k.pos + k.len > hi) k = { ...k, len: hi - k.pos, ...(k.kind === 'auto' && k.gen && !k.gen.custom ? { gen: { ...k.gen, custom: true } } : {}) };
    out.push(k);
  }
  return out;
}

/** Abre espaço: tudo que começa em atBar ou depois anda `bars` compassos para a direita. */
export function insertBars(p: Project, a: { atBar: number; bars: number }): ActionResult {
  const bar = ticksPerBar(p);
  const at = (a.atBar - 1) * bar, d = Math.round(a.bars * bar);
  const moved = p.clips.filter((c) => c.pos >= at);
  return { ops: moved.map((c) => set(['clips', c.id, 'pos'], c.pos + d)), result: { moved: moved.length } };
}

/**
 * Apaga os compassos fromBar..toBar (inclusive) e puxa o resto para a esquerda; clipes
 * que atravessam o trecho são cortados.
 */
export function deleteBars(p: Project, a: { fromBar: number; toBar: number }): ActionResult {
  const bar = ticksPerBar(p);
  const lo = (a.fromBar - 1) * bar, hi = a.toBar * bar, d = hi - lo;
  if (d <= 0) throw new Error('toBar deve ser ≥ fromBar');
  const ops: Op[] = [];
  let removed = 0;
  for (const c of p.clips) {
    const end = c.pos + c.len;
    if (end <= lo) continue;
    if (c.pos >= hi) {
      ops.push(set(['clips', c.id, 'pos'], c.pos - d));
      continue;
    }
    if (c.pos >= lo && end <= hi) {
      ops.push(rem(['clips', c.id]));
      removed++;
      continue;
    }
    if (c.pos < lo && end > hi) {
      // atravessa o trecho inteiro: encolhe (o conteúdo depois do trecho fica para depois)
      ops.push(set(['clips', c.id], regen({ ...c, len: c.len - d })));
      continue;
    }
    if (c.pos < lo) ops.push(set(['clips', c.id], regen({ ...c, len: lo - c.pos })));
    else ops.push(set(['clips', c.id], { ...trimClipStart(p, c, hi - c.pos), pos: lo }));
  }
  return { ops, result: { removed, cut: a.toBar - a.fromBar + 1 } };
}

/**
 * Copia um trecho da música (todas as tracks, ou só as listadas) para atBar. insert=true
 * abre espaço antes (o que vinha depois anda para a direita). times = quantas cópias
 * seguidas. É o "repete a intro" / "copia o refrão para o fim".
 */
export function copySection(p: Project, a: { fromBar: number; toBar: number; atBar: number; insert?: boolean; times?: number; tracks?: number[] }): ActionResult {
  const bar = ticksPerBar(p);
  const lo = (a.fromBar - 1) * bar, hi = a.toBar * bar, len = hi - lo;
  if (len <= 0) throw new Error('toBar deve ser ≥ fromBar');
  const times = Math.max(1, a.times ?? 1);
  const src = sliceClips(p, lo, hi, a.tracks);
  const at = (a.atBar - 1) * bar;
  const ops: Op[] = [];
  if (a.insert) ops.push(...insertBars(p, { atBar: a.atBar, bars: (len / bar) * times }).ops);
  const ids: string[] = [];
  for (let k = 0; k < times; k++)
    for (const c of src) {
      const copy = { ...clone(c), id: uid('k'), pos: at + k * len + (c.pos - lo) };
      ops.push(ins(['clips'], copy));
      ids.push(copy.id);
    }
  return { ops, result: { clips: ids.length, bars: (len / bar) * times } };
}

// ------------------------------------------------------------ automação (Central)

export interface FnInput {
  /** Função pronta da Central (riser, riser-exp, fade-in, fade-out, s-curve, sine, breathe, accel, wobble, gate, saw, pump, steps, random). */
  preset?: string;
  kind?: GenKind;
  wave?: Wave;
  /** Rampa/escada: valor inicial e final, na unidade do parâmetro. */
  from?: number;
  to?: number;
  /** Ondas/bombeamento/aleatório: faixa, na unidade do parâmetro. */
  min?: number;
  max?: number;
  curve?: number;
  s?: boolean;
  period?: number;
  periodEnd?: number;
  breathe?: number;
  breathePeriod?: number;
  depth?: number;
  depthEnd?: number;
  phase?: number;
  release?: number;
  count?: number;
  smooth?: number;
  seed?: number;
  grid?: number;
  quantize?: boolean;
}

/** Monta a função (gen) da Central a partir de uma descrição em unidades do parâmetro. */
export function buildGen(target: AutoTarget, f: FnInput, base?: AutoGen): AutoGen {
  const pr = f.preset ? GEN_PRESETS.find((x) => x.id === f.preset || x.label.toLowerCase() === f.preset!.toLowerCase()) : undefined;
  if (f.preset && !pr) throw new Error(`Função "${f.preset}" não existe. Opções: ${GEN_PRESETS.map((x) => x.id).join(', ')}`);
  const g: AutoGen = { ...(base && !pr ? base : {}), ...(pr ? clone(pr.gen) : {}), ...(pr ? { preset: pr.id } : {}), custom: false } as AutoGen;
  if (!g.kind) g.kind = f.kind ?? 'ramp';
  if (f.kind) g.kind = f.kind;
  const keys = ['wave', 'curve', 's', 'period', 'periodEnd', 'breathe', 'breathePeriod', 'depth', 'depthEnd', 'phase', 'release', 'count', 'smooth', 'seed', 'grid', 'quantize'] as const;
  for (const k of keys) if (f[k] !== undefined) (g as unknown as Record<string, unknown>)[k] = f[k];
  // a rampa não tem período: se pediram período, é LFO
  if (g.kind === 'ramp' && f.period !== undefined && !f.kind) g.kind = 'lfo';
  if (f.from !== undefined) g.lo = toNorm(target, f.from);
  if (f.to !== undefined) g.hi = toNorm(target, f.to);
  if (f.min !== undefined) g.lo = toNorm(target, f.min);
  if (f.max !== undefined) g.hi = toNorm(target, f.max);
  if (g.lo === undefined) g.lo = GEN_DEFAULTS.lo;
  if (g.hi === undefined) g.hi = GEN_DEFAULTS.hi;
  return g;
}

/** Alvo da automação: { param: 'bpm' } ou a descrição de sempre (canal/insert/efeito + param). */
export function resolveTarget(p: Project, d: AutoDescriptor): AutoTarget {
  if (d.param === 'bpm' && !d.channel && d.insert === undefined) return { path: ['bpm'], min: 40, max: 240, label: 'BPM' };
  return autoTarget(p, d);
}

/**
 * Clipe de automação. Com fn usa as funções da Central (recalcula ao redimensionar, abre
 * na Central para ajustar); com points usa pontos [{beat, value}]; sem nada, uma linha no
 * valor atual. param 'bpm' (sem canal/insert) automatiza o andamento.
 */
export function automate(
  p: Project,
  a: AutoDescriptor & { bar?: number; bars?: number; track?: number; fn?: FnInput; points?: { beat: number; value: number }[] },
): ActionResult {
  const target = resolveTarget(p, a);
  const bar = ticksPerBar(p);
  const pos = Math.round(((a.bar ?? 1) - 1) * bar);
  const len = Math.round((a.bars ?? 4) * bar);
  const track = a.track !== undefined ? a.track - 1 : freeTrack(p, pos, len);
  let gen: AutoGen | undefined;
  let points;
  if (a.fn) {
    gen = buildGen(target, a.fn);
    points = renderGen(gen, len);
  } else if (a.points?.length) points = a.points.map((x) => ({ t: Math.max(0, Math.min(len, Math.round(x.beat * PPQ))), v: toNorm(target, x.value) })).sort((x, y) => x.t - y.t);
  else {
    const now = target.path[0] === 'bpm' ? toNorm(target, p.bpm) : normalizedNow(p, target);
    points = [
      { t: 0, v: now },
      { t: len, v: now },
    ];
  }
  const clip: Clip = { id: uid('k'), kind: 'auto', track, pos, len, patternId: '', offset: 0, target, points, ...(gen ? { gen } : {}) };
  return { ops: [...trackOps(p, track), ins(['clips'], clip)], result: { clip: clip.id, track: track + 1, target: target.label, points: points.length, ...(gen ? { fn: describeGen(target, gen) } : {}) } };
}

/**
 * Edita um clipe de automação: fn muda a função (mescla com a atual; preset troca a
 * forma), points troca por pontos (vira personalizada), custom:false volta à função.
 */
export function editAutomation(p: Project, a: { clip: string; fn?: FnInput; points?: { beat: number; value: number }[]; custom?: boolean }): ActionResult {
  const c = need(p.clips.find((x) => x.id === a.clip && x.kind === 'auto'), `Automação ${a.clip}`);
  const target = c.target!;
  let next: Clip = { ...c };
  if (a.fn) {
    const gen = buildGen(target, a.fn, c.gen);
    next = { ...next, gen, points: renderGen(gen, c.len) };
  }
  if (a.points?.length) {
    next = {
      ...next,
      points: a.points.map((x) => ({ t: Math.max(0, Math.min(c.len, Math.round(x.beat * PPQ))), v: toNorm(target, x.value) })).sort((x, y) => x.t - y.t),
      ...(next.gen ? { gen: { ...next.gen, custom: true } } : {}),
    };
  }
  if (a.custom === false && next.gen) next = regen({ ...next, gen: { ...next.gen, custom: false } });
  return { ops: [set(['clips', c.id], next)], result: { clip: c.id, points: next.points?.length, ...(next.gen ? { fn: describeGen(target, next.gen) } : {}) } };
}

/** A função de um clipe em linguagem legível (faixa na unidade do parâmetro). */
export function describeGen(t: AutoTarget, g: AutoGen) {
  const unit = (v: number) => Math.round(fromNorm(t, v) * 100) / 100;
  const d = { ...GEN_DEFAULTS, ...g };
  const base = { preset: g.preset, kind: g.kind, custom: g.custom || undefined, grid: d.grid || 'livre' };
  if (g.kind === 'ramp') return { ...base, from: unit(d.lo), to: unit(d.hi), curve: d.curve, s: d.s || undefined };
  if (g.kind === 'steps') return { ...base, from: unit(d.lo), to: unit(d.hi), count: d.count, curve: d.curve };
  if (g.kind === 'lfo')
    return { ...base, wave: d.wave, min: unit(d.lo), max: unit(d.hi), period: d.period, periodEnd: d.periodEnd, breathe: d.breathe || undefined, breathePeriod: d.breathe ? d.breathePeriod : undefined, depth: d.depth, depthEnd: d.depthEnd, phase: d.phase, quantize: d.quantize || undefined };
  if (g.kind === 'pump') return { ...base, min: unit(d.lo), max: unit(d.hi), period: d.period, release: d.release, curve: d.curve };
  return { ...base, min: unit(d.lo), max: unit(d.hi), period: d.period, smooth: d.smooth, seed: d.seed };
}

// ------------------------------------------------------------ mixer

/** Volta um insert ao padrão (nome, volume, pan, efeitos, rota). Canais ligados a ele continuam ligados. */
export function resetInsert(p: Project, a: { insert: number | string }): ActionResult {
  const i = insertRef(p, a.insert);
  if (i === 0) throw new Error('O master não pode ser resetado');
  const fresh = { ...makeInsert(i), id: p.mixer[i].id };
  return { ops: [set(['mixer', i], fresh)], result: { insert: i, name: fresh.name, channels: p.channels.filter((c) => c.insert === i).map((c) => c.name) } };
}

/** Copia os efeitos de um canal/insert para outro canal/insert (replace apaga os do destino). */
export function copyEffects(
  p: Project,
  a: { fromChannel?: string; fromInsert?: number | string; toChannel?: string; toInsert?: number | string; replace?: boolean },
): ActionResult {
  if (!a.fromChannel && a.fromInsert === undefined) throw new Error('Informe a origem (fromChannel ou fromInsert)');
  const fx: Effect[] = a.fromChannel ? (channelRef(p, a.fromChannel).effects ?? []) : p.mixer[insertRef(p, a.fromInsert!)].effects;
  const copies = fx.map((e) => ({ ...clone(e), id: uid('e') }));
  if (a.toChannel) {
    const ch = channelRef(p, a.toChannel);
    const list = [...(a.replace ? [] : (ch.effects ?? [])), ...copies];
    if (list.length > 4) throw new Error(`Um canal tem no máximo 4 efeitos (ficaria com ${list.length}); use replace ou um insert`);
    return { ops: [set(['channels', ch.id, 'effects'], list)], result: { copied: copies.length } };
  }
  if (a.toInsert !== undefined) {
    const i = insertRef(p, a.toInsert);
    return { ops: [set(['mixer', i, 'effects'], [...(a.replace ? [] : p.mixer[i].effects), ...copies])], result: { copied: copies.length } };
  }
  throw new Error('Informe o destino (toChannel ou toInsert)');
}

// ------------------------------------------------------------ lista de áudios do projeto

export function audioRef(p: Project, ref: string): AudioItem {
  const list = p.audios ?? [];
  return need(list.find((x) => x.id === ref) ?? list.find((x) => x.name.toLowerCase() === ref.toLowerCase()) ?? list.find((x) => x.path === ref), `Áudio "${ref}"`);
}

/** Põe um arquivo na lista de áudios do projeto (a que fica ao lado dos patterns). */
export function addAudio(p: Project, a: { path: string; name?: string; variantOf?: string }): ActionResult {
  const hit = (p.audios ?? []).find((x) => x.path === a.path || x.original === a.path);
  if (hit) return { ops: [], result: { id: hit.id, name: hit.name, existed: true } };
  const parent = a.variantOf ? audioRef(p, a.variantOf).id : undefined;
  const item: AudioItem = { id: uid('au'), name: a.name ?? (a.path.split(/[\\/]/).pop() ?? a.path).replace(/\.[a-z0-9]{2,5}$/i, ''), path: a.path, original: a.path, ...(parent ? { variantOf: parent } : {}) };
  return { ops: [ins(['audios'], item)], result: { id: item.id, name: item.name } };
}

export function renameAudio(p: Project, a: { audio: string; name: string }): ActionResult {
  const it = audioRef(p, a.audio);
  return { ops: [set(['audios', it.id, 'name'], a.name)], result: { id: it.id } };
}

/** Tira da lista (o arquivo continua salvo e os clipes na playlist não mudam). */
export function removeAudio(p: Project, a: { audio: string }): ActionResult {
  const it = audioRef(p, a.audio);
  return { ops: [rem(['audios', it.id])], result: { removed: it.name } };
}

/**
 * Liga/desliga as edições de um áudio (Melodify): desligar volta ao original guardando a
 * versão editada; ligar volta à editada. Os clipes da playlist acompanham.
 */
export function toggleAudioEdits(p: Project, a: { audio: string; on?: boolean }): ActionResult {
  const it = audioRef(p, a.audio);
  const isOn = it.path !== it.original;
  const want = a.on ?? !isOn;
  if (want === isOn) return { ops: [], result: { edits: isOn ? 'ligadas' : 'desligadas' } };
  if (!want && isOn) {
    const ops: Op[] = [set(['audios', it.id, 'edited'], it.path), set(['audios', it.id, 'path'], it.original)];
    for (const c of p.clips) if (c.sample === it.path) ops.push(set(['clips', c.id, 'sample'], it.original));
    return { ops, result: { edits: 'desligadas' } };
  }
  if (!it.edited) throw new Error(`"${it.name}" não tem edições guardadas`);
  const ops: Op[] = [set(['audios', it.id, 'path'], it.edited), set(['audios', it.id, 'edited'], undefined)];
  for (const c of p.clips) if (c.sample === it.path) ops.push(set(['clips', c.id, 'sample'], it.edited));
  return { ops, result: { edits: 'ligadas' } };
}

// ------------------------------------------------------------ leitura detalhada (MCP)

const db = (g: number) => Math.round(20 * Math.log10(Math.max(1e-6, g)) * 10) / 10;

/** Tudo de um canal: parâmetros, efeitos com parâmetros, insert e notas por pattern. */
export function channelDetail(p: Project, ref: string) {
  const c = channelRef(p, ref);
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    insert: c.insert,
    insertName: p.mixer[c.insert]?.name,
    volumeDb: db(c.volume),
    pan: c.pan,
    mute: c.mute,
    root: noteName(60 - c.pitch),
    fineCents: c.fine,
    params: c.params,
    effects: (c.effects ?? []).map((e) => ({ id: e.id, type: e.type, enabled: e.enabled, mix: Math.round(e.mix * 1000) / 1000, params: e.params })),
    notesByPattern: Object.fromEntries(p.patterns.filter((pt) => pt.notes[c.id]?.length).map((pt) => [pt.name, pt.notes[c.id].length])),
    automations: p.clips.filter((k) => k.kind === 'auto' && k.target?.path[1] === c.id).map((k) => ({ clip: k.id, label: k.target!.label })),
  };
}

/** Mixer completo: inserts com efeitos e parâmetros, rotas e canais ligados. */
export function mixerDetail(p: Project, all = false) {
  return p.mixer
    .map((m, i) => ({
      i,
      name: m.name,
      volumeDb: db(m.volume),
      pan: m.pan,
      mute: m.mute || undefined,
      solo: m.solo || undefined,
      output: i > 0 ? m.output : undefined,
      channels: p.channels.filter((c) => c.insert === i).map((c) => c.name),
      effects: m.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled, mix: Math.round(e.mix * 1000) / 1000, params: e.params })),
    }))
    .filter((m) => all || m.i === 0 || m.channels.length || m.effects.length || !/^Insert \d+$/.test(m.name));
}

/** Clipes com todos os detalhes (filtro opcional); automação mostra a função na unidade do parâmetro. */
export function clipsDetail(p: Project, f: ClipFilter, points = false) {
  const bar = ticksPerBar(p);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return findClips(p, f)
    .slice()
    .sort((a, b) => a.pos - b.pos || a.track - b.track)
    .map((c) => {
      const base = { id: c.id, track: c.track + 1, trackName: p.tracks[c.track]?.name, bar: r(c.pos / bar + 1), bars: r(c.len / bar), muted: c.muted || undefined };
      if (c.kind === 'audio') {
        const it = (p.audios ?? []).find((x) => x.path === c.sample);
        // canal de áudio por onde o clipe toca (volume, efeitos e o insert de verdade)
        const ach = c.channel ? p.channels.find((x) => x.id === c.channel) : undefined;
        return { ...base, kind: 'audio', audio: it?.name, file: c.sample, channel: ach?.name, insert: ach ? ach.insert : (c.insert ?? 0), startSec: r(c.startSec ?? 0), gainDb: db(c.gain ?? 1), ...(it?.raw ? { reamp: true } : {}) };
      }
      if (c.kind === 'auto') {
        const t = c.target!;
        const pts = c.points ?? [];
        return {
          ...base,
          kind: 'auto',
          target: t.label,
          range: [t.min, t.max],
          fn: c.gen ? describeGen(t, c.gen) : undefined,
          points: pts.length,
          ...(points || pts.length <= 16 ? { values: pts.map((x) => ({ beat: r(x.t / PPQ), value: r(fromNorm(t, x.v)) })) } : { start: r(fromNorm(t, pts[0]?.v ?? 0)), end: r(fromNorm(t, pts[pts.length - 1]?.v ?? 0)) }),
        };
      }
      const pat = p.patterns.find((x) => x.id === c.patternId);
      return { ...base, kind: 'pattern', pattern: pat?.name, offsetBeats: c.offset ? r(c.offset / PPQ) : undefined };
    });
}


// ------------------------------------------------------------ rack: preencher e substituir

/**
 * Preenche os steps de um canal no pattern a cada `every` steps (1 = todo step, 2 = a
 * cada colcheia, 4 = a cada tempo...), começando em `offset`. Usa a nota que o canal já
 * toca nesse pattern (ou a informada). Substitui as notas do canal no pattern.
 */
export function fillSteps(p: Project, a: { pattern: string; channel: string; every: number; offset?: number; note?: number | string; velocity?: number }): ActionResult {
  const pat = patternRef(p, a.pattern);
  const ch = channelRef(p, a.channel);
  const every = Math.max(1, Math.round(a.every));
  const steps = Math.round(patternLength(p, pat) / STEP);
  const cur = pat.notes[ch.id] ?? [];
  const key = a.note !== undefined ? parseNote(a.note) : (cur[0]?.key ?? (ch.type === 'pads' ? PAD_BASE : 60));
  const notes: Note[] = [];
  for (let i = Math.max(0, a.offset ?? 0); i < steps; i += every) notes.push({ id: uid('n'), key, pos: i * STEP, len: STEP, vel: a.velocity ?? 0.78 });
  return { ops: [set(['patterns', pat.id, 'notes', ch.id], notes)], result: { steps, hits: notes.length } };
}

/** Nota mais tocada pelo canal em todos os patterns (null se não tem notas). */
function dominantKey(p: Project, chId: string): number | null {
  const count = new Map<number, number>();
  for (const pat of p.patterns) for (const n of pat.notes[chId] ?? []) count.set(n.key, (count.get(n.key) ?? 0) + 1);
  let best: number | null = null, bn = 0;
  for (const [k, n] of count) if (n > bn) (best = k), (bn = n);
  return best;
}

/**
 * Troca o instrumento de um canal mantendo tudo o mais: notas em todos os patterns,
 * efeitos, insert, volume, pan, automações. type/preset/params como no update_channel
 * (sampler: params.sample = arquivo ou pasta). Sample de um tiro (bateria): a nota raiz
 * vira a nota que o canal toca, para o sample soar na altura original.
 */
export function replaceInstrument(
  p: Project,
  a: { channel: string; type?: InstrumentType; preset?: string; params?: Record<string, unknown>; name?: string },
): ActionResult {
  const ch = channelRef(p, a.channel);
  const ops = updateChannel(p, { channel: ch.id, type: a.type, preset: a.preset, params: a.params, name: a.name }).ops;
  const type = a.preset ? undefined : a.type;
  const oneShot = (type === 'sampler' || (!type && ch.type === 'sampler')) && !!a.params?.oneshot;
  const key = dominantKey(p, ch.id);
  if (oneShot && key !== null) ops.push(set(['channels', ch.id, 'pitch'], 60 - key));
  return { ops, result: { channel: ch.id, name: a.name ?? ch.name, ...(oneShot && key !== null ? { root: noteName(key) } : {}) } };
}

// ------------------------------------------------------------ Soundpad

/**
 * Mexe num pad de um canal Soundpad (pad 1..16; 1 = embaixo à esquerda = C2). Som: sample
 * (arquivo ou pasta de instrumento), type (+ params) ou preset; name, gain (dB), tune
 * (semitons); clear esvazia. kit troca a grade inteira por um kit pronto.
 */
export function setPad(
  p: Project,
  a: { channel: string; pad?: number; name?: string; sample?: string; type?: InstrumentType; preset?: string; params?: Record<string, unknown>; gain?: number; tune?: number; note?: number | string; clear?: boolean; kit?: string },
): ActionResult {
  const ch = channelRef(p, a.channel);
  if (ch.type !== 'pads') throw new Error(`"${ch.name}" não é um Soundpad`);
  if (a.kit) {
    const kit = PAD_KITS.find((k) => k.id === a.kit || k.label.toLowerCase() === a.kit!.toLowerCase());
    if (!kit) throw new Error(`Kit "${a.kit}" não existe. Opções: ${PAD_KITS.map((k) => k.id).join(', ')}`);
    return { ops: [set(['channels', ch.id, 'params', 'pads'], stringifyPads(kit.pads))], result: { kit: kit.label } };
  }
  const i = Math.round(a.pad ?? 0) - 1;
  if (i < 0 || i >= PAD_COUNT) throw new Error('pad vai de 1 a 16 (1 = embaixo à esquerda)');
  const pads = parsePads(ch.params.pads);
  let slot: PadSlot | null = pads[i];
  if (a.clear) slot = null;
  else {
    if (a.preset) {
      const pr = need(presetParams(a.preset), `Preset ${a.preset}`);
      slot = { name: a.name ?? a.preset, type: pr.type, params: pr.params, gain: slot?.gain, tune: slot?.tune };
    } else if (a.sample) slot = { name: a.name ?? (a.sample.split(/[\\/]/).pop() ?? a.sample).replace(/\.[a-z0-9]{2,5}$/i, ''), sample: a.sample, params: (a.params as PadSlot['params']) ?? {}, gain: slot?.gain, tune: slot?.tune };
    else if (a.type) {
      if (a.type === 'pads') throw new Error('Um pad não pode ter outro Soundpad');
      slot = { name: a.name ?? INSTRUMENTS[a.type].label, type: a.type, params: sanitizeParams(INSTRUMENTS[a.type].params, a.params ?? {}), gain: slot?.gain, tune: slot?.tune };
    }
    if (!slot) throw new Error(`O pad ${i + 1} está vazio: informe sample, type ou preset`);
    if (a.name !== undefined) slot = { ...slot, name: a.name };
    if (a.gain !== undefined) slot = { ...slot, gain: a.gain };
    if (a.tune !== undefined) slot = { ...slot, tune: Math.round(a.tune) };
    if (a.note !== undefined) slot = { ...slot, note: parseNote(a.note) };
  }
  pads[i] = slot;
  return { ops: [set(['channels', ch.id, 'params', 'pads'], stringifyPads(pads))], result: { pad: i + 1, note: noteName(PAD_BASE + i), name: slot?.name ?? null } };
}

// ---------------------------------------------------------------- andamento pelo áudio

/**
 * Muda o BPM do projeto sem estragar os áudios: cada clipe de áudio continua com a mesma
 * duração em segundos (o comprimento em ticks acompanha o novo tempo). Com `clip` e
 * `firstBeat` (segundos no arquivo, da detecção de BPM), esse clipe ainda é movido para o
 * primeiro tempo cair no começo de um compasso, ou seja, o áudio fica na grade.
 */
export function applyTempo(p: Project, a: { bpm: number; clip?: string; firstBeat?: number; align?: boolean }): ActionResult {
  const bpm = Math.max(20, Math.min(400, Math.round(a.bpm * 100) / 100));
  const k = bpm / p.bpm;
  const ops: Op[] = [set(['bpm'], bpm)];
  const moved: { id: string; pos: number }[] = [];
  for (const c of p.clips) {
    if (c.kind !== 'audio') continue;
    const len = Math.max(1, Math.round(c.len * k));
    if (len !== c.len) ops.push(set(['clips', c.id, 'len'], len));
  }
  if (a.clip && a.firstBeat !== undefined && a.align !== false) {
    const c = p.clips.find((x) => x.id === a.clip && x.kind === 'audio');
    if (!c) throw new Error(`Clipe de áudio "${a.clip}" não encontrado`);
    const tps = (bpm * PPQ) / 60; // ticks por segundo no novo tempo
    const period = 60 / bpm;
    const s0 = c.startSec ?? 0;
    // primeiro tempo dentro do trecho que o clipe toca
    const t = s0 + ((((a.firstBeat - s0) % period) + period) % period);
    const off = (t - s0) * tps;
    const bar = ticksPerBar(p);
    let pos = Math.round((c.pos + off) / bar) * bar - off;
    if (pos < 0) pos += Math.ceil(-pos / bar) * bar;
    pos = Math.round(pos);
    if (pos !== c.pos) {
      ops.push(set(['clips', c.id, 'pos'], pos));
      moved.push({ id: c.id, pos });
    }
  }
  return { ops, result: { bpm, from: p.bpm, audioClipsResized: ops.length - 1 - moved.length, aligned: moved } };
}

// ---------------------------------------------------------------- canal entre patterns

/**
 * Manda um canal para outro pattern: as notas dele saem do pattern de origem e vão para o
 * destino (somadas às que já houver lá), e o canal passa a ser do grupo do destino.
 * Sem `to`, cria um pattern novo (nome `newName` ou o do canal).
 */
export function moveChannelToPattern(p: Project, a: { channel: string; from: string; to?: string; newName?: string }): ActionResult {
  const ch = channelRef(p, a.channel);
  const from = patternRef(p, a.from);
  const ops: Op[] = [];
  let to: Pattern;
  if (a.to) to = patternRef(p, a.to);
  else {
    to = { id: uid('p'), name: a.newName ?? ch.name, color: color(p.patterns.length), length: from.length, notes: {}, channels: [] };
    ops.push(ins(['patterns'], to));
  }
  if (to.id === from.id) return { ops: [], result: { pattern: to.id } };
  const moving = from.notes[ch.id] ?? [];
  if (moving.length) {
    const target = [...(to.notes[ch.id] ?? []), ...moving.map((n) => ({ ...n, id: uid('n') }))];
    ops.push(rem(['patterns', from.id, 'notes', ch.id]));
    ops.push(set(['patterns', to.id, 'notes', ch.id], target));
  }
  if (from.channels?.includes(ch.id)) ops.push(set(['patterns', from.id, 'channels'], from.channels.filter((x) => x !== ch.id)));
  const toCh = to.channels ?? [];
  if (!toCh.includes(ch.id)) ops.push(set(['patterns', to.id, 'channels'], [...toCh, ch.id]));
  return { ops, result: { pattern: to.id, name: to.name, notes: moving.length } };
}
