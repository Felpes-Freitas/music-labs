// Mudança de altura sem mudar a duração (TD-PSOLA), para áudio monofônico.
// Cada período da onda é recortado em volta de um pico e recolocado com outro
// espaçamento: períodos mais próximos = som mais agudo, sem acelerar o áudio.
// Trechos sem altura (silêncio, consoantes) passam sem alteração.

import type { PitchTrack } from './pitchtrack.js';

/**
 * shift[f] = semitons a deslocar em cada quadro do rastreamento (0 = sem mudança).
 * Devolve canais novos do mesmo tamanho.
 */
export function shiftPitch(ch: Float32Array[], track: PitchTrack, shift: Float32Array): Float32Array[] {
  const { sr, hop } = track;
  const n = ch[0].length;
  const mono = new Float32Array(n);
  for (const c of ch) for (let i = 0; i < n; i++) mono[i] += c[i] / ch.length;
  const frames = track.midi.length;
  const at = (arr: Float32Array, i: number) => arr[Math.max(0, Math.min(frames - 1, Math.floor(i / hop)))];
  const periodAt = (i: number) => {
    const m = at(track.midi, i);
    return Number.isNaN(m) ? 0 : sr / (440 * Math.pow(2, (m - 69) / 12));
  };
  // período "de trabalho" em trechos sem altura: grãos de ~5 ms passam inalterados
  const flat = Math.round(sr * 0.005);

  // marcas de análise: um pico por período nos trechos com altura
  const marks: number[] = [];
  let i = 0;
  while (i < n) {
    const T = periodAt(i);
    if (!T) {
      marks.push(i);
      i += flat;
      continue;
    }
    // ajusta a marca para o pico de energia mais próximo dentro de meio período
    const lo = Math.max(0, Math.round(i - T / 4)), hi = Math.min(n - 1, Math.round(i + T / 4));
    // sempre o pico positivo (com o absoluto a marca pularia entre os dois lados da onda)
    let best = i, bv = -Infinity;
    for (let k = lo; k <= hi; k++) {
      const v = mono[k];
      if (v > bv) (bv = v), (best = k);
    }
    if (marks.length && best <= marks[marks.length - 1]) best = marks[marks.length - 1] + Math.max(1, Math.round(T * 0.5));
    marks.push(best);
    i = best + Math.max(8, Math.round(T));
  }

  const out = ch.map(() => new Float32Array(n));
  const norm = new Float32Array(n);
  // marcas de síntese: espaçadas pelo período novo; cada uma usa a marca de análise mais próxima
  let ts = marks[0] ?? 0, mi = 0;
  while (ts < n) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - ts) <= Math.abs(marks[mi] - ts)) mi++;
    const a = marks[mi];
    const T0 = periodAt(a);
    const s = at(shift, a);
    const ratio = T0 ? Math.pow(2, s / 12) : 1;
    const half = T0 ? Math.round(T0) : flat;
    // grão de dois períodos com janela de Hann, centrado na marca de análise
    for (let k = -half; k <= half; k++) {
      const src = a + k, dst = Math.round(ts) + k;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / (half + 1));
      for (let c = 0; c < ch.length; c++) out[c][dst] += ch[c][src] * w;
      norm[dst] += w;
    }
    ts += (T0 || flat) / ratio;
  }
  // normaliza a soma das janelas (evita variação de volume quando o espaçamento muda)
  for (let k = 0; k < n; k++) {
    const g = norm[k] > 1e-3 ? 1 / Math.max(norm[k], 0.5) : 0;
    for (let c = 0; c < ch.length; c++) out[c][k] *= g;
  }
  return out;
}
