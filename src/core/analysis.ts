// Análise de mix: loudness (LUFS integrado, BS.1770), picos, balanço de
// frequências, correlação estéreo. Usada pelo MCP para dar feedback de mix.

import { Biquad } from './dsp.js';

export interface MixAnalysis {
  durationSec: number;
  integratedLufs: number;
  shortTermMaxLufs: number;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  clippedSamples: number;
  stereoCorrelation: number; // 1 = mono, 0 = largo, <0 = problema de fase
  bands: Record<string, number>; // dB relativo ao total
  notes: string[];
}

const db = (x: number) => (x > 1e-12 ? 10 * Math.log10(x) : -120);

export function analyzeMix(L: Float32Array, R: Float32Array, sr: number): MixAnalysis {
  const n = L.length;
  // K-weighting aproximado
  const kl = [new Biquad(), new Biquad()];
  const kr = [new Biquad(), new Biquad()];
  for (const k of [kl, kr]) {
    k[0].setup('highshelf', 1681, sr, 0.707, 4);
    k[1].setup('highpass', 38, sr, 0.5);
  }
  const block = Math.round(sr * 0.4);
  const hop = Math.round(sr * 0.1);
  const kw = new Float32Array(n);
  let peak = 0, sumSq = 0, clipped = 0, sLR = 0, sLL = 0, sRR = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    const al = Math.abs(l), ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    if (al >= 0.999 || ar >= 0.999) clipped++;
    sumSq += (l * l + r * r) / 2;
    sLR += l * r; sLL += l * l; sRR += r * r;
    const yl = kl[1].process(kl[0].process(l));
    const yr = kr[1].process(kr[0].process(r));
    kw[i] = yl * yl + yr * yr;
  }
  // blocos de 400 ms com 75% de sobreposição
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + kw[i];
  const blocks: number[] = [];
  for (let s = 0; s + block <= n; s += hop) blocks.push((prefix[s + block] - prefix[s]) / block);
  const lufsOf = (ms: number) => -0.691 + db(ms);
  const abs = blocks.filter((b) => lufsOf(b) > -70);
  let integrated = -70;
  if (abs.length) {
    const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((b) => lufsOf(b) > rel);
    if (gated.length) integrated = lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length);
  }
  // short-term (3 s)
  const st = Math.round(sr * 3);
  let stMax = -70;
  for (let s = 0; s + st <= n; s += hop * 5) stMax = Math.max(stMax, lufsOf((prefix[s + st] - prefix[s]) / st));
  if (n < st) stMax = integrated;

  // bandas
  const edges: [string, number, number][] = [
    ['sub (20-60)', 20, 60],
    ['grave (60-250)', 60, 250],
    ['médio-grave (250-800)', 250, 800],
    ['médio (800-2.5k)', 800, 2500],
    ['médio-agudo (2.5k-6k)', 2500, 6000],
    ['agudo (6k-20k)', 6000, 20000],
  ];
  const bands: Record<string, number> = {};
  const energies: number[] = [];
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
  for (const [, lo, hi] of edges) {
    const h = new Biquad(), l2 = new Biquad(), h2 = new Biquad(), l3 = new Biquad();
    h.setup('highpass', lo, sr, 0.707); h2.setup('highpass', lo, sr, 0.707);
    l2.setup('lowpass', Math.min(hi, sr * 0.45), sr, 0.707); l3.setup('lowpass', Math.min(hi, sr * 0.45), sr, 0.707);
    let e = 0;
    for (let i = 0; i < n; i += 1) {
      const y = l3.process(l2.process(h2.process(h.process(mono[i]))));
      e += y * y;
    }
    energies.push(e / Math.max(1, n));
  }
  const total = energies.reduce((a, b) => a + b, 0) || 1e-12;
  edges.forEach(([name], i) => (bands[name] = Math.round(db(energies[i] / total) * 10) / 10));

  const corr = sLL > 0 && sRR > 0 ? sLR / Math.sqrt(sLL * sRR) : 1;
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-9));
  const rmsDb = db(sumSq / Math.max(1, n));
  const res: MixAnalysis = {
    durationSec: Math.round((n / sr) * 100) / 100,
    integratedLufs: Math.round(integrated * 10) / 10,
    shortTermMaxLufs: Math.round(stMax * 10) / 10,
    peakDb: Math.round(peakDb * 10) / 10,
    rmsDb: Math.round(rmsDb * 10) / 10,
    crestDb: Math.round((peakDb - rmsDb) * 10) / 10,
    clippedSamples: clipped,
    stereoCorrelation: Math.round(corr * 100) / 100,
    bands,
    notes: [],
  };
  // Observações objetivas (não substituem o ouvido).
  if (clipped > 0) res.notes.push(`${clipped} amostras no teto (≥ -0,01 dBFS): risco de clipping. Baixe o master ou use um limiter.`);
  if (integrated > -7) res.notes.push('Loudness muito alto (> -7 LUFS): provável esmagamento de dinâmica.');
  else if (integrated < -20 && integrated > -70) res.notes.push('Mix baixo (< -20 LUFS); para streaming o alvo comum é -14 LUFS.');
  if (corr < 0) res.notes.push('Correlação estéreo negativa: problemas de fase, o som pode sumir em mono.');
  if (bands['sub (20-60)'] > -4) res.notes.push('Sub muito dominante em relação ao resto.');
  if (bands['agudo (6k-20k)'] < -25) res.notes.push('Pouco brilho acima de 6 kHz: mix pode soar abafado.');
  if (bands['médio-grave (250-800)'] > -3) res.notes.push('Excesso de médio-grave (250-800 Hz): mix pode soar embolado.');
  return res;
}
