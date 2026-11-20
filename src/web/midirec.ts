// Gravação de notas (teclado do computador, teclado MIDI, piano na tela) e de
// automações (knobs mexidos durante a gravação) pelo REC geral.
//
// As notas entram no pattern selecionado (como no FL): no clipe dele que está no
// ponto da gravação, ou num clipe novo dele ali. Com o loop ligado, cada volta é uma
// "passada" que se soma ao mesmo pattern assim que o loop recomeça (e já toca na
// volta seguinte). Automações viram clipes de automação.

import type { AutoTarget, Clip, Note, Pattern, Project } from '../core/model';
import { PPQ, STEP, uid, color, ticksPerBar, songLength, patternLength } from '../core/model';
import { ins, set, type Op } from '../core/ops';
import * as A from '../core/actions';
import { audio } from './audio';
import { state, edit, toast, selectPattern } from './state';

interface NoteEv {
  ch: string;
  key: number;
  vel: number;
  pass: number;
  on: number;
  off: number | null;
}
interface AutoEv {
  target: AutoTarget;
  pass: number;
  tick: number;
  v: number; // 0..1
  /** Valor do parâmetro antes de mexer (0..1): vale até o momento do primeiro toque. */
  before?: number;
}

/** Parâmetros mexidos nesta gravação (os knobs ficam destacados). */
const touched = new Set<string>();
export const recTouched = (key: string) => !!rec && touched.has(key);

let autoCache: { v: number; keys: Set<string> } | null = null;
/** O parâmetro já tem clipe de automação na playlist? */
export function hasAutomation(key: string) {
  const p = state.project;
  if (autoCache?.v !== state.version) autoCache = { v: state.version, keys: new Set(p.clips.filter((c) => c.kind === 'auto' && c.target).map((c) => c.target!.path.join('/'))) };
  return autoCache.keys.has(key);
}

let rec: {
  start: number;
  /** Área do loop (com o loop ligado): cada volta é uma passada. */
  region: [number, number] | null;
  notes: NoteEv[];
  autos: AutoEv[];
  /** Pattern que recebe as notas (o selecionado ao começar; se não houver, um criado na primeira passada). */
  patternId: string | null;
} | null = null;

export const midiRecording = () => !!rec;

/** Posição da música agora (estimada entre as atualizações da engine) e a passada. */
function now(): { tick: number; pass: number } | null {
  if (!rec) return null;
  const st = audio.status;
  const tps = (state.project.bpm * PPQ) / 60;
  const beat = PPQ / tps; // segundos por tempo
  // você reage ao que ouve, e o som chega aos ouvidos com o atraso da saída: desconta
  const ctx = (audio as unknown as { ctx?: AudioContext }).ctx;
  const outLat = ctx ? (ctx.baseLatency || 0) + ((ctx as unknown as { outputLatency?: number }).outputLatency || 0) : 0;
  const r = rec.region;
  if (st.playId !== audio.playId || !st.playing) {
    // o play acabou de ser pedido e a engine ainda não respondeu: estima pelo relógio
    // (antes isso perdia as primeiras notas)
    const el = (performance.now() - audio.playAt) / 1000 - outLat - audio.playCountIn * beat;
    if (el < -beat / 2) return null; // ainda no começo da contagem
    return { tick: audio.playFrom + Math.max(0, el) * tps, pass: 0 };
  }
  if (st.countIn > 0) {
    // na contagem: a nota tocada um pouco antes do "1" (até meio tempo) vale como o "1"
    const left = (st.countInTicks ?? st.countIn * PPQ) / tps - (performance.now() - audio.statusAt) / 1000 + outLat;
    return left <= beat / 2 ? { tick: rec.start, pass: 0 } : null;
  }
  let tick = st.tick + ((performance.now() - audio.statusAt) / 1000 - outLat) * tps;
  let pass = st.loops;
  if (r && tick >= r[1]) {
    tick = r[0] + (tick - r[1]);
    pass++;
  } else if (r && tick < r[0] && pass > 0) {
    // a engine já voltou, mas o que você ouve ainda é o fim da volta anterior
    tick = r[1] - (r[0] - tick);
    pass--;
  }
  return { tick, pass };
}

export function startMidiRec(start: number, region: [number, number] | null) {
  rec = { start, region, notes: [], autos: [], patternId: state.patternId };
  touched.clear();
  committed.clear();
  lastLoops = 0;
  nCommitted = { patterns: 0, notes: 0, autos: 0 };
}

/** Voltas do loop já transformadas em patterns (gravação aditiva). */
const committed = new Set<number>();
let lastLoops = 0;
let nCommitted = { patterns: 0, notes: 0, autos: 0 };

/**
 * A cada volta do loop, o que foi tocado na volta anterior vira pattern/automação
 * na hora — e já toca na próxima volta, por baixo do que você tocar agora.
 */
export function midiOnStatus(st: { loops: number; playing: boolean; countIn: number; playId?: number }) {
  if (!rec?.region || !st.playing || st.countIn || st.playId !== audio.playId) return;
  if (st.loops > lastLoops) {
    lastLoops = st.loops;
    commit((pass) => pass < st.loops, rec.region[1], false);
  }
}

