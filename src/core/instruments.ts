// Instrumentos nativos do Music Labs. Cada canal do rack tem uma instância; a
// engine chama noteOn com deslocamento exato dentro do bloco.

import type { InstrumentType, Params } from './model.js';
import { Adsr, DelayLine, Osc, OnePole, Svf, TAU, Wave, clamp, dbToGain, mtof, panGains } from './dsp.js';
import { INSTRUMENTS, defaults } from './registry.js';
import { PAD_BASE, PAD_COUNT, parsePads } from './pads.js';
import { Ensemble, PrismaVoice } from './prisma.js';

export interface SampleData {
  sr: number;
  ch: Float32Array[]; // 1 ou 2 canais
  /** Nota raiz gravada no arquivo (bloco smpl), MIDI fracionário. */
  root?: number;
  /** Loop de sustentação [início, fim) em frames. */
  loop?: [number, number];
}

/** Uma região de um instrumento multi-sample. */
export interface SampleZone {
  key: string; // chave do sample no banco
  root: number; // MIDI fracionário (já inclui a afinação fina)
  lo: number;
  hi: number;
  vlo: number; // 0..1
  vhi: number;
}

export interface SampleSet {
  name: string;
  zones: SampleZone[];
}

/** Banco de samples da engine: arquivos soltos e instrumentos multi-sample. */
export interface SampleBank {
  get(path: string): SampleData | undefined;
  set(path: string): SampleSet | undefined;
}

/** Compatibilidade: aceita uma função simples de busca de arquivo. */
export type SampleLookup = SampleBank | ((path: string) => SampleData | undefined);

function asBank(l: SampleLookup): SampleBank {
  return typeof l === 'function' ? { get: l, set: () => undefined } : l;
}

/** Escolhe a zona pela tecla (raiz mais próxima dentro da faixa) e pela velocity. */
export function pickZone(set: SampleSet, key: number, vel: number): SampleZone | undefined {
  let cands = set.zones.filter((z) => key >= z.lo && key <= z.hi);
  if (!cands.length) {
    let best: SampleZone | undefined;
    for (const z of set.zones) if (!best || Math.abs(z.root - key) < Math.abs(best.root - key)) best = z;
    if (!best) return undefined;
    cands = set.zones.filter((z) => z.lo === best!.lo && z.hi === best!.hi);
  }
  return cands.find((z) => vel >= z.vlo && vel <= z.vhi) ?? cands[cands.length - 1];
}

export interface NoteOn {
  key: number;
  vel: number;
  gate: number; // amostras até o note-off
  pan: number;
  slide?: boolean;
  /** Afinação fina em semitons (fração), aplicada sem mudar a tecla da voz. */
  detune?: number;
}

interface Voice {
  key: number;
  age: number;
  done: boolean;
  gate: number;
  /** Escreve (soma) amostras [from, to) em L/R; devolve false quando terminou. */
  render(L: Float32Array, R: Float32Array, from: number, to: number): void;
  release(): void;
  kill(): void;
}

const num = (p: Params, k: string, d = 0) => (typeof p[k] === 'number' ? (p[k] as number) : d);
const str = (p: Params, k: string, d = '') => (typeof p[k] === 'string' ? (p[k] as string) : d);
const bool = (p: Params, k: string) => p[k] === true;

const velGain = (vel: number, sens: number) => 1 - sens + sens * vel * vel;

export abstract class Instrument {
  protected voices: Voice[] = [];
  protected p: Params;
  protected maxVoices = 16;
  private ageCounter = 0;
  protected samples: SampleBank;
  constructor(protected sr: number, public type: InstrumentType, params: Params, samples: SampleLookup) {
    this.p = { ...defaults(INSTRUMENTS[type].params), ...params };
    this.samples = asBank(samples);
  }
  setParams(params: Params) {
    this.p = { ...defaults(INSTRUMENTS[this.type].params), ...params };
  }
  get cutGroup() {
    return num(this.p, 'cut', 0);
  }
  protected abstract makeVoice(n: NoteOn): Voice | null;
  noteOn(n: NoteOn) {
    const v = this.makeVoice(n);
    if (!v) return;
    v.age = this.ageCounter++;
    if (this.voices.length >= this.maxVoices) {
      let oldest = 0;
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i].age < this.voices[oldest].age) oldest = i;
      this.voices.splice(oldest, 1);
    }
    this.voices.push(v);
  }
  /** Corta vozes (grupo de corte / stop). */
  choke() {
    for (const v of this.voices) v.kill();
  }
  allOff() {
    for (const v of this.voices) v.release();
  }
  hardStop() {
    this.voices = [];
  }
  get busy() {
    return this.voices.length > 0;
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    for (const v of this.voices) {
      // gate: dispara o release dentro do bloco no ponto exato.
      if (v.gate > 0 && v.gate < to - from) {
        const cut = from + v.gate;
        v.render(L, R, from, cut);
        v.gate = 0;
        v.release();
        v.render(L, R, cut, to);
      } else {
        v.render(L, R, from, to);
        if (v.gate > 0) {
          v.gate -= to - from;
          if (v.gate <= 0) {
            v.gate = 0;
            v.release();
          }
        }
      }
    }
    if (this.voices.some((v) => v.done)) this.voices = this.voices.filter((v) => !v.done);
  }
}

