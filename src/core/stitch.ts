// Costura (comping): várias gravações da mesma parte → uma versão final que usa,
// trecho a trecho, o take que chegou mais perto da nota que se queria cantar.
//
// "A nota que se queria": o tom é detectado a partir de todos os takes; em cada
// trecho, a altura do consenso entre os takes é levada à nota da escala mais
// próxima. Quem edita a linha melódica pode trocar essa nota (ex.: era um Dó,
// não um Si) e a escolha dos takes se refaz. Os cortes caem no começo das notas,
// com crossfade curto, e a costura pode sair afinada exatamente na melodia.

import { trackPitch, segmentNotes, type PitchTrack } from './pitchtrack.js';
import { shiftPitch } from './psola.js';
import { detectKey, snapToKey, type Key } from './key.js';

export interface StitchTake {
  /** Tempo da música (s) em que a amostra 0 do áudio toca. */
  offset: number;
  /** Trecho do áudio que vale (s, no tempo do arquivo): o pedaço visível do clipe. */
  from: number;
  to: number;
  ch: Float32Array[];
  track?: PitchTrack;
}

export interface StitchSegment {
  /** Tempo da música (s). */
  t0: number;
  t1: number;
  /** Take escolhido (índice) ou -1 para silêncio. */
  take: number;
  /** Nota pretendida (MIDI inteiro) ou null se ninguém canta aqui. */
  target: number | null;
  /** Altura cantada por cada take neste trecho (mediana) ou null. */
  sung: (number | null)[];
  /** Distância de cada take até a nota pretendida (cents) ou null. */
  cents: (number | null)[];
  /** Áudio usado ao montar (índice em takes) quando não é o próprio take (ex.: trecho editado). */
  src?: number;
  /** Não mexer na afinação deste pedaço (já foi editado à mão). */
  noTune?: boolean;
  /** Escolhido à mão (não muda quando a melodia é reavaliada). */
  manual?: boolean;
}

export interface StitchPlan {
  start: number;
  end: number;
  key: Key;
  detectedKey: Key;
  segments: StitchSegment[];
  /** Desvio médio de cada take até a melodia (cents). */
  takeCents: (number | null)[];
}

function ensureTracks(takes: StitchTake[], sr: number) {
  for (const t of takes) {
    if (t.track) continue;
    const mono = new Float32Array(t.ch[0].length);
    for (const c of t.ch) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / t.ch.length;
    t.track = trackPitch(mono, sr);
  }
}

/** Monta o plano. key = null usa o tom detectado. */
export function planStitch(takes: StitchTake[], sr: number, key: Key | null = null, merge = true): StitchPlan {
  ensureTracks(takes, sr);
  const start = Math.min(...takes.map((t) => t.offset + t.from));
  const end = Math.max(...takes.map((t) => t.offset + t.to));
  const hop = takes[0].track!.hop;
  // tom: notas de todos os takes
  const all: { pitch: number; weight: number }[] = [];
  const onsets: number[] = [];
  for (const t of takes)
    for (const n of segmentNotes(t.track!)) {
      const s = t.offset + (n.i0 * hop) / sr;
      if (s < t.offset + t.from - 0.05 || s > t.offset + t.to) continue;
      onsets.push(s);
      let w = 0;
      for (let f = n.i0; f < n.i1; f++) w += t.track!.rms[f];
      all.push({ pitch: n.pitch, weight: w });
    }
  const detectedKey = detectKey(all);
  const useKey = key ?? detectedKey;
  // cortes: começo das notas de todos os takes, agrupados
  onsets.sort((a, b) => a - b);
  const cuts = [start];
  for (let i = 0; i < onsets.length; ) {
    let j = i;
    while (j + 1 < onsets.length && onsets[j + 1] - onsets[i] < 0.12) j++;
    const c = onsets[i] - 0.03;
    if (c - cuts[cuts.length - 1] > 0.08 && c < end - 0.05) cuts.push(c);
    i = j + 1;
  }
  cuts.push(end);
  const segments: StitchSegment[] = [];
  for (let s = 0; s + 1 < cuts.length; s++) {
    const t0 = cuts[s], t1 = cuts[s + 1];
    const sung = takes.map((tk) => sungIn(tk, t0, t1, sr));
    const voiced = sung.filter((x): x is number => x !== null);
    // consenso: mediana do que os takes cantaram, levada à nota da escala
    const target = voiced.length ? snapToKey(voiced.sort((a, b) => a - b)[voiced.length >> 1], useKey) : null;
    segments.push({ t0, t1, take: -1, target, sung, cents: [] });
  }
  const plan: StitchPlan = { start, end, key: useKey, detectedKey, segments, takeCents: [] };
  rescore(plan, takes, sr);
  if (merge) plan.segments = mergeSegments(plan.segments);
  return plan;
}

