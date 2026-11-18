// Efeitos de insert. Processam o buffer estéreo no lugar.

import type { EffectType, Params } from './model.js';
import { Biquad, DelayLine, OnePole, Svf, TAU, clamp, dbToGain } from './dsp.js';
import { EFFECTS, defaults } from './registry.js';

export interface FxContext {
  sr: number;
  bpm: number;
  /** Buffers pré-fader dos inserts (para sidechain). */
  insertBus: (index: number) => [Float32Array, Float32Array] | undefined;
  /** Posição da transporte em semínimas (para LFOs sincronizados). */
  beat: number;
}

const num = (p: Params, k: string, d = 0) => (typeof p[k] === 'number' ? (p[k] as number) : d);
const str = (p: Params, k: string, d = '') => (typeof p[k] === 'string' ? (p[k] as string) : d);

export abstract class Fx {
  p: Params;
  constructor(protected sr: number, public type: EffectType, params: Params) {
    this.p = { ...defaults(EFFECTS[type].params), ...params };
  }
  setParams(params: Params) {
    this.p = { ...defaults(EFFECTS[this.type].params), ...params };
    this.update();
  }
  protected update() {}
  abstract process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void;
  /** Redução de ganho atual em dB (para medidores de compressor/limiter). */
  gr = 0;
}

/** Duração de uma figura rítmica ("1/8D", "1/4T") em semínimas. */
export function noteValueBeats(v: string): number {
  const m = /^1\/(\d+)([DT]?)$/.exec(v);
  if (!m) return 1;
  let beats = 4 / Number(m[1]);
  if (m[2] === 'D') beats *= 1.5;
  if (m[2] === 'T') beats *= 2 / 3;
  return beats;
}

class Eq extends Fx {
  private bands: Biquad[][] = [];
  protected update() {
    const p = this.p;
    const mk = () => [new Biquad(), new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    if (this.bands.length === 0) this.bands = [mk(), mk()];
    for (const b of this.bands) {
      b[0].setup('highpass', num(p, 'hpf', 10), this.sr, 0.707);
      b[1].setup('lowshelf', num(p, 'lowFreq', 100), this.sr, 0.707, num(p, 'lowGain'));
      b[2].setup('peak', num(p, 'm1Freq', 500), this.sr, num(p, 'm1Q', 1), num(p, 'm1Gain'));
      b[3].setup('peak', num(p, 'm2Freq', 3000), this.sr, num(p, 'm2Q', 1), num(p, 'm2Gain'));
      b[4].setup('highshelf', num(p, 'highFreq', 8000), this.sr, 0.707, num(p, 'highGain'));
    }
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const useHp = num(this.p, 'hpf', 10) > 12;
    const [bl, br] = this.bands;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (useHp) {
        l = bl[0].process(l);
        r = br[0].process(r);
      }
      for (let k = 1; k < 5; k++) {
        l = bl[k].process(l);
        r = br[k].process(r);
      }
      L[i] = l;
      R[i] = r;
    }
  }
}

class FilterFx extends Fx {
  private f = [new Svf(this.sr), new Svf(this.sr)];
  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext) {
    const mode = { lowpass: 0, highpass: 1, bandpass: 2 }[str(this.p, 'mode', 'lowpass')] ?? 0;
    const cutoff = num(this.p, 'cutoff', 2000);
    const res = num(this.p, 'res', 0.3);
    const depth = num(this.p, 'lfoDepth');
    const period = noteValueBeats(str(this.p, 'lfoSync', '1/4'));
    const beatsPerSample = ctx.bpm / 60 / this.sr;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        const ph = ((ctx.beat + i * beatsPerSample) / period) % 1;
        const lfo = depth > 0 ? (0.5 - 0.5 * Math.cos(TAU * ph)) * depth : 0;
        const c = cutoff * Math.pow(2, -lfo * 6);
        this.f[0].set(c, res);
        this.f[1].set(c, res);
      }
      L[i] = this.f[0].process(L[i], mode);
      R[i] = this.f[1].process(R[i], mode);
    }
  }
}