// ---------------------------------------------------------------- Synth

class SynthVoice implements Voice {
  age = 0;
  done = false;
  gate: number;
  key: number;
  pitch: number; // MIDI fracionário atual (glide)
  target: number;
  private osc1: Osc[] = [];
  private osc2: Osc[] = [];
  private sub = new Osc();
  private amp: Adsr;
  private fenv: Adsr;
  private fl: Svf;
  private fr: Svf;
  private lfo = Math.random();
  private gain: number;
  private pl: number;
  private pr: number;
  private killRamp = -1;
  private inc1 = new Float64Array(7);
  private inc2 = new Float64Array(7);
  private gL = new Float64Array(7);
  private gR = new Float64Array(7);
  constructor(private sr: number, private p: Params, n: NoteOn, startPitch: number) {
    this.key = n.key;
    this.gate = n.gate;
    this.target = n.key + (n.detune ?? 0);
    this.pitch = startPitch + (n.detune ?? 0);
    const u = Math.round(num(p, 'unison', 1));
    for (let i = 0; i < u; i++) {
      this.osc1.push(new Osc());
      this.osc2.push(new Osc());
    }
    this.amp = new Adsr(sr);
    this.fenv = new Adsr(sr);
    this.applyEnv();
    this.amp.trigger();
    this.fenv.trigger();
    this.fl = new Svf(sr);
    this.fr = new Svf(sr);
    this.gain = velGain(n.vel, num(p, 'velSens', 0.6)) * num(p, 'gain', 0.5) / Math.sqrt(u);
    [this.pl, this.pr] = panGains(n.pan);
  }
  applyEnv() {
    const p = this.p;
    this.amp.a = num(p, 'a'); this.amp.d = num(p, 'd'); this.amp.s = num(p, 's'); this.amp.r = num(p, 'r');
    this.fenv.a = num(p, 'fa'); this.fenv.d = num(p, 'fd'); this.fenv.s = num(p, 'fs'); this.fenv.r = num(p, 'fr');
  }
  legato(n: NoteOn) {
    this.key = n.key;
    this.target = n.key + (n.detune ?? 0);
    this.gate = n.gate;
    if (this.amp.stage === 4 || this.amp.stage === 0) {
      this.amp.trigger();
      this.fenv.trigger();
    }
  }
  release() {
    this.amp.release();
    this.fenv.release();
  }
  kill() {
    this.killRamp = 64;
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    const p = this.p;
    const sr = this.sr;
    const w1 = str(p, 'osc1', 'saw') as Wave;
    const w2 = str(p, 'osc2', 'square') as Wave;
    const semi2 = num(p, 'osc2Semi');
    const fine2 = num(p, 'osc2Fine') / 100;
    const mix = num(p, 'oscMix', 0.5);
    const subL = num(p, 'sub');
    const noise = num(p, 'noise');
    const u = this.osc1.length;
    const detune = num(p, 'detune') / 100;
    const spread = num(p, 'spread');
    const fmode = { lowpass: 0, highpass: 1, bandpass: 2, off: -1 }[str(p, 'filter', 'lowpass')] ?? 0;
    const cutoff = num(p, 'cutoff', 4000);
    const res = num(p, 'res');
    const fenvAmt = num(p, 'fenv') * 6; // oitavas
    const lfoRate = num(p, 'lfoRate', 4);
    const lfoPitch = num(p, 'lfoPitch');
    const lfoCut = num(p, 'lfoCutoff');
    const glide = num(p, 'glide');
    const glideCoef = glide > 0 ? Math.exp(-1 / (glide * sr * 0.3)) : 0;
    // Taxa de controle: frequências, pan da unison e LFO a cada 32 amostras.
    const inc1 = this.inc1, inc2 = this.inc2, gl = this.gL, gr = this.gR;
    let lfo = 0, subInc = 0;
    for (let i = from; i < to; i++) {
      if (((i - from) & 31) === 0) {
        const steps = Math.min(32, to - i);
        for (let s = 0; s < steps; s++) this.pitch = this.target + (this.pitch - this.target) * glideCoef;
        this.lfo = (this.lfo + (lfoRate * steps) / sr) % 1;
        lfo = Math.sin(TAU * this.lfo);
        const base = this.pitch + lfo * lfoPitch;
        for (let k = 0; k < u; k++) {
          const off = u === 1 ? 0 : (k / (u - 1) - 0.5) * 2; // -1..1
          const det = off * detune;
          inc1[k] = mtof(base + det) / sr;
          inc2[k] = mtof(base + semi2 + fine2 + det) / sr;
          const pan = off * spread;
          gl[k] = 1 - pan * 0.5;
          gr[k] = 1 + pan * 0.5;
        }
        subInc = mtof(base - 12) / sr;
      }
      let l = 0, r = 0;
      for (let k = 0; k < u; k++) {
        const s = this.osc1[k].next(w1, inc1[k]) * (1 - mix) + this.osc2[k].next(w2, inc2[k]) * mix;
        l += s * gl[k];
        r += s * gr[k];
      }
      if (subL > 0) {
        const s = this.sub.next('sine', subInc) * subL * Math.sqrt(u);
        l += s;
        r += s;
      }
      if (noise > 0) {
        const s = (Math.random() * 2 - 1) * noise * Math.sqrt(u);
        l += s;
        r += s;
      }
      const fe = this.fenv.next();
      const a = this.amp.next();
      if (fmode >= 0) {
        if ((i & 15) === 0 || i === from) {
          const c = cutoff * Math.pow(2, fe * fenvAmt + lfo * lfoCut * 3);
          this.fl.set(c, res);
          this.fr.set(c, res);
        }
        l = this.fl.process(l, fmode);
        r = this.fr.process(r, fmode);
      }
      let g = a * this.gain;
      if (this.killRamp >= 0) {
        g *= this.killRamp / 64;
        if (this.killRamp-- === 0) this.done = true;
      }
      L[i] += l * g * this.pl;
      R[i] += r * g * this.pr;
      if (!this.amp.active) {
        this.done = true;
        break;
      }
    }
  }
}

