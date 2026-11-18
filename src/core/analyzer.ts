// Analisador de espectro em tempo real (para o espectrograma da tela).

const N = 2048;
const LOG2N = 11;
export const BANDS = 120;
export const F_MIN = 20;
export const F_MAX = 20000;

const rev = new Uint16Array(N);
const cosT = new Float64Array(N / 2);
const sinT = new Float64Array(N / 2);
const win = new Float64Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  rev[i] = r;
  win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
}
for (let i = 0; i < N / 2; i++) {
  cosT[i] = Math.cos((2 * Math.PI * i) / N);
  sinT[i] = -Math.sin((2 * Math.PI * i) / N);
}
const re = new Float64Array(N);
const im = new Float64Array(N);
const mag = new Float64Array(N / 2);

/** Frequência central de cada faixa (escala logarítmica). */
export function bandFreq(b: number): number {
  return F_MIN * Math.pow(F_MAX / F_MIN, (b + 0.5) / BANDS);
}

/**
 * Espectro (dB, 0 = senoide em escala cheia) em BANDS faixas, a partir de um
 * buffer circular de N amostras cuja próxima escrita é em w.
 */
export function analyzeSpectrum(ring: Float32Array, w: number, sr: number): number[] {
  for (let i = 0; i < N; i++) {
    const v = ring[(w + i) & (N - 1)] * win[i];
    re[rev[i]] = v;
    im[rev[i]] = 0;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size)
      for (let j = 0; j < half; j++) {
        const wr = cosT[j * step], wi = sinT[j * step];
        const a = start + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
  for (let k = 0; k < N / 2; k++) mag[k] = (Math.hypot(re[k], im[k]) * 4) / N;
  const out: number[] = new Array(BANDS);
  const binHz = sr / N;
  for (let b = 0; b < BANDS; b++) {
    const lo = F_MIN * Math.pow(F_MAX / F_MIN, b / BANDS) / binHz;
    const hi = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / BANDS) / binHz;
    let m = 0;
    if (hi - lo < 1) {
      // faixa mais estreita que um bin: interpola no centro
      const c = (lo + hi) / 2;
      const i = Math.floor(c);
      const f = c - i;
      m = (mag[i] ?? 0) * (1 - f) + (mag[i + 1] ?? 0) * f;
    } else for (let k = Math.ceil(lo); k <= Math.floor(hi) && k < N / 2; k++) if (mag[k] > m) m = mag[k];
    out[b] = Math.round(20 * Math.log10(Math.max(m, 1e-7)) * 10) / 10;
  }
  return out;
}

export const ANALYZER_SIZE = N;
