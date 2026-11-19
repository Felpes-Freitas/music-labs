// Costura (comping): várias gravações da mesma parte → uma versão final que usa,
// trecho a trecho, o take mais afinado. Os cortes caem no começo das notas, com
// crossfade curto, para a emenda não aparecer.

import { trackPitch, segmentNotes, type PitchTrack } from './pitchtrack.js';

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
  /** Desvio médio de afinação de cada take neste trecho (cents) ou null se ele não canta aqui. */
  cents: (number | null)[];
}

export interface StitchPlan {
  start: number;
  end: number;
  segments: StitchSegment[];
  /** Desvio médio geral de cada take (cents). */
  takeCents: (number | null)[];
}

/** Distância (cents) até a nota permitida mais próxima; scale = classes de altura (0..11) ou null = cromática. */
function devCents(m: number, scale: number[] | null) {
  if (!scale) return Math.abs(m - Math.round(m)) * 100;
  let best = Infinity;
  for (let k = Math.floor(m) - 1; k <= Math.ceil(m) + 1; k++) if (scale.includes(((k % 12) + 12) % 12)) best = Math.min(best, Math.abs(m - k) * 100);
  return best;
}

export function planStitch(takes: StitchTake[], sr: number, scale: number[] | null = null, merge = true): StitchPlan {
  for (const t of takes) {
    if (!t.track) {
      const mono = new Float32Array(t.ch[0].length);
      for (const c of t.ch) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / t.ch.length;
      t.track = trackPitch(mono, sr);
    }
  }
  const start = Math.min(...takes.map((t) => t.offset + t.from));
  const end = Math.max(...takes.map((t) => t.offset + t.to));
  const hop = takes[0].track!.hop;
  const g = hop / sr;
  // cortes: começo das notas de todos os takes, agrupados (notas do mesmo lugar em takes diferentes)
  const onsets: number[] = [];
  for (const t of takes)
    for (const n of segmentNotes(t.track!)) {
      const s = t.offset + (n.i0 * hop) / sr;
      if (s > t.offset + t.from && s < t.offset + t.to) onsets.push(s);
    }
  onsets.sort((a, b) => a - b);
  const cuts = [start];
  for (let i = 0; i < onsets.length; ) {
    let j = i;
    while (j + 1 < onsets.length && onsets[j + 1] - onsets[i] < 0.12) j++;
    const c = onsets[i] - 0.03;
    if (c - cuts[cuts.length - 1] > 0.08) cuts.push(c);
    i = j + 1;
  }
  cuts.push(end);

  const stats = takes.map(() => ({ sum: 0, w: 0 }));
  const segments: StitchSegment[] = [];
  let prev = -1;
  for (let s = 0; s + 1 < cuts.length; s++) {
    const t0 = cuts[s], t1 = cuts[s + 1];
    const cover: number[] = [], cents: (number | null)[] = [];
    takes.forEach((tk, k) => {
      const tr = tk.track!;
      let frames = 0, voiced = 0, sum = 0, w = 0;
      for (let t = t0; t < t1; t += g) {
        frames++;
        const a = t - tk.offset;
        if (a < tk.from || a >= tk.to) continue;
        const f = Math.floor((a * sr) / hop);
        const m = tr.midi[f];
        if (m === undefined || Number.isNaN(m)) continue;
        voiced++;
        const r = tr.rms[f];
        sum += devCents(m, scale) * r;
        w += r;
      }
      cover.push(frames ? voiced / frames : 0);
      cents.push(w > 0 ? sum / w : null);
      if (w > 0) {
        stats[k].sum += sum;
        stats[k].w += w;
      }
    });
    const maxCover = Math.max(...cover);
    let best = -1;
    if (maxCover > 0.2) {
      for (let k = 0; k < takes.length; k++) {
        if (cover[k] < maxCover * 0.6 || cents[k] === null) continue;
        // um take só troca se for claramente melhor (evita emendas à toa)
        const bonus = k === prev ? 3 : 0;
        if (best < 0 || cents[k]! - bonus < cents[best]! - (best === prev ? 3 : 0)) best = k;
      }
    } else best = prev; // silêncio: continua no mesmo take (sem corte no meio da respiração)
    segments.push({ t0, t1, take: best, cents });
    if (best >= 0) prev = best;
  }
  return { start, end, segments: merge ? mergeSegments(segments) : segments, takeCents: stats.map((s) => (s.w > 0 ? s.sum / s.w : null)) };
}

/** Junta trechos vizinhos do mesmo take (use antes de renderStitch). */
export function mergeSegments(segments: StitchSegment[]): StitchSegment[] {
  const merged: StitchSegment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && last.take === s.take) last.t1 = s.t1;
    else merged.push({ ...s });
  }
  return merged;
}

/** Monta o áudio final (estéreo) a partir do plano, com crossfades de equal power. */
export function renderStitch(plan: StitchPlan, takes: StitchTake[], sr: number, xfade = 0.012): [Float32Array, Float32Array] {
  const n = Math.ceil((plan.end - plan.start) * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const fade = Math.max(1, Math.round(xfade * sr));
  for (let si = 0; si < plan.segments.length; si++) {
    const seg = plan.segments[si];
    if (seg.take < 0) continue;
    const tk = takes[seg.take];
    const a = Math.round((seg.t0 - plan.start) * sr), b = Math.round((seg.t1 - plan.start) * sr);
    const fadeIn = si > 0 && plan.segments[si - 1].take >= 0;
    const fadeOut = si + 1 < plan.segments.length && plan.segments[si + 1].take >= 0;
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