export class SynthInstrument extends Instrument {
  maxVoices = 12;
  private lastPitch = 60;
  protected makeVoice(n: NoteOn): Voice | null {
    const mono = bool(this.p, 'mono');
    const glide = num(this.p, 'glide') > 0 || n.slide;
    if (mono) {
      const live = this.voices.find((v) => !v.done) as SynthVoice | undefined;
      for (const v of this.voices) if (v !== live) v.kill();
      if (live) {
        live.legato(n);
        this.lastPitch = n.key;
        return null;
      }
    }
    const v = new SynthVoice(this.sr, this.p, n, glide ? this.lastPitch : n.key);
    this.lastPitch = n.key;
    return v;
  }
  setParams(params: Params) {
    super.setParams(params);
    for (const v of this.voices) {
      (v as any).p = this.p;
      (v as SynthVoice).applyEnv();
    }
  }
}

// ---------------------------------------------------------------- Sampler

class SamplerVoice implements Voice {
  age = 0;
  done = false;
  gate: number;
  key: number;
  private pos: number;
  private inc: number;
  private env: Adsr;
  private gain: number;
  private pl: number;
  private pr: number;
  private filt: [Svf, Svf] | null = null;
  private killRamp = -1;
  private loopS = -1;
  private loopE = -1;
  private xf = 0;
  constructor(sr: number, private p: Params, private s: SampleData, n: NoteOn, root: number, forceKeytrack: boolean) {
    this.key = n.key;
    const oneshot = bool(p, 'oneshot');
    const len = s.ch[0].length;
    const reverse = bool(p, 'reverse');
    const semis = (forceKeytrack || bool(p, 'keytrack') ? n.key - root : 0) + (n.detune ?? 0);
    this.inc = ((Math.pow(2, semis / 12) * s.sr) / sr) * (reverse ? -1 : 1);
    const st = num(p, 'start') * len;
    this.pos = reverse ? len - 1 - st : st;
    // Loop de sustentação: usa os pontos do arquivo; sem eles, cria um com crossfade.
    if (bool(p, 'loop') && !reverse && len > 256) {
      if (s.loop) {
        [this.loopS, this.loopE] = s.loop;
        this.xf = Math.min(96, (this.loopE - this.loopS) / 4);
      } else {
        this.loopS = Math.floor(len * 0.35);
        this.loopE = Math.floor(len * 0.92);
        this.xf = Math.min(s.sr * 0.15, (this.loopE - this.loopS) / 2);
      }
      this.xf = Math.max(0, Math.min(this.xf, this.loopS));
      if (this.loopE - this.loopS < 32 || this.loopS < 0) this.loopS = this.loopE = -1;
    }
    // One-shot toca o arquivo até o fim; com loop ligado precisa respeitar a nota.
    this.gate = oneshot && this.loopE < 0 ? 0 : n.gate;
    this.env = new Adsr(sr);
    this.env.a = num(p, 'a');
    this.env.d = num(p, 'd');
    this.env.s = num(p, 's');
    this.env.r = num(p, 'r');
    if (oneshot) this.env.s = this.env.d >= 7.9 ? 1 : this.env.s;
    this.env.trigger();
    this.gain = velGain(n.vel, num(p, 'velSens', 0.7)) * num(p, 'gain', 1);
    [this.pl, this.pr] = panGains(n.pan);
    const cutoff = num(p, 'cutoff', 20000);
    if (cutoff < 19000 || num(p, 'res') > 0.05) {
      this.filt = [new Svf(sr), new Svf(sr)];
      this.filt[0].set(cutoff, num(p, 'res'));
      this.filt[1].set(cutoff, num(p, 'res'));
    }
  }
  release() {
    this.env.release();
  }
  kill() {
    this.killRamp = 48;
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    const ch0 = this.s.ch[0];
    const ch1 = this.s.ch[1] ?? ch0;
    const len = ch0.length;
    const looping = this.loopE > 0;
    const loopLen = this.loopE - this.loopS;
    const wholeLoop = !looping && bool(this.p, 'loop');
    for (let i = from; i < to; i++) {
      if (looping && this.pos >= this.loopE) this.pos -= loopLen;
      if (this.pos < 0 || this.pos >= len - 1) {
        if (wholeLoop && len > 2) this.pos = this.inc > 0 ? 0 : len - 2;
        else {
          this.done = true;
          return;
        }
      }
      const idx = this.pos | 0;
      const f = this.pos - idx;
      let l = ch0[idx] + (ch0[idx + 1] - ch0[idx]) * f;
      let r = ch1[idx] + (ch1[idx + 1] - ch1[idx]) * f;
      if (looping && this.xf > 0 && this.pos > this.loopE - this.xf) {
        // crossfade de potência constante com o trecho antes do início do loop
        const t = (this.pos - (this.loopE - this.xf)) / this.xf;
        const ap = this.pos - loopLen;
        const ai = ap | 0;
        const af = ap - ai;
        const al = ch0[ai] + (ch0[ai + 1] - ch0[ai]) * af;
        const ar = ch1[ai] + (ch1[ai + 1] - ch1[ai]) * af;
        const g1 = Math.cos((t * Math.PI) / 2), g2 = Math.sin((t * Math.PI) / 2);
        l = l * g1 + al * g2;
        r = r * g1 + ar * g2;
      }
      this.pos += this.inc;
      if (this.filt) {
        l = this.filt[0].process(l, 0);
        r = this.filt[1].process(r, 0);
      }
      let g = this.env.next() * this.gain;
      if (this.killRamp >= 0) {
        g *= this.killRamp / 48;
        if (this.killRamp-- === 0) this.done = true;
      }
      L[i] += l * g * this.pl;
      R[i] += r * g * this.pr;
      if (!this.env.active) {
        this.done = true;
        return;
      }
    }
  }
}