/** Nota tocada ao vivo (chamado pelo áudio a cada liveOn/liveOff). */
export function recNote(on: boolean, ch: string, key: number, vel: number) {
  if (!rec) return;
  const t = now();
  if (!t) return;
  if (on) rec.notes.push({ ch, key, vel, pass: t.pass, on: t.tick, off: null });
  else {
    const open = [...rec.notes].reverse().find((n) => n.ch === ch && n.key === key && n.off === null);
    if (open) open.off = open.pass === t.pass ? t.tick : rec.region ? rec.region[1] : t.tick;
  }
}

/** Knob mexido durante a gravação. */
const norm = (target: AutoTarget, value: number) =>
  Math.max(0, Math.min(1, target.log && target.min > 0 ? Math.log(value / target.min) / Math.log(target.max / target.min) : (value - target.min) / (target.max - target.min)));

/** Knob mexido durante a gravação: before = valor que ele tinha antes. */
export function recAuto(target: AutoTarget, value: number, before?: number) {
  if (!rec) return;
  const t = now();
  if (!t) return;
  const key = target.path.join('/');
  touched.add(key);
  rec.autos.push({ target, pass: t.pass, tick: t.tick, v: norm(target, value), before: before !== undefined ? norm(target, before) : undefined });
}

const freeTrack = (p: Project, pos: number, len: number, extra: Clip[]) => {
  for (let t = 0; ; t++) {
    const busy = [...p.clips, ...extra].some((c) => c.track === t && c.pos < pos + len && c.pos + c.len > pos);
    if (!busy) return t;
  }
};

/** Para a gravação e transforma o que ainda não virou pattern. */
export function finishMidiRec(stopTick: number) {
  if (!rec) return;
  commit(() => true, stopTick, true);
  rec = null;
  touched.clear();
}

/** Transforma em patterns/automações as voltas escolhidas que ainda não foram. */
function commit(which: (pass: number) => boolean, stopTick: number, final: boolean) {
  const r = rec;
  if (!r) return;
  const p = state.project;
  const bar = ticksPerBar(p);
  const passes = [...new Set([...r.notes.map((n) => n.pass), ...r.autos.map((a) => a.pass)])].filter((x) => which(x) && !committed.has(x)).sort((a, b) => a - b);
  // notas ainda presas nessas voltas fecham no fim da volta (ou onde a gravação parou)
  for (const n of r.notes) if (n.off === null && passes.includes(n.pass)) n.off = r.region ? r.region[1] : stopTick;
  if (!passes.length) {
    if (final && !nCommitted.notes && !nCommitted.autos) toast('Nada foi tocado: nenhuma nota ou automação gravada');
    else if (final) report();
    return;
  }
  passes.forEach((x) => committed.add(x));
  const ops: Op[] = [];
  const newClips: Clip[] = [];
  const newTracks: number[] = [];
  let lastPattern: string | null = null;
  let nPatterns = 0, nNotes = 0, nAuto = 0;
  passes.forEach((pass, k) => {
    const notes = r.notes.filter((n) => n.pass === pass);
    const autos = r.autos.filter((a) => a.pass === pass);
    // trecho da passada: a área do loop, ou do começo da gravação até a última coisa tocada
    let from: number, to: number;
    if (r.region) [from, to] = r.region;
    else {
      from = Math.floor(r.start / bar) * bar;
      const last = Math.max(stopTick, ...notes.map((n) => n.off ?? n.on), ...autos.map((a) => a.tick));
      to = Math.max(from + bar, Math.ceil(last / bar) * bar);
    }
    const len = to - from;
    if (notes.length) {
      // escrito já (a próxima passada lê o pattern com estas notas)
      const res = intoPattern(r, notes, from, to, newClips);
      if (res.ops.length) edit(res.ops);
      if (res.clip) newClips.push(res.clip);
      lastPattern = res.patternId;
      if (res.created) nPatterns++;
      nNotes += notes.length;
    }
    // uma automação por parâmetro mexido
    const byTarget = new Map<string, AutoEv[]>();
    for (const a of autos) {
      const key = a.target.path.join('/');
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.push(a);
    }
    for (const evs of byTarget.values()) {
      evs.sort((a, b) => a.tick - b.tick);
      // pontos a cada ~1/64 no máximo (os knobs mandam muitos valores)
      const pts: { t: number; v: number }[] = [];
      // até o primeiro toque, o parâmetro fica como estava
      const first = evs[0];
      const t0 = Math.max(0, Math.round(first.tick - from));
      if (first.before !== undefined) {
        pts.push({ t: 0, v: first.before });
        if (t0 > 16) pts.push({ t: t0 - 8, v: first.before }); // longe o bastante para não ser fundido ao primeiro movimento
      }
      for (const e of evs) {
        const t = Math.max(0, Math.round(e.tick - from));
        if (pts.length && t - pts[pts.length - 1].t < PPQ / 16) pts[pts.length - 1].v = e.v;
        else pts.push({ t, v: e.v });
      }
      const track = freeTrack(p, from, len, newClips);
      const clip: Clip = { id: uid('k'), kind: 'auto', track, pos: from, len, patternId: '', offset: 0, target: evs[0].target, points: pts };
      ops.push(ins(['clips'], clip));
      newClips.push(clip);
      nAuto++;
    }
    void k;
  });
  // tracks que faltarem (para as automações)
  const autoClips = newClips.filter((c) => c.kind === 'auto');
  const maxTrack = Math.max(-1, ...autoClips.map((c) => c.track), state.project.tracks.length - 1);
  for (let t = state.project.tracks.length; t <= maxTrack; t++) ops.unshift(ins(['tracks'], { id: uid('t'), name: `Track ${t + 1}`, color: color(t), mute: false }));
  if (ops.length) edit(ops);
  if (lastPattern) {
    selectPattern(lastPattern);
    lastName = state.project.patterns.find((x) => x.id === lastPattern)?.name ?? '';
  }
  nCommitted.patterns += nPatterns;
  nCommitted.notes += nNotes;
  nCommitted.autos += nAuto;
  if (final) report();
  void A;
  void songLength;
}