class Compressor extends Fx {
  private env = 0;
  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext) {
    const thr = num(this.p, 'threshold', -18);
    const ratio = num(this.p, 'ratio', 4);
    const knee = num(this.p, 'knee', 6);
    const makeup = dbToGain(num(this.p, 'makeup'));
    const att = Math.exp(-1 / (num(this.p, 'attack', 10) * 0.001 * this.sr));
    const rel = Math.exp(-1 / (num(this.p, 'release', 120) * 0.001 * this.sr));
    const sc = Math.round(num(this.p, 'sidechain', -1));
    const key = sc >= 0 ? ctx.insertBus(sc) : undefined;
    let maxGr = 0;
    for (let i = 0; i < n; i++) {
      const kl = key ? key[0][i] : L[i];
      const kr = key ? key[1][i] : R[i];
      const x = Math.max(Math.abs(kl), Math.abs(kr));
      const c = x > this.env ? att : rel;
      this.env = x + (this.env - x) * c;
      const db = 20 * Math.log10(this.env + 1e-9);
      let over = db - thr;
      let gr: number;
      if (over <= -knee / 2) gr = 0;
      else if (over >= knee / 2) gr = over - over / ratio;
      else {
        over += knee / 2;
        gr = ((1 - 1 / ratio) * over * over) / (2 * Math.max(knee, 1e-6));
      }
      if (gr > maxGr) maxGr = gr;
      const g = dbToGain(-gr) * makeup;
      L[i] *= g;
      R[i] *= g;
    }
    this.gr = maxGr;
  }
}

class Delay extends Fx {
  private dl = new DelayLine(this.sr * 4);
  private dr = new DelayLine(this.sr * 4);
  private tl = new OnePole();
  private tr = new OnePole();
  protected update() {
    this.tl.setLowpass(num(this.p, 'tone', 5000), this.sr);
    this.tr.setLowpass(num(this.p, 'tone', 5000), this.sr);
  }
  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext) {
    const d = clamp((noteValueBeats(str(this.p, 'time', '1/8D')) * 60 / ctx.bpm) * this.sr, 1, this.sr * 4 - 4);
    const fb = num(this.p, 'feedback', 0.4);
    const pp = this.p.pingpong === true;
    for (let i = 0; i < n; i++) {
      const yl = this.dl.read(d);
      const yr = this.dr.read(d);
      const inl = L[i], inr = R[i];
      if (pp) {
        this.dl.write((inl + inr) * 0.5 + this.tl.lp(yr) * fb);
        this.dr.write(this.tr.lp(yl) * fb);
      } else {
        this.dl.write(inl + this.tl.lp(yl) * fb);
        this.dr.write(inr + this.tr.lp(yr) * fb);
      }
      L[i] = yl;
      R[i] = yr;
    }
  }
}