export class SamplerInstrument extends Instrument {
  maxVoices = 32;
  protected makeVoice(n: NoteOn): Voice | null {
    const path = str(this.p, 'sample');
    const set = this.samples.set(path);
    if (set) {
      const z = pickZone(set, n.key, n.vel);
      const data = z && this.samples.get(z.key);
      if (!z || !data || data.ch[0].length < 2) return null;
      return new SamplerVoice(this.sr, this.p, data, n, z.root, true);
    }
    const s = this.samples.get(path);
    if (!s || s.ch[0].length < 2) return null;
    return new SamplerVoice(this.sr, this.p, s, n, num(this.p, 'root', 60), false);
  }
}

// ---------------------------------------------------------------- Drum synth

const HAT_RATIOS = [1, 1.483, 1.932, 2.546, 2.63, 3.897];

class DrumVoice implements Voice {
  age = 0;
  done = false;
  gate = 0;
  key: number;
  private t = 0;
  private ph = 0;
  private ph2 = 0;
  private hatPh = new Float64Array(6);
  private bp: Svf;
  private hp: Svf;
  private gain: number;
  private pl: number;
  private pr: number;
  private killRamp = -1;
  private kind: string;
  private f0: number;
  constructor(private sr: number, private p: Params, n: NoteOn, kindOverride?: string) {
    this.key = n.key;
    this.kind = kindOverride ?? str(p, 'kind', 'kick');
    if (kindOverride) {
      // No modo kit cada peça usa seu próprio decay típico, escalado pelo knob.
      const typical: Record<string, number> = { kick: 0.45, snare: 0.25, clap: 0.3, hat: 0.06, openhat: 0.4, tom: 0.4, rim: 0.08, perc: 0.15 };
      const scale = num(p, 'decay', 0.4) / 0.4;
      this.p = { ...p, decay: (typical[kindOverride] ?? 0.3) * scale, keytrack: false, tune: num(p, 'tune') + (kindOverride === 'tom' ? (n.key - 45) * 1.5 : 0) };
      p = this.p;
    }
    const tune = num(p, 'tune') + (bool(p, 'keytrack') ? n.key - 60 : 0) + (n.detune ?? 0);
    const base: Record<string, number> = { kick: 52, '808': 49, snare: 185, clap: 1100, hat: 330, openhat: 330, tom: 110, rim: 1700, perc: 380 };
    this.f0 = (this.kind === '808' && bool(p, 'keytrack') ? mtof(n.key - 24) : base[this.kind] ?? 100) * Math.pow(2, (this.kind === '808' && bool(p, 'keytrack') ? num(p, 'tune') + (n.detune ?? 0) : tune) / 12);
    this.bp = new Svf(sr);
    this.hp = new Svf(sr);
    const tone = num(p, 'tone', 0.5);
    if (this.kind === 'snare') this.bp.set(1500 + tone * 4000, 0.3);
    else if (this.kind === 'clap') this.bp.set(800 + tone * 1200, 0.55);
    else if (this.kind === 'rim') this.bp.set(this.f0, 0.85);
    this.hp.set(this.kind.includes('hat') ? 5000 + tone * 4000 : 30, 0.2);
    this.gain = velGain(n.vel, num(p, 'velSens', 0.7)) * num(p, 'gain', 0.9);
    [this.pl, this.pr] = panGains(n.pan);
  }
  release() {}
  kill() {
    this.killRamp = 64;
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    const p = this.p;
    const sr = this.sr;
    const decay = num(p, 'decay', 0.4);
    const punch = num(p, 'punch', 0.5);
    const snap = num(p, 'snap', 0.5);
    const tone = num(p, 'tone', 0.5);
    const drive = 1 + num(p, 'drive') * 8;
    const k = this.kind;
    for (let i = from; i < to; i++) {
      const t = this.t;
      this.t += 1 / sr;
      let s = 0;
      let env = Math.exp(-t / (decay * 0.3));
      if (k === 'kick' || k === '808' || k === 'tom' || k === 'perc') {
        const pd = k === 'kick' ? 0.035 + (1 - punch) * 0.03 : k === '808' ? 0.05 : 0.04;
        const sweep = k === 'kick' ? 1 + punch * 5 : k === '808' ? 1 + punch * 1.5 : k === 'tom' ? 1.6 : 2.2;
        const f = this.f0 * (1 + (sweep - 1) * Math.exp(-t / pd));
        this.ph += f / sr;
        s = Math.sin(TAU * this.ph);
        if (k === 'kick') {
          s += (Math.random() * 2 - 1) * snap * 0.4 * Math.exp(-t / 0.004) ; // clique
          env = t < 0.002 ? t / 0.002 : Math.exp(-t / (decay * 0.35)) * (0.7 + 0.3 * tone);
        }
        if (k === '808') env = Math.min(1, t / 0.002) * Math.exp(-t / (decay * 0.45));
      } else if (k === 'snare') {
        this.ph += this.f0 / sr;
        this.ph2 += (this.f0 * 1.78) / sr;
        const body = (Math.sin(TAU * this.ph) + 0.5 * Math.sin(TAU * this.ph2)) * Math.exp(-t / 0.05) * (1 - snap * 0.5);
        const nz = this.bp.process(Math.random() * 2 - 1, 1) * Math.exp(-t / (decay * 0.4)) * (0.5 + snap);
        s = body + nz;
        env = 1;
      } else if (k === 'clap') {
        const n = this.bp.process(Math.random() * 2 - 1, 2) * 2.5;
        const bursts = [0, 0.011, 0.022];
        let e = 0;
        for (const b of bursts) if (t >= b) e = Math.max(e, Math.exp(-(t - b) / 0.006));
        e = Math.max(e, t >= 0.03 ? Math.exp(-(t - 0.03) / (decay * 0.4)) * 0.8 : 0);
        s = n;
        env = e;
      } else if (k === 'hat' || k === 'openhat') {
        let m = 0;
        for (let j = 0; j < 6; j++) {
          this.hatPh[j] += (this.f0 * HAT_RATIOS[j] * (1 + tone)) / sr;
          m += this.hatPh[j] % 1 < 0.5 ? 1 : -1;
        }
        s = this.hp.process(m / 6 * (1 - snap * 0.5) + (Math.random() * 2 - 1) * snap * 0.5, 1) * 1.5;
        env = Math.exp(-t / (decay * (k === 'hat' ? 0.25 : 0.4)));
      } else if (k === 'rim') {
        this.ph += this.f0 / sr;
        s = this.bp.process(Math.sin(TAU * this.ph) + (Math.random() - 0.5) * 0.5, 2) * 2;
        env = Math.exp(-t / Math.max(0.01, decay * 0.3));
      }
      s = Math.tanh(s * env * drive) / Math.tanh(drive);
      let g = this.gain;
      if (this.killRamp >= 0) {
        g *= this.killRamp / 64;
        if (this.killRamp-- === 0) {
          this.done = true;
          return;
        }
      }
      L[i] += s * g * this.pl;
      R[i] += s * g * this.pr;
      if (t > 0.05 && env < 1e-4) {
        this.done = true;
        return;
      }
      if (t > 8) {
        this.done = true;
        return;
      }
    }
  }
}