/** Mediana da altura cantada por um take num trecho (null se quase não canta). */
function sungIn(tk: StitchTake, t0: number, t1: number, sr: number): number | null {
  const tr = tk.track!;
  const v: number[] = [];
  let frames = 0;
  for (let f = Math.max(0, Math.floor(((t0 - tk.offset) * sr) / tr.hop)); f < tr.midi.length; f++) {
    const a = (f * tr.hop) / sr;
    if (tk.offset + a >= t1) break;
    frames++;
    if (a < tk.from || a >= tk.to || Number.isNaN(tr.midi[f])) continue;
    v.push(tr.midi[f]);
  }
  if (!frames || v.length < frames * 0.25 || v.length < 6) return null;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/**
 * Recalcula, para a melodia atual (targets), o desvio de cada take e o take
 * escolhido em cada trecho. Use depois de mudar um target.
 */
export function rescore(plan: StitchPlan, takes: StitchTake[], sr: number) {
  const stats = takes.map(() => ({ sum: 0, w: 0 }));
  let prev = -1;
  for (const sg of plan.segments) {
    sg.cents = takes.map((tk, k) => {
      if (sg.target === null || sg.sung[k] === null) return null;
      const tr = tk.track!;
      let sum = 0, w = 0;
      for (let f = Math.max(0, Math.floor(((sg.t0 - tk.offset) * sr) / tr.hop)); f < tr.midi.length; f++) {
        const a = (f * tr.hop) / sr;
        if (tk.offset + a >= sg.t1) break;
        const m = tr.midi[f];
        if (a < tk.from || a >= tk.to || Number.isNaN(m)) continue;
        // distância até a nota pretendida (não até o semitom mais próximo)
        sum += Math.min(300, Math.abs(m - sg.target) * 100) * tr.rms[f];
        w += tr.rms[f];
      }
      if (w > 0) {
        stats[k].sum += sum;
        stats[k].w += w;
      }
      return w > 0 ? sum / w : null;
    });
    if (sg.manual) {
      // escolha feita à mão: só atualiza o desvio, não troca de take
      if (sg.take >= 0) prev = sg.take;
      continue;
    }
    let best = -1;
    sg.cents.forEach((c, k) => {
      if (c === null) return;
      const score = c - (k === prev ? 4 : 0); // só troca de take se valer a emenda
      const bs = best < 0 ? Infinity : sg.cents[best]! - (best === prev ? 4 : 0);
      if (score < bs) best = k;
    });
    sg.take = best >= 0 ? best : sg.target === null ? prev : -1;
    if (sg.take >= 0) prev = sg.take;
  }
  plan.takeCents = stats.map((s) => (s.w > 0 ? s.sum / s.w : null));
}

/**
 * Põe de volta cortes, notas pretendidas e escolhas salvos (sessão guardada no
 * projeto). As escolhas automáticas são recalculadas (dão o mesmo resultado); as
 * manuais ficam como estavam.
 */
export function restoreSegments(plan: StitchPlan, takes: StitchTake[], sr: number, saved: { t0: number; t1: number; take: number; target: number | null; manual?: boolean }[]) {
  plan.segments = saved.map((s) => ({
    t0: s.t0,
    t1: s.t1,
    take: s.take < takes.length ? s.take : -1,
    target: s.target,
    sung: takes.map((tk) => sungIn(tk, s.t0, s.t1, sr)),
    cents: [],
    ...(s.manual ? { manual: true } : {}),
  }));
  rescore(plan, takes, sr);
}

/** Junta trechos vizinhos do mesmo take (use antes de renderStitch). */
export function mergeSegments(segments: StitchSegment[]): StitchSegment[] {
  const merged: StitchSegment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && last.take === s.take && last.src === s.src && !!last.noTune === !!s.noTune) last.t1 = s.t1;
    else merged.push({ ...s });
  }
  return merged;
}

