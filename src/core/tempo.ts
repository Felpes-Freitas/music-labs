// Andamento: "tap tempo" (BPM pelos cliques) e detecção do BPM de um áudio.
//
// Detecção: o áudio vira uma curva de "ataques" (fluxo espectral: quanto a energia sobe
// de um quadro para o outro, ~100 quadros por segundo). A autocorrelação dessa curva acha
// os períodos que se repetem; harmônicos do período (2x, 4x) reforçam o candidato e uma
// preferência suave por andamentos perto de 120 BPM desempata metade/dobro. Depois, um
// trem de pulsos varre o andamento em passos de 0,01 BPM e todas as fases, no áudio
// inteiro, para achar o valor fino e onde cai o primeiro tempo.

import { fft } from './onset.js';

/** BPM a partir dos instantes dos cliques (ms). Precisa de 2 cliques; usa os últimos 12. */
export function tapBpm(times: number[]): number | null {
  const t = times.slice(-12);
  if (t.length < 2) return null;
  // reta pelos cliques (mínimos quadrados): a inclinação é o intervalo médio
  const n = t.length;
  const mx = (n - 1) / 2;
  const my = t.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (t[i] - my);
    den += (i - mx) * (i - mx);
  }
  const ms = num / den;
  if (!(ms > 0)) return null;
  const bpm = 60000 / ms;
  return Math.max(20, Math.min(400, Math.round(bpm * 10) / 10));
}

/** Depois dessa pausa entre cliques, o tap tempo recomeça a contagem. */
export const TAP_RESET_MS = 2000;

export interface TempoGuess {
  bpm: number;
  /** 0..1: quanto o pulso se destaca (abaixo de ~0,3 é chute). */
  confidence: number;
  /** Instante do primeiro tempo no áudio (s). */
  firstBeat: number;
  /** Outras leituras plausíveis (metade, dobro…), da mais provável para a menos. */
  alternatives: number[];
}

const HOP_SEC = 0.01;
const N = 1024;

/** Curva de ataques (fluxo espectral), um valor a cada 10 ms. */
export function onsetEnvelope(x: Float32Array, sr: number): { env: Float32Array; rate: number } {
  const hop = Math.max(1, Math.round(sr * HOP_SEC));
  const frames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  const env = new Float32Array(frames);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float32Array(N), im = new Float32Array(N);
  const top = Math.min(N / 2, Math.round((8000 / sr) * N));
  let prev = new Float32Array(top), cur = new Float32Array(top);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = x[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < top; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0 && f > 0) flux += d;
    }
    env[f] = flux;
    [prev, cur] = [cur, prev];
  }
  // tira a média local (~0,5 s) e fica só com o que sobe acima dela
  const rate = sr / hop;
  const w = Math.round(rate * 0.25);
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames + w; i++) {
    if (i < frames) acc += env[i];
    if (i - 2 * w - 1 >= 0) acc -= env[i - 2 * w - 1];
    const c = i - w;
    if (c >= 0 && c < frames) {
      const cnt = Math.min(frames - 1, c + w) - Math.max(0, c - w) + 1;
      out[c] = Math.max(0, env[c] - acc / cnt);
    }
  }
  return { env: out, rate };
}

/** Valor da curva num instante fracionário (interpolação linear). */
const at = (e: Float32Array, p: number) => {
  const i = Math.floor(p);
  if (i < 0 || i + 1 >= e.length) return 0;
  const f = p - i;
  return e[i] * (1 - f) + e[i + 1] * f;
};

/** Melhor fase para um período (em quadros): soma da curva nos pulsos. */
function comb(env: Float32Array, period: number): { score: number; phase: number } {
  let best = -1, phase = 0;
  const steps = Math.max(8, Math.ceil(period));
  for (let s = 0; s < steps; s++) {
    const ph = (s / steps) * period;
    let sum = 0, cnt = 0;
    for (let p = ph; p < env.length - 1; p += period) {
      sum += at(env, p);
      cnt++;
    }
    const v = cnt ? sum / cnt : 0;
    if (v > best) {
      best = v;
      phase = ph;
    }
  }
  return { score: best, phase };
}