/** Mapa General MIDI de bateria (usado pelo modo kit e pelo import de FPC). */
export function gmDrum(key: number): string {
  if (key === 35 || key === 36) return 'kick';
  if (key === 37) return 'rim';
  if (key === 38 || key === 40) return 'snare';
  if (key === 39) return 'clap';
  if (key === 42 || key === 44) return 'hat';
  if (key === 46 || key === 49 || key === 51 || key === 52 || key === 55 || key === 57 || key === 59) return 'openhat';
  if ([41, 43, 45, 47, 48, 50].includes(key)) return 'tom';
  return 'perc';
}

export class DrumInstrument extends Instrument {
  maxVoices = 16;
  protected makeVoice(n: NoteOn): Voice | null {
    if (str(this.p, 'kind') === 'kit') {
      const piece = gmDrum(n.key);
      // corta a mesma peça; chimbal fechado corta o aberto
      for (const v of this.voices) {
        const k = (v as any).kind;
        if (k === piece || (piece === 'hat' && k === 'openhat')) v.kill();
      }
      return new DrumVoice(this.sr, this.p, n, piece);
    }
    // Peça de bateria é monofônica por canal (como um sample com corte próprio).
    for (const v of this.voices) v.kill();
    return new DrumVoice(this.sr, this.p, n);
  }
}