/** Monta o áudio final (estéreo) a partir do plano, com crossfades de equal power. */
export function renderStitch(plan: StitchPlan, takes: StitchTake[], sr: number, xfade = 0.012): [Float32Array, Float32Array] {
  const segs = mergeSegments(plan.segments);
  const n = Math.ceil((plan.end - plan.start) * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const fade = Math.max(1, Math.round(xfade * sr));
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    if (seg.take < 0) continue;
    const tk = takes[seg.src ?? seg.take];
    const a = Math.round((seg.t0 - plan.start) * sr), b = Math.round((seg.t1 - plan.start) * sr);
    const fadeIn = si > 0 && segs[si - 1].take >= 0;
    const fadeOut = si + 1 < segs.length && segs[si + 1].take >= 0;
    for (let i = Math.max(0, a - (fadeIn ? fade : 0)); i < Math.min(n, b + (fadeOut ? fade : 0)); i++) {
      let gain = 1;
      if (fadeIn && i < a + fade) gain = Math.sin((Math.PI / 2) * Math.min(1, Math.max(0, (i - (a - fade)) / (2 * fade))));
      if (fadeOut && i > b - fade) gain *= Math.cos((Math.PI / 2) * Math.min(1, Math.max(0, (i - (b - fade)) / (2 * fade))));
      const src = Math.round((plan.start - tk.offset) * sr) + i;
      if (src < tk.from * sr || src >= tk.to * sr || src >= tk.ch[0].length) continue;
      L[i] += tk.ch[0][src] * gain;
      R[i] += (tk.ch[1] ?? tk.ch[0])[src] * gain;
    }
  }
  return [L, R];
}

/**
 * Leva cada nota da costura até a nota da melodia (corrige o centro da nota,
 * mantendo vibrato e expressão). Usado quando a melodia foi editada ou quando
 * nenhum take acertou em cheio.
 */
export function tuneToMelody(L: Float32Array, R: Float32Array, plan: StitchPlan, sr: number): [Float32Array, Float32Array] {
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
  const tr = trackPitch(mono, sr);
  const shift = new Float32Array(tr.midi.length);
  for (const sg of plan.segments) {
    if (sg.target === null || sg.noTune) continue;
    const f0 = Math.max(0, Math.floor(((sg.t0 - plan.start) * sr) / tr.hop)), f1 = Math.min(tr.midi.length, Math.ceil(((sg.t1 - plan.start) * sr) / tr.hop));
    const v: number[] = [];
    for (let f = f0; f < f1; f++) if (!Number.isNaN(tr.midi[f])) v.push(tr.midi[f]);
    if (v.length < 4) continue;
    v.sort((a, b) => a - b);
    const s = sg.target - v[v.length >> 1];
    if (Math.abs(s) < 0.03) continue;
    for (let f = f0; f < f1; f++) shift[f] = s;
  }
  // transições suaves
  const sm = new Float32Array(shift.length);
  for (let f = 0; f < shift.length; f++) {
    let a = 0, k = 0;
    for (let j = Math.max(0, f - 4); j <= Math.min(shift.length - 1, f + 4); j++) (a += shift[j]), k++;
    sm[f] = a / k;
  }
  const [oL, oR] = shiftPitch([L, R], tr, sm);
  return [oL, oR];
}