/** Detecta o andamento de um áudio mono. Devolve null se não há ataques suficientes. */
export function detectBpm(x: Float32Array, sr: number, opts: { min?: number; max?: number } = {}): TempoGuess | null {
  const min = opts.min ?? 60, max = opts.max ?? 200;
  const { env, rate } = onsetEnvelope(x, sr);
  if (env.length < rate * 3) return null; // menos de 3 s: pouco para ter certeza
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  if (mean <= 1e-6) return null;

  // autocorrelação normalizada
  const maxLag = Math.min(env.length - 1, Math.ceil((60 * rate * 4) / min) + 2);
  const ac = new Float32Array(maxLag + 1);
  let e0 = 0;
  for (const v of env) e0 += v * v;
  for (let L = 1; L <= maxLag; L++) {
    let s = 0;
    for (let i = 0; i + L < env.length; i++) s += env[i] * env[i + L];
    ac[L] = s / e0 / (1 - L / env.length);
  }
  const acAt = (l: number) => at(ac, l);
  const prior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);

  // candidatos em 0,5 BPM; pontuação com os harmônicos do período
  const cands: { bpm: number; score: number }[] = [];
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const L = (60 * rate) / bpm;
    const raw = acAt(L) + 0.5 * acAt(2 * L) + 0.25 * acAt(4 * L) + 0.25 * acAt(L / 2);
    cands.push({ bpm, score: raw * (0.5 + 0.5 * prior(bpm)) });
  }
  // picos locais
  const peaks = cands.filter((c, i) => (i === 0 || c.score >= cands[i - 1].score) && (i === cands.length - 1 || c.score >= cands[i + 1].score)).sort((a, b) => b.score - a.score);
  if (!peaks.length || peaks[0].score <= 0) return null;

  // refina o melhor com o trem de pulsos (passo 0,01 BPM, todas as fases)
  const refine = (b0: number) => {
    let best = { bpm: b0, score: -1, phase: 0 };
    for (let b = b0 - 1; b <= b0 + 1 + 1e-9; b += 0.05) {
      const c = comb(env, (60 * rate) / b);
      if (c.score > best.score) best = { bpm: b, ...c };
    }
    const c0 = best.bpm;
    for (let b = c0 - 0.05; b <= c0 + 0.05 + 1e-9; b += 0.01) {
      const c = comb(env, (60 * rate) / b);
      if (c.score > best.score) best = { bpm: b, ...c };
    }
    return best;
  };
  const top = refine(peaks[0].bpm);
  // quão acima da média o pulso fica (1 = só ataques nos tempos)
  const confidence = Math.max(0, Math.min(1, (top.score / mean - 1) / 3));
  const period = (60 * rate) / top.bpm;
  const alts: number[] = [];
  for (const p of peaks.slice(1)) {
    if (alts.length >= 2 || p.score < peaks[0].score * 0.6) break;
    if (Math.abs(p.bpm - top.bpm) < 3 || alts.some((a) => Math.abs(a - p.bpm) < 3)) continue;
    alts.push(Math.round(p.bpm * 2) / 2);
  }
  for (const k of [0.5, 2]) {
    const b = Math.round(top.bpm * k * 100) / 100;
    if (b >= 40 && b <= 300 && !alts.some((a) => Math.abs(a - b) < 3)) alts.push(b);
  }
  return {
    bpm: Math.round(top.bpm * 100) / 100,
    confidence,
    firstBeat: (top.phase % period) / rate + (N / 2) / sr,
    alternatives: alts,
  };
}

/** Mistura os canais em mono. */
export function mono(ch: Float32Array[]): Float32Array {
  if (ch.length === 1) return ch[0];
  const out = new Float32Array(ch[0].length);
  for (const c of ch) for (let i = 0; i < out.length; i++) out[i] += c[i] / ch.length;
  return out;
}