// ---------------------------------------------------------------- Pluck

class PluckVoice implements Voice {
  age = 0;
  done = false;
  gate: number;
  key: number;
  private line: DelayLine;
  private period: number;
  private lp = 0;
  private body: Svf;
  private gain: number;
  private pl: number;
  private pr: number;
  private releasing = false;
  private relGain = 1;
  private relCoef: number;
  private quiet = 0;
  private killRamp = -1;
  constructor(sr: number, private p: Params, n: NoteOn) {
    this.key = n.key;
    this.gate = n.gate;
    const f = mtof(n.key + (n.detune ?? 0));
    this.period = sr / f;
    this.line = new DelayLine(Math.ceil(this.period) + 4);
    const bright = num(p, 'bright', 0.7);
    const exc = new OnePole();
    exc.setLowpass(500 + bright * bright * 15000, sr);
    for (let i = 0; i < this.line.buf.length; i++) this.line.write(exc.lp(Math.random() * 2 - 1));
    this.body = new Svf(sr);
    this.body.set(Math.min(sr * 0.4, f * 2.5), 0.4);
    this.gain = velGain(n.vel, num(p, 'velSens', 0.6)) * num(p, 'gain', 0.8);
    [this.pl, this.pr] = panGains(n.pan);
    this.relCoef = Math.exp(-1 / (num(p, 'r', 0.15) * sr * 0.25));
  }
  release() {
    this.releasing = true;
  }
  kill() {
    this.killRamp = 64;
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    const damp = num(this.p, 'damp', 0.4);
    const decay = num(this.p, 'decay', 0.996);
    const body = num(this.p, 'body', 0.3);
    for (let i = from; i < to; i++) {
      const y = this.line.read(this.period);
      this.lp = this.lp + (y - this.lp) * (1 - damp * 0.9);
      this.line.write(this.lp * decay);
      let s = y + this.body.process(y, 2) * body;
      if (this.releasing) {
        this.relGain *= this.relCoef;
        s *= this.relGain;
      }
      let g = this.gain;
      if (this.killRamp >= 0) {
        g *= this.killRamp / 64;
        if (this.killRamp-- === 0) this.done = true;
      }
      L[i] += s * g * this.pl;
      R[i] += s * g * this.pr;
      this.quiet = Math.abs(s) < 1e-4 ? this.quiet + 1 : 0;
      if (this.quiet > 2000 || this.relGain < 1e-4) {
        this.done = true;
        return;
      }
    }
  }
}