// Reverb estilo Freeverb (8 combs + 4 allpass por lado), com pré-delay.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];
class Reverb extends Fx {
  private combL: { buf: Float32Array; i: number; f: number }[] = [];
  private combR: { buf: Float32Array; i: number; f: number }[] = [];
  private apL: { buf: Float32Array; i: number }[] = [];
  private apR: { buf: Float32Array; i: number }[] = [];
  private pre = new DelayLine(this.sr * 0.25);
  private lc = [new OnePole(), new OnePole()];
  constructor(sr: number, type: EffectType, params: Params) {
    super(sr, type, params);
    const k = sr / 44100;
    for (const c of COMBS) {
      this.combL.push({ buf: new Float32Array(Math.round(c * k)), i: 0, f: 0 });
      this.combR.push({ buf: new Float32Array(Math.round((c + 23) * k)), i: 0, f: 0 });
    }
    for (const a of ALLPASS) {
      this.apL.push({ buf: new Float32Array(Math.round(a * k)), i: 0 });
      this.apR.push({ buf: new Float32Array(Math.round((a + 23) * k)), i: 0 });
    }
    this.update();
  }
  protected update() {
    if (!this.lc) return;
    for (const l of this.lc) l.setLowpass(num(this.p, 'lowcut', 150), this.sr);
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const room = 0.7 + num(this.p, 'size', 0.7) * 0.28;
    const damp = num(this.p, 'damp', 0.4) * 0.4;
    const width = num(this.p, 'width', 1);
    const pd = (num(this.p, 'predelay', 15) / 1000) * this.sr;
    const w1 = width / 2 + 0.5, w2 = (1 - width) / 2;
    for (let i = 0; i < n; i++) {
      this.pre.write((L[i] + R[i]) * 0.5);
      let x = pd > 1 ? this.pre.read(pd) : (L[i] + R[i]) * 0.5;
      x = this.lc[0].hp(x) * 0.03;
      let ol = 0, or = 0;
      for (let k = 0; k < 8; k++) {
        const cl = this.combL[k];
        const yl = cl.buf[cl.i];
        cl.f = yl * (1 - damp) + cl.f * damp;
        cl.buf[cl.i] = x + cl.f * room;
        cl.i = (cl.i + 1) % cl.buf.length;
        ol += yl;
        const cr = this.combR[k];
        const yr = cr.buf[cr.i];
        cr.f = yr * (1 - damp) + cr.f * damp;
        cr.buf[cr.i] = x + cr.f * room;
        cr.i = (cr.i + 1) % cr.buf.length;
        or += yr;
      }
      for (let k = 0; k < 4; k++) {
        const al = this.apL[k];
        const bl = al.buf[al.i];
        al.buf[al.i] = ol + bl * 0.5;
        al.i = (al.i + 1) % al.buf.length;
        ol = bl - ol;
        const ar = this.apR[k];
        const br = ar.buf[ar.i];
        ar.buf[ar.i] = or + br * 0.5;
        ar.i = (ar.i + 1) % ar.buf.length;
        or = br - or;
      }
      L[i] = ol * w1 + or * w2;
      R[i] = or * w1 + ol * w2;
    }
  }
}

class Chorus extends Fx {
  private dl = new DelayLine(this.sr * 0.1);
  private dr = new DelayLine(this.sr * 0.1);
  private ph = 0;
  process(L: Float32Array, R: Float32Array, n: number) {
    const rate = num(this.p, 'rate', 0.8);
    const depth = num(this.p, 'depth', 0.5);
    const base = (num(this.p, 'delay', 12) / 1000) * this.sr;
    const fb = num(this.p, 'feedback', 0.1);
    for (let i = 0; i < n; i++) {
      this.ph += rate / this.sr;
      if (this.ph >= 1) this.ph -= 1;
      const ml = base * (1 + depth * 0.8 * Math.sin(TAU * this.ph));
      const mr = base * (1 + depth * 0.8 * Math.sin(TAU * (this.ph + 0.25)));
      const yl = this.dl.read(ml);
      const yr = this.dr.read(mr);
      this.dl.write(L[i] + yl * fb);
      this.dr.write(R[i] + yr * fb);
      L[i] = yl;
      R[i] = yr;
    }
  }
}

class Distortion extends Fx {
  private t = [new OnePole(), new OnePole()];
  protected update() {
    if (!this.t) return;
    for (const f of this.t) f.setLowpass(num(this.p, 'tone', 12000), this.sr);
  }
  constructor(sr: number, type: EffectType, params: Params) {
    super(sr, type, params);
    this.update();
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const mode = str(this.p, 'mode', 'soft');
    const drive = dbToGain(num(this.p, 'drive', 6));
    const out = dbToGain(num(this.p, 'output', -3));
    const shape = (x: number) => {
      x *= drive;
      switch (mode) {
        case 'hard':
          return clamp(x, -1, 1);
        case 'tube':
          return x >= 0 ? 1 - Math.exp(-x) : -1 + Math.exp(x * 1.2) ;
        case 'fold':
          return Math.sin(x);
        default:
          return Math.tanh(x);
      }
    };
    for (let i = 0; i < n; i++) {
      L[i] = this.t[0].lp(shape(L[i])) * out;
      R[i] = this.t[1].lp(shape(R[i])) * out;
    }
  }
}