/**
 * Escreve as notas de uma passada no pattern da gravação. Usa o clipe desse pattern que
 * está no começo do trecho (respeitando o offset e as repetições dele); se não houver,
 * coloca um clipe do pattern ali. O pattern cresce (e o clipe junto) se a gravação for
 * mais longa que ele.
 */
function intoPattern(r: NonNullable<typeof rec>, notes: NoteEv[], from: number, to: number, newClips: Clip[]) {
  const p = state.project;
  const bar = ticksPerBar(p);
  const ops: Op[] = [];
  let created = false;
  let pat = r.patternId ? p.patterns.find((x) => x.id === r.patternId) : undefined;
  if (!pat) {
    // nenhum pattern selecionado: cria um (as próximas passadas vão para ele)
    const chans = [...new Set(notes.map((n) => n.ch))];
    const names = chans.map((id) => p.channels.find((c) => c.id === id)?.name ?? 'canal');
    pat = { id: uid('p'), name: `${names.join(' + ')} · gravação`, color: color(p.patterns.length), length: 0, notes: {} };
    ops.push(ins(['patterns'], pat));
    r.patternId = pat.id;
    created = true;
  }
  const plen = patternLength(p, pat);
  const clip = [...p.clips, ...newClips].find((c) => c.patternId === pat!.id && c.kind !== 'audio' && c.kind !== 'auto' && c.pos <= from && c.pos + c.len > from);
  const base = clip ? clip.pos - clip.offset : from; // tick em que a posição 0 do pattern toca
  const add = new Map<string, Note[]>();
  let end = 0;
  for (const n of notes) {
    let rel = Math.max(0, Math.round(n.on - base));
    const len = Math.max(STEP / 4, Math.round((n.off ?? n.on) - n.on));
    // dentro de um clipe que repete o pattern: cai na repetição (mesma posição no pattern)
    if (clip && rel >= plen && n.on < clip.pos + clip.len) rel %= plen;
    end = Math.max(end, rel + len);
    if (!add.has(n.ch)) add.set(n.ch, []);
    add.get(n.ch)!.push({ id: uid('n'), key: n.key, pos: rel, len, vel: n.vel });
  }
  for (const [ch, list] of add) ops.push(set(['patterns', pat.id, 'notes', ch], [...(pat.notes[ch] ?? []), ...list]));
  // a gravação passou do fim do pattern: ele cresce até o compasso seguinte
  const need = Math.ceil(end / bar) * bar;
  if (need > plen && pat.length > 0) ops.push(set(['patterns', pat.id, 'length'], Math.round(need / STEP)));
  const full = Math.max(plen, need);
  let newClip: Clip | null = null;
  if (clip) {
    const want = base + full - clip.pos;
    if (want > clip.len && clip.len <= plen) ops.push(set(['clips', clip.id, 'len'], want));
  } else {
    const len = Math.max(full, r.region ? to - from : 0);
    newClip = { id: uid('k'), track: freeTrack(p, from, len, newClips), pos: from, len, patternId: pat.id, offset: 0 };
    for (let t = p.tracks.length; t <= newClip.track; t++) ops.push(ins(['tracks'], { id: uid('t'), name: `Track ${t + 1}`, color: color(t), mute: false }));
    ops.push(ins(['clips'], newClip));
  }
  return { ops, clip: newClip, patternId: pat.id, created };
}

let lastName = '';
function report() {
  const { patterns, notes, autos } = nCommitted;
  void patterns;
  const parts = [notes && `${notes} ${notes > 1 ? 'notas' : 'nota'} no pattern "${lastName}"`, autos && `${autos} ${autos > 1 ? 'automações' : 'automação'}`].filter(Boolean);
  if (parts.length) toast(`Gravado: ${parts.join(' · ')}`);
}