export class PluckInstrument extends Instrument {
  protected makeVoice(n: NoteOn): Voice | null {
    return new PluckVoice(this.sr, this.p, n);
  }
}

// ---------------------------------------------------------------- FM

class FmVoice implements Voice {
  age = 0;
  done = false;
  gate: number;
  key: number;
  private pc = 0;
  private pm = 0;
  private fb = 0;
  private env: Adsr;
  private t = 0;
  private gain: number;
  private pl: number;
  private pr: number;
  private f: number;
  private killRamp = -1;
  constructor(private sr: number, private p: Params, n: NoteOn) {
    this.key = n.key;
    this.gate = n.gate;
    this.f = mtof(n.key + (n.detune ?? 0));
    this.env = new Adsr(sr);
    this.env.a = num(p, 'a'); this.env.d = num(p, 'd'); this.env.s = num(p, 's'); this.env.r = num(p, 'r');
    this.env.trigger();
    this.gain = velGain(n.vel, num(p, 'velSens', 0.7)) * num(p, 'gain', 0.6);
    this.vel = n.vel;
    [this.pl, this.pr] = panGains(n.pan);
  }
  private vel: number;
  release() {
    this.env.release();
  }
  kill() {
    this.killRamp = 64;
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    const ratio = num(this.p, 'ratio', 2);
    const index = num(this.p, 'index', 3) * (0.5 + 0.5 * this.vel);
    const idec = num(this.p, 'indexDecay', 0.6);
    const fbAmt = num(this.p, 'feedback') * 1.5;
    const sr = this.sr;
    for (let i = from; i < to; i++) {
      const ix = index * (0.15 + 0.85 * Math.exp(-this.t / idec));
      this.t += 1 / sr;
      this.pm += (this.f * ratio) / sr;
      const m = Math.sin(TAU * this.pm + this.fb * fbAmt);
      this.fb = m;
      this.pc += this.f / sr;
      const s = Math.sin(TAU * this.pc + m * ix);
      let g = this.env.next() * this.gain;
      if (this.killRamp >= 0) {
        g *= this.killRamp / 64;
        if (this.killRamp-- === 0) this.done = true;
      }
      L[i] += s * g * this.pl;
      R[i] += s * g * this.pr;
      if (!this.env.active) {
        this.done = true;
        return;
      }
    }
  }
}

export class FmInstrument extends Instrument {
  protected makeVoice(n: NoteOn): Voice | null {
    return new FmVoice(this.sr, this.p, n);
  }
}

// ---------------------------------------------------------------- Prisma

export class PrismaInstrument extends Instrument {
  maxVoices = 12;
  private lastPitch = 60;
  private ens: Ensemble;
  private tl = new Float32Array(128);
  private tr = new Float32Array(128);
  constructor(sr: number, type: InstrumentType, params: Params, samples: SampleLookup) {
    super(sr, type, params, samples);
    this.ens = new Ensemble(sr);
  }
  protected makeVoice(n: NoteOn): Voice | null {
    const mono = bool(this.p, 'mono');
    const glide = num(this.p, 'glide') > 0 || n.slide;
    if (mono) {
      const live = this.voices.find((v) => !v.done) as unknown as PrismaVoice | undefined;
      for (const v of this.voices) if ((v as unknown) !== live) v.kill();
      if (live) {
        live.legato(n);
        this.lastPitch = n.key;
        return null;
      }
    }
    const v = new PrismaVoice(this.sr, this.p, n, glide ? this.lastPitch : n.key);
    this.lastPitch = n.key;
    return v as unknown as Voice;
  }
  setParams(params: Params) {
    super.setParams(params);
    for (const v of this.voices) {
      (v as unknown as PrismaVoice).p = this.p;
      (v as unknown as PrismaVoice).applyEnv();
    }
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    const amount = num(this.p, 'ensemble', 0);
    if (amount <= 0) return super.render(L, R, from, to);
    if (this.tl.length < to) {
      this.tl = new Float32Array(to);
      this.tr = new Float32Array(to);
    }
    this.tl.fill(0, from, to);
    this.tr.fill(0, from, to);
    super.render(this.tl, this.tr, from, to);
    this.ens.process(this.tl, this.tr, from, to, amount);
    for (let i = from; i < to; i++) {
      L[i] += this.tl[i];
      R[i] += this.tr[i];
    }
  }
}

