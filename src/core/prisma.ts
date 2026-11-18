// Prisma: sintetizador aditivo espectral.
//
// Cada voz calcula, em taxa de controle, a amplitude de cada harmônico
// (forma -> filtro harmônico -> pluck -> phaser) e gera um ciclo da forma de
// onda com uma FFT inversa. Filtrar direto nos harmônicos não gera aliasing e
// permite curvas impossíveis num filtro analógico. As tabelas consecutivas são
// cruzadas suavemente; o unison e as camadas de oitava leem a mesma tabela.

import type { Params } from './model.js';
import { Adsr, DelayLine, TAU, mtof, panGains } from './dsp.js';

export const TABLE = 512;
const LOG2N = 9;
export const MAX_HARM = 255;
const CB = 256; // amostras por bloco de controle

// ---------------------------------------------------------------- FFT inversa

const rev = new Uint16Array(TABLE);
const cosT = new Float64Array(TABLE / 2);
const sinT = new Float64Array(TABLE / 2);
for (let i = 0; i < TABLE; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  rev[i] = r;
}
for (let i = 0; i < TABLE / 2; i++) {
  cosT[i] = Math.cos((TAU * i) / TABLE);
  sinT[i] = Math.sin((TAU * i) / TABLE);
}

/** Um ciclo de sum(a_k * sin(2 pi k n / N)) via FFT inversa (expoente positivo). */
export function synthTable(amps: Float32Array, H: number, out: Float32Array, re: Float64Array, im: Float64Array) {
  re.fill(0);
  im.fill(0);
  for (let k = 1; k <= H && k < TABLE / 2; k++) {
    const a = amps[k] * 0.5;
    im[rev[k]] = -a;
    im[rev[TABLE - k]] = a;
  }
  for (let size = 2; size <= TABLE; size <<= 1) {
    const half = size >> 1;
    const step = TABLE / size;
    for (let start = 0; start < TABLE; start += size) {
      for (let j = 0; j < half; j++) {
        const wr = cosT[j * step];
        const wi = sinT[j * step];
        const a = start + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let n = 0; n < TABLE; n++) out[n] = re[n];
  out[TABLE] = out[0];
}

// ---------------------------------------------------------------- espectro

const num = (p: Params, k: string, d = 0) => (typeof p[k] === 'number' ? (p[k] as number) : d);
const str = (p: Params, k: string, d = '') => (typeof p[k] === 'string' ? (p[k] as string) : d);

export interface SpectrumState {
  t: number; // segundos desde o início da nota (pluck)
  fenv: number; // envelope do filtro 0..1
  vel: number;
  lfo: number; // LFO do filtro -1..1
  phaser: number; // fase do phaser 0..1
}

const softplus = (x: number) => (x > 6 ? x : Math.log1p(Math.exp(4 * x)) / 4);
const LN2_4 = Math.log(2) / 4;

/** Resposta (ganho linear) do filtro harmônico numa frequência. */
export function filterGain(p: Params, f: number, cutoffOct: number): number {
  const type = str(p, 'ftype', 'lowpass');
  if (type === 'off') return 1;
  const x = Math.log2(f) - cutoffOct;
  const slope = num(p, 'slope', 24);
  const res = num(p, 'res', 0.2);
  let db = 0;
  if (type === 'lowpass') db = -slope * softplus(x);
  else if (type === 'highpass') db = -slope * softplus(-x);
  else if (type === 'bandpass') db = -slope * (softplus(x) + softplus(-x) - 2 * LN2_4);
  else if (type === 'notch') return 1 - Math.exp(-((x / 0.18) ** 2)) * (0.98 - res * 0.3);
  if (res > 0) {
    const w = 0.35 * (1 - res) + 0.05;
    db += res * 26 * Math.exp(-((x / w) ** 2));
  }
  return Math.pow(10, db / 20);
}

/** Oitava (log2 Hz) do corte efetivo para uma nota e um estado da voz. */
export function cutoffOct(p: Params, f0: number, st: SpectrumState): number {
  return (
    Math.log2(num(p, 'cutoff', 2500)) +
    num(p, 'keytrack', 0.5) * Math.log2(f0 / 261.63) +
    num(p, 'fenv', 3) * st.fenv +
    num(p, 'lfoFilter', 0) * st.lfo +
    num(p, 'velCutoff', 1) * (st.vel - 0.75)
  );
}

/**
 * Amplitudes dos harmônicos 1..H em out (out[0] fica 0). Devolve H.
 * Usado pela voz (em tempo real) e pela tela do Prisma (visualização).
 */
export function prismaSpectrum(p: Params, f0: number, sr: number, st: SpectrumState, out: Float32Array, maxF = f0, cutoffShift = 0): number {
  const H = Math.max(1, Math.min(Math.round(num(p, 'harmonics', 128)), Math.floor((0.45 * sr) / Math.max(1, maxF)), MAX_HARM, out.length - 1));
  const tilt = num(p, 'tilt', 0);
  const even = num(p, 'even', 1);
  const sine = num(p, 'sine', 0);
  out[0] = 0;
  let pow = 0;
  for (let k = 1; k <= H; k++) {
    let a = Math.pow(k, -(1 + tilt));
    if ((k & 1) === 0) a *= even;
    if (k > 1) a *= 1 - sine;
    out[k] = a;
    pow += a * a;
  }
  for (let k = H + 1; k < out.length; k++) out[k] = 0;
  // mesma energia para qualquer forma (o filtro é que tira volume)
  const norm = pow > 0 ? Math.sqrt(1.64 / pow) : 0;
  const co = cutoffOct(p, f0, st) + cutoffShift;
  const pluck = num(p, 'pluck', 0);
  const pt = num(p, 'pluckTime', 0.5);
  const pb = num(p, 'pluckBright', 0.5);
  const ph = num(p, 'phaser', 0);
  const spacing = num(p, 'phaserSpacing', 1);
  const q = 1 + num(p, 'phaserWidth', 0.5) * 10;
  for (let k = 1; k <= H; k++) {
    const f = k * f0;
    let a = out[k] * norm * filterGain(p, f, co);
    if (pluck > 0) a *= 1 - pluck + pluck * Math.exp((-st.t * (1 + (k - 1) * pb * 0.6)) / pt);
    if (ph > 0) {
      const pos = Math.log2(f / 110) / spacing - st.phaser;
      const n = Math.pow(0.5 + 0.5 * Math.cos(TAU * pos), q);
      a *= 1 - ph * n;
    }
    out[k] = a;
  }
  return H;
}

// ---------------------------------------------------------------- voz

export interface PrismaNote {
  key: number;
  vel: number;
  gate: number;
  pan: number;
  detune?: number;
}

export class PrismaVoice {
  age = 0;
  done = false;
  gate: number;
  key: number;
  pitch: number;
  target: number;
  private amps = new Float32Array(MAX_HARM + 1);
  private prevAmps = new Float32Array(MAX_HARM + 1);
  private tabA = new Float32Array(TABLE + 1);
  private tabB = new Float32Array(TABLE + 1);
  // segunda tabela (variação de timbre entre as vozes do unison)
  private ampsV = new Float32Array(MAX_HARM + 1);
  private prevAmpsV = new Float32Array(MAX_HARM + 1);
  private tabVA = new Float32Array(TABLE + 1);
  private tabVB = new Float32Array(TABLE + 1);
  private vary = 0;
  private re = new Float64Array(TABLE);
  private im = new Float64Array(TABLE);
  private phases: Float64Array;
  private incs: Float64Array;
  private gl: Float64Array;
  private gr: Float64Array;
  private octPh = Math.random();
  private subPh = Math.random();
  private amp: Adsr;
  private fenv: Adsr;
  private t = 0;
  private blockPos = CB; // força cálculo no primeiro bloco
  private xf = 1; // progresso do crossfade entre tabelas
  private hasTable = false;
  private vibPh = Math.random();
  private lfoPh = Math.random();
  private phPh = Math.random();
  private gain: number;
  private pl: number;
  private pr: number;
  private killRamp = -1;
  private vel: number;
  constructor(private sr: number, public p: Params, n: PrismaNote, startPitch: number) {
    this.key = n.key;
    this.gate = n.gate;
    this.target = n.key + (n.detune ?? 0);
    this.pitch = startPitch + (n.detune ?? 0);
    this.vel = n.vel;
    const u = Math.max(1, Math.min(9, Math.round(num(p, 'unison', 1))));
    this.phases = new Float64Array(u);
    this.incs = new Float64Array(u);
    this.gl = new Float64Array(u);
    this.gr = new Float64Array(u);
    // Fase: 0 = todas as vozes começam juntas (ataque mais forte), 1 = aleatória.
    const phaseVar = num(p, 'uniPhase', 1);
    for (let i = 0; i < u; i++) this.phases[i] = u === 1 ? 0 : Math.random() * phaseVar * TABLE;
    this.amp = new Adsr(sr);
    this.fenv = new Adsr(sr);
    this.applyEnv();
    this.amp.trigger();
    this.fenv.trigger();
    const sens = num(p, 'velSens', 0.6);
    this.gain = (1 - sens + sens * n.vel * n.vel) * num(p, 'gain', 0.6) / Math.sqrt(u);
    [this.pl, this.pr] = panGains(n.pan);
  }
  applyEnv() {
    const p = this.p;
    this.amp.a = num(p, 'a', 0.002);
    this.amp.d = num(p, 'd', 0.3);
    this.amp.s = num(p, 's', 0.8);
    this.amp.r = num(p, 'r', 0.25);
    this.fenv.a = num(p, 'fa', 0.002);
    this.fenv.d = num(p, 'fd', 0.4);
    this.fenv.s = num(p, 'fs', 0.2);
    this.fenv.r = num(p, 'fr', 0.3);
  }
  legato(n: PrismaNote) {
    this.key = n.key;
    this.target = n.key + (n.detune ?? 0);
    this.gate = n.gate;
    if (this.amp.stage === 4 || this.amp.stage === 0) {
      this.amp.trigger();
      this.fenv.trigger();
      this.t = 0;
    }
  }
  release() {
    this.amp.release();
    this.fenv.release();
  }
  kill() {
    this.killRamp = 64;
  }

  /** Recalcula espectro, tabela e incrementos (uma vez por bloco de controle). */
  private control() {
    const p = this.p;
    const sr = this.sr;
    const dt = CB / sr;
    const glide = num(p, 'glide', 0);
    if (glide > 0) {
      const c = Math.exp(-dt / (glide * 0.3));
      this.pitch = this.target + (this.pitch - this.target) * c;
    } else this.pitch = this.target;
    // LFOs
    this.vibPh = (this.vibPh + num(p, 'vibRate', 5) * dt) % 1;
    this.lfoPh = (this.lfoPh + num(p, 'lfoRate', 2) * dt) % 1;
    this.phPh = (this.phPh + num(p, 'phaserRate', 0.25) * dt) % 1;
    const vibDelay = num(p, 'vibDelay', 0.3);
    const vibAmt = num(p, 'vibrato', 0) * Math.min(1, vibDelay > 0 ? this.t / vibDelay : 1);
    const pitch = this.pitch + (vibAmt / 100) * Math.sin(TAU * this.vibPh);
    const f0 = mtof(pitch);
    const u = this.phases.length;
    const detune = num(p, 'detune', 14) / 100;
    const spread = num(p, 'spread', 0.8);
    for (let i = 0; i < u; i++) {
      const off = u === 1 ? 0 : (i / (u - 1)) * 2 - 1;
      this.incs[i] = (mtof(pitch + off * detune) / sr) * TABLE;
      const pan = off * spread;
      this.gl[i] = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
      this.gr[i] = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    }
    // Espectro: o limite de harmônicos considera a camada mais aguda (sem aliasing).
    const maxF = f0 * Math.pow(2, detune / 12) * (num(p, 'oct', 0) > 0 ? 2 : 1);
    const st: SpectrumState = { t: this.t, fenv: this.fenv.value, vel: this.vel, lfo: Math.sin(TAU * this.lfoPh), phaser: this.phPh };
    const H = prismaSpectrum(p, f0, sr, st, this.amps, maxF);
    // Variação: metade das vozes com o corte deslocado (até 1,5 oitava).
    this.vary = u > 1 ? num(p, 'uniVary', 0) : 0;
    const HV = this.vary > 0 ? prismaSpectrum(p, f0, sr, st, this.ampsV, maxF, this.vary * 1.5) : 0;
    let diff = 0, peak = 1e-9;
    for (let k = 1; k <= H; k++) {
      diff = Math.max(diff, Math.abs(this.amps[k] - this.prevAmps[k]));
      peak = Math.max(peak, this.amps[k]);
    }
    for (let k = H + 1; k <= MAX_HARM && this.prevAmps[k] !== 0; k++) diff = Math.max(diff, this.prevAmps[k]);
    for (let k = 1; k <= HV; k++) diff = Math.max(diff, Math.abs(this.ampsV[k] - this.prevAmpsV[k]));
    if (!this.hasTable || diff > peak * 2e-3) {
      // tabela nova: a atual vira a "anterior" e cruza ao longo do bloco
      let tmp = this.tabB;
      this.tabB = this.tabA;
      this.tabA = tmp;
      synthTable(this.amps, H, this.tabA, this.re, this.im);
      if (this.vary > 0) {
        tmp = this.tabVB;
        this.tabVB = this.tabVA;
        this.tabVA = tmp;
        synthTable(this.ampsV, HV, this.tabVA, this.re, this.im);
        this.prevAmpsV.set(this.ampsV);
      }
      if (!this.hasTable) {
        this.tabB.set(this.tabA);
        this.tabVB.set(this.tabVA);
      }
      this.hasTable = true;
      this.xf = 0;
      this.prevAmps.set(this.amps);
    }
    this.t += dt;
    this.blockPos = 0;
  }

  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    const u = this.phases.length;
    const octL = num(this.p, 'oct', 0);
    const subL = num(this.p, 'sub', 0);
    for (let i = from; i < to; i++) {
      if (this.blockPos >= CB) this.control();
      const w = this.xf < 1 ? this.blockPos / CB : 1;
      const vary = this.vary > 0;
      let l = 0, r = 0;
      for (let k = 0; k < u; k++) {
        const odd = vary && (k & 1) === 1;
        const A = odd ? this.tabVA : this.tabA;
        const B = odd ? this.tabVB : this.tabB;
        let ph = this.phases[k];
        const idx = ph | 0;
        const fr = ph - idx;
        const va = A[idx] + (A[idx + 1] - A[idx]) * fr;
        let v = va;
        if (w < 1) {
          const vb = B[idx] + (B[idx + 1] - B[idx]) * fr;
          v = vb + (va - vb) * w;
        }
        l += v * this.gl[k];
        r += v * this.gr[k];
        ph += this.incs[k];
        if (ph >= TABLE) ph -= TABLE;
        this.phases[k] = ph;
      }
      if (octL > 0 || subL > 0) {
        const A = this.tabA;
        const base = this.incs[u >> 1];
        if (octL > 0) {
          const idx = this.octPh | 0;
          const v = (A[idx] + (A[idx + 1] - A[idx]) * (this.octPh - idx)) * octL * Math.sqrt(u);
          l += v;
          r += v;
          this.octPh += base * 2;
          while (this.octPh >= TABLE) this.octPh -= TABLE;
        }
        if (subL > 0) {
          const idx = this.subPh | 0;
          const v = (A[idx] + (A[idx + 1] - A[idx]) * (this.subPh - idx)) * subL * Math.sqrt(u);
          l += v;
          r += v;
          this.subPh += base * 0.5;
          if (this.subPh >= TABLE) this.subPh -= TABLE;
        }
      }
      this.blockPos++;
      if (this.blockPos >= CB) this.xf = 1;
      this.fenv.next();
      let g = this.amp.next() * this.gain;
      if (this.killRamp >= 0) {
        g *= this.killRamp / 64;
        if (this.killRamp-- === 0) this.done = true;
      }
      L[i] += l * g * this.pl;
      R[i] += r * g * this.pr;
      if (!this.amp.active) {
        this.done = true;
        return;
      }
    }
  }
}

/** Ensemble estéreo (chorus de 3 vozes) aplicado na saída do instrumento. */
export class Ensemble {
  private dl: DelayLine;
  private dr: DelayLine;
  private ph = 0;
  constructor(private sr: number) {
    this.dl = new DelayLine(Math.ceil(sr * 0.05));
    this.dr = new DelayLine(Math.ceil(sr * 0.05));
  }
  process(L: Float32Array, R: Float32Array, from: number, to: number, amount: number) {
    const base = this.sr * 0.012;
    const depth = this.sr * 0.004;
    for (let i = from; i < to; i++) {
      this.ph += 0.6 / this.sr;
      if (this.ph >= 1) this.ph -= 1;
      const m = (L[i] + R[i]) * 0.5;
      this.dl.write(m);
      this.dr.write(m);
      let wl = 0, wr = 0;
      for (let v = 0; v < 3; v++) {
        const o = Math.sin(TAU * (this.ph + v / 3));
        wl += this.dl.read(base + depth * o);
        wr += this.dr.read(base + depth * Math.sin(TAU * (this.ph + v / 3 + 0.25)));
      }
      L[i] = L[i] * (1 - amount * 0.5) + (wl / 3) * amount;
      R[i] = R[i] * (1 - amount * 0.5) + (wr / 3) * amount;
    }
  }
}
