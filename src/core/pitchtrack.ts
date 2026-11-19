// Rastreamento de altura quadro a quadro (YIN) e separação em notas, para áudio
// monofônico (voz, guitarra solo, sopro). Base do editor de afinação e da costura.
//
// O YIN roda num sinal reduzido a 1/4 da taxa (rápido) e a altura é refinada na
// taxa original em volta do período encontrado.

export const HOP = 256;

export interface PitchTrack {
  sr: number;
  hop: number;
  /** Altura em MIDI fracionário (60 = C4) de cada quadro; NaN = sem altura (silêncio, consoante). */
  midi: Float32Array;
  /** Nível RMS de cada quadro. */
  rms: Float32Array;
}

export interface Note {
  /** Quadros [i0, i1). */
  i0: number;
  i1: number;
  /** Altura central (mediana) em MIDI fracionário. */
  pitch: number;
}

const DEC = 4;

export function trackPitch(x: Float32Array, sr: number, minF = 70, maxF = 1100): PitchTrack {
  // passa-baixa (2 polos, ~0,4 da nova Nyquist) e reduz a taxa
  const dsr = sr / DEC;
  const d = new Float32Array(Math.floor(x.length / DEC));
  {
    const fc = dsr * 0.4;
    const w = Math.tan((Math.PI * fc) / sr), k = Math.SQRT2;
    const a0 = 1 + k * w + w * w;
    const b0 = (w * w) / a0, b1 = 2 * b0, b2 = b0, a1 = (2 * (w * w - 1)) / a0, a2 = (1 - k * w + w * w) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    for (let i = 0; i < d.length * DEC; i++) {
      const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
      const v = b0 * y + b1 * u1 + b2 * u2 - a1 * v1 - a2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      if (i % DEC === 0) d[i / DEC] = v;
    }
  }
  const tauMax = Math.ceil(dsr / minF), tauMin = Math.floor(dsr / maxF);
  const W = tauMax * 2;
  const frames = Math.max(0, Math.floor((x.length - W * DEC) / HOP) + 1);
  const midi = new Float32Array(frames).fill(NaN);
  const rms = new Float32Array(frames);
  const df = new Float32Array(tauMax + 2);
  let peak = 1e-9;
  for (let f = 0; f < frames; f++) {
    const s = f * HOP;
    let e = 0;
    for (let i = 0; i < W * DEC; i++) e += x[s + i] * x[s + i];
    rms[f] = Math.sqrt(e / (W * DEC));
    if (rms[f] > peak) peak = rms[f];
  }
  for (let f = 0; f < frames; f++) {
    if (rms[f] < peak * 0.01 || rms[f] < 1e-4) continue; // -40 dB do pico: silêncio
    const s = Math.floor((f * HOP) / DEC);
    // função diferença e normalização cumulativa (YIN)
    df[0] = 1;
    let run = 0;
    for (let t = 1; t <= tauMax + 1; t++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const v = d[s + i] - d[s + i + t];
        sum += v * v;
      }
      run += sum;
      df[t] = run > 0 ? (sum * t) / run : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++)
      if (df[t] < 0.18) {
        while (t + 1 <= tauMax && df[t + 1] < df[t]) t++;
        tau = t;
        break;
      }
    if (tau < 0) continue;
    // refina na taxa original: procura o menor erro em volta de tau·DEC
    const S = f * HOP, Wf = W * DEC;
    const err = (T: number) => {
      let sum = 0;
      for (let i = 0; i < Wf; i += 2) {
        const v = x[S + i] - x[S + i + T];
        sum += v * v;
      }
      return sum;
    };
    let best = tau * DEC, bestE = Infinity;
    for (let T = tau * DEC - DEC - 1; T <= tau * DEC + DEC + 1; T++) {
      if (T < 2 || S + Wf + T >= x.length) continue;
      const e = err(T);
      if (e < bestE) (bestE = e), (best = T);
    }
    // interpolação parabólica do mínimo
    const e0 = err(best - 1), e2 = err(best + 1);
    const den = e0 - 2 * bestE + e2;
    const T = den > 0 ? best + (0.5 * (e0 - e2)) / den : best;
    midi[f] = 69 + 12 * Math.log2(sr / T / 440);
  }
  // remove pulos de oitava isolados e quadros soltos (mediana de 5)
  const out = midi.slice();
  for (let f = 2; f < frames - 2; f++) {
    if (Number.isNaN(midi[f])) continue;
    const w = [midi[f - 2], midi[f - 1], midi[f], midi[f + 1], midi[f + 2]].filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    if (w.length < 3) out[f] = NaN;
    else out[f] = Math.abs(midi[f] - w[w.length >> 1]) > 1 ? w[w.length >> 1] : midi[f];
  }
  return { sr, hop: HOP, midi: out, rms };
}

/** Separa o rastreamento em notas: pausas, ou mudança de altura sustentada. */
export function segmentNotes(t: PitchTrack): Note[] {
  const fps = t.sr / t.hop;
  const minLen = Math.round(0.06 * fps), gapMax = Math.round(0.03 * fps), jumpLen = Math.round(0.045 * fps);
  const notes: Note[] = [];
  let i0 = -1, gap = 0, jump = 0;
  const vals: number[] = [];
  const close = (end: number) => {
    if (i0 >= 0 && end - i0 >= minLen) {
      const v = vals.slice().sort((a, b) => a - b);
      notes.push({ i0, i1: end, pitch: v[v.length >> 1] });
    }
    i0 = -1;
    vals.length = 0;
  };
  // quadros que se afastaram da nota atual ficam "pendentes": se o afastamento
  // dura, viram o começo da próxima nota; se volta, eram só vibrato/escorregada
  const pending: number[] = [];
  for (let f = 0; f < t.midi.length; f++) {
    const m = t.midi[f];
    if (Number.isNaN(m)) {
      if (i0 >= 0 && ++gap > gapMax) {
        vals.push(...pending);
        pending.length = 0;
        jump = 0;
        close(f - gap + 1);
      }
      continue;
    }
    gap = 0;
    if (i0 < 0) {
      i0 = f;
      vals.push(m);
      continue;
    }
    const recent = vals.slice(-Math.max(3, Math.round(0.08 * fps))).sort((a, b) => a - b);
    const center = recent[recent.length >> 1];
    if (Math.abs(m - center) > 0.6) {
      pending.push(m);
      if (++jump >= jumpLen) {
        // mudou de nota: fecha a anterior onde o afastamento começou
        const start = f - jump + 1;
        close(start);
        i0 = start;
        vals.push(...pending);
        pending.length = 0;
        jump = 0;
      }
      continue;
    }
    jump = 0;
    vals.push(...pending, m);
    pending.length = 0;
  }
  vals.push(...pending);
  close(t.midi.length);
  return notes;
}