// ---------------------------------------------------------------- Soundpad

/**
 * 16 pads, cada um um instrumento próprio (sampler com o arquivo do pad, ou o instrumento
 * nativo/preset escolhido). A nota que chega escolhe o pad (C2 = pad 1); o pad toca a
 * nota dele (C4 = altura original do sample) com a afinação e o ganho do pad.
 */
class PadsInstrument extends Instrument {
  private subs: (Instrument | null)[] = [];
  private sigs: string[] = [];
  private gains: number[] = [];
  private notes: number[] = [];
  private tl = new Float32Array(0);
  private tr = new Float32Array(0);
  constructor(sr: number, type: InstrumentType, params: Params, private lookup: SampleLookup) {
    super(sr, type, params, lookup);
    this.build();
  }
  setParams(params: Params) {
    super.setParams(params);
    this.build();
  }
  /** Recria só os pads que mudaram (os outros continuam tocando). */
  private build() {
    const pads = parsePads(this.p.pads);
    for (let i = 0; i < PAD_COUNT; i++) {
      const s = pads[i];
      const sig = s ? JSON.stringify([s.sample, s.type, s.params]) : '';
      if (sig !== this.sigs[i]) {
        this.sigs[i] = sig;
        this.subs[i] = !s
          ? null
          : s.sample
            ? createInstrument(this.sr, 'sampler', { sample: s.sample, oneshot: true, keytrack: true, root: 60, ...(s.params ?? {}) }, this.lookup)
            : s.type && s.type !== 'pads'
              ? createInstrument(this.sr, s.type, s.params ?? {}, this.lookup)
              : null;
      }
      this.gains[i] = s ? dbToGain(s.gain ?? 0) : 1;
      this.notes[i] = s ? (s.note ?? 60) + (s.tune ?? 0) : 60;
    }
  }
  protected makeVoice(): Voice | null {
    return null;
  }
  noteOn(n: NoteOn) {
    const i = n.key - PAD_BASE;
    const sub = i >= 0 && i < PAD_COUNT ? this.subs[i] : null;
    if (sub) sub.noteOn({ ...n, key: this.notes[i] });
  }
  choke() {
    for (const s of this.subs) s?.choke();
  }
  allOff() {
    for (const s of this.subs) s?.allOff();
  }
  hardStop() {
    for (const s of this.subs) s?.hardStop();
  }
  get busy() {
    return this.subs.some((s) => s?.busy);
  }
  render(L: Float32Array, R: Float32Array, from: number, to: number) {
    if (this.tl.length < L.length) {
      this.tl = new Float32Array(L.length);
      this.tr = new Float32Array(L.length);
    }
    for (let i = 0; i < PAD_COUNT; i++) {
      const s = this.subs[i];
      if (!s?.busy) continue;
      const g = this.gains[i];
      if (g === 1) {
        s.render(L, R, from, to);
        continue;
      }
      this.tl.fill(0, from, to);
      this.tr.fill(0, from, to);
      s.render(this.tl, this.tr, from, to);
      for (let f = from; f < to; f++) {
        L[f] += this.tl[f] * g;
        R[f] += this.tr[f] * g;
      }
    }
  }
}

/** Canal de áudio: o som vem dos clipes da playlist (a engine mistura); notas não tocam nada. */
class AudioChannelInstrument extends Instrument {
  protected makeVoice(): Voice | null {
    return null;
  }
}

export function createInstrument(sr: number, type: InstrumentType, params: Params, samples: SampleLookup): Instrument {
  switch (type) {
    case 'audio':
      return new AudioChannelInstrument(sr, type, params, samples);
    case 'pads':
      return new PadsInstrument(sr, type, params, samples);
    case 'prisma':
      return new PrismaInstrument(sr, type, params, samples);
    case 'synth':
      return new SynthInstrument(sr, type, params, samples);
    case 'sampler':
      return new SamplerInstrument(sr, type, params, samples);
    case 'drum':
      return new DrumInstrument(sr, type, params, samples);
    case 'pluck':
      return new PluckInstrument(sr, type, params, samples);
    case 'fm':
      return new FmInstrument(sr, type, params, samples);
  }
}

export { clamp, dbToGain };