class Bitcrusher extends Fx {
  private hold = [0, 0];
  private c = 0;
  process(L: Float32Array, R: Float32Array, n: number) {
    const steps = Math.pow(2, Math.round(num(this.p, 'bits', 8)) - 1);
    const ds = Math.max(1, Math.round(num(this.p, 'downsample', 4)));
    for (let i = 0; i < n; i++) {
      if (this.c++ % ds === 0) {
        this.hold[0] = Math.round(L[i] * steps) / steps;
        this.hold[1] = Math.round(R[i] * steps) / steps;
      }
      L[i] = this.hold[0];
      R[i] = this.hold[1];
    }
  }
}

class Stereo extends Fx {
  private lp = new OnePole();
  protected update() {
    if (!this.lp) return;
    this.lp.setLowpass(num(this.p, 'monoBelow', 10), this.sr);
  }
  constructor(sr: number, type: EffectType, params: Params) {
    super(sr, type, params);
    this.update();
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const width = num(this.p, 'width', 1);
    const g = dbToGain(num(this.p, 'gain'));
    const mono = num(this.p, 'monoBelow', 10) > 12;
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5;
      let s = (L[i] - R[i]) * 0.5;
      if (mono) s -= this.lp.lp(s);
      s *= width;
      L[i] = (m + s) * g;
      R[i] = (m - s) * g;
    }
  }
}

class Limiter extends Fx {
  private la = Math.round(this.sr * 0.003);
  private bl = new DelayLine(this.la + 8);
  private br = new DelayLine(this.la + 8);
  private env = 1;
  private peakHold = new Float32Array(this.la + 1);
  private ph = 0;
  process(L: Float32Array, R: Float32Array, n: number) {
    const g = dbToGain(num(this.p, 'gain'));
    const ceil = dbToGain(num(this.p, 'ceiling', -0.3));
    const rel = Math.exp(-1 / (num(this.p, 'release', 80) * 0.001 * this.sr));
    const att = Math.exp(-1 / (this.la * 0.5));
    let maxGr = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i] * g, r = R[i] * g;
      this.bl.write(l);
      this.br.write(r);
      const pk = Math.max(Math.abs(l), Math.abs(r));
      this.peakHold[this.ph] = pk;
      this.ph = (this.ph + 1) % this.peakHold.length;
      let m = 0;
      for (let k = 0; k < this.peakHold.length; k += 4) if (this.peakHold[k] > m) m = this.peakHold[k];
      m = Math.max(m, pk);
      const target = m > ceil ? ceil / m : 1;
      this.env = target < this.env ? target + (this.env - target) * att : target + (this.env - target) * rel;
      const gr = -20 * Math.log10(this.env);
      if (gr > maxGr) maxGr = gr;
      L[i] = clamp(this.bl.read(this.la) * this.env, -ceil, ceil);
      R[i] = clamp(this.br.read(this.la) * this.env, -ceil, ceil);
    }
    this.gr = maxGr;
  }
}

export function createEffect(sr: number, type: EffectType, params: Params): Fx {
  const fx = makeEffect(sr, type, params);
  fx.setParams(params); // update() só depois que os campos da subclasse existem
  return fx;
}

function makeEffect(sr: number, type: EffectType, params: Params): Fx {
  switch (type) {
    case 'eq': return new Eq(sr, type, params);
    case 'filter': return new FilterFx(sr, type, params);
    case 'compressor': return new Compressor(sr, type, params);
    case 'delay': return new Delay(sr, type, params);
    case 'reverb': return new Reverb(sr, type, params);
    case 'chorus': return new Chorus(sr, type, params);
    case 'distortion': return new Distortion(sr, type, params);
    case 'bitcrusher': return new Bitcrusher(sr, type, params);
    case 'stereo': return new Stereo(sr, type, params);
    case 'limiter': return new Limiter(sr, type, params);
  }
}
