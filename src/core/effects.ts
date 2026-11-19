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

/** Phaser clássico: cascata de allpass de 1ª ordem varrida por LFO, com realimentação. */
class Phaser extends Fx {
  private sl = new Float64Array(8);
  private sr2 = new Float64Array(8);
  private fbl = 0;
  private fbr = 0;
  private ph = 0;
  process(L: Float32Array, R: Float32Array, n: number) {
    const rate = num(this.p, 'rate', 0.4);
    const depth = num(this.p, 'depth', 0.8);
    const fb = num(this.p, 'feedback', 0.5);
    const center = num(this.p, 'center', 900);
    const stages = Number(str(this.p, 'stages', '6')) || 6;
    const span = 2.5 * depth; // oitavas para cada lado
    let al = 0, ar = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        this.ph += (rate * 16) / this.sr;
        if (this.ph >= 1) this.ph -= 1;
        const fl = center * Math.pow(2, span * Math.sin(TAU * this.ph));
        const fr = center * Math.pow(2, span * Math.sin(TAU * (this.ph + 0.25)));
        const tl = Math.tan((Math.PI * clamp(fl, 30, this.sr * 0.45)) / this.sr);
        const tr = Math.tan((Math.PI * clamp(fr, 30, this.sr * 0.45)) / this.sr);
        al = (tl - 1) / (tl + 1);
        ar = (tr - 1) / (tr + 1);
      }
      let xl = L[i] + this.fbl * fb;
      let xr = R[i] + this.fbr * fb;
      for (let k = 0; k < stages; k++) {
        const yl = al * xl + this.sl[k];
        this.sl[k] = xl - al * yl;
        xl = yl;
        const yr = ar * xr + this.sr2[k];
        this.sr2[k] = xr - ar * yr;
        xr = yr;
      }
      this.fbl = xl;
      this.fbr = xr;
      // soma com o seco: é isso que cria os vales do phaser
      L[i] = (L[i] + xl) * 0.5;
      R[i] = (R[i] + xr) * 0.5;
    }
  }
}

// ---------------------------------------------------------------- guitarra

/** Pares de filtros iguais para L e R. */
const pair = () => [new Biquad(), new Biquad()];

class Gate extends Fx {
  private env = 0;
  private g = 0;
  process(L: Float32Array, R: Float32Array, n: number) {
    const open = dbToGain(num(this.p, 'threshold', -55));
    const close = open * 0.5; // histerese: fecha um pouco abaixo de onde abre
    const att = Math.exp(-1 / (0.001 * this.sr));
    const rel = Math.exp(-1 / (num(this.p, 'release', 80) * 0.001 * this.sr));
    const envRel = Math.exp(-1 / (0.02 * this.sr));
    for (let i = 0; i < n; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = x > this.env ? x : this.env * envRel;
      const target = this.env > open ? 1 : this.env < close ? 0 : this.g > 0.5 ? 1 : 0;
      this.g = target > this.g ? target + (this.g - target) * att : target + (this.g - target) * rel;
      L[i] *= this.g;
      R[i] *= this.g;
    }
  }
}

class Overdrive extends Fx {
  private hp = pair();
  private lp = pair();
  private dc = [new OnePole(), new OnePole()];
  protected update() {
    if (!this.hp) return;
    const tone = num(this.p, 'tone', 0.5);
    for (const f of this.hp) f.setup('highpass', 720, this.sr, 0.6);
    for (const f of this.lp) f.setup('lowpass', 900 * Math.pow(7, tone), this.sr, 0.6);
    for (const f of this.dc) f.setLowpass(10, this.sr);
  }
  constructor(sr: number, type: EffectType, params: Params) {
    super(sr, type, params);
    this.update();
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const drive = num(this.p, 'drive', 0.45);
    const g = 1 + drive * drive * 60;
    const out = dbToGain(num(this.p, 'level', 0)) * (0.9 / Math.tanh(1 + drive * 2));
    const bufs = [L, R];
    for (let c = 0; c < 2; c++) {
      const b = bufs[c], hp = this.hp[c], lp = this.lp[c], dc = this.dc[c];
      for (let i = 0; i < n; i++) {
        const x = b[i];
        // os graves passam limpos e só os médios/agudos saturam (o "mid hump")
        const v = x * 0.5 + hp.process(x) * g;
        let y = Math.tanh(v + 0.08) - 0.0798; // leve assimetria: harmônicos pares
        y = lp.process(y);
        b[i] = (y - dc.lp(y)) * out;
      }
    }
  }
}

class Fuzz extends Fx {
  private lp = pair();
  private hp = pair();
  private dc = [new OnePole(), new OnePole()];
  protected update() {
    if (!this.lp) return;
    const tone = num(this.p, 'tone', 0.5);
    for (const f of this.lp) f.setup('lowpass', 1200 * Math.pow(6, tone), this.sr, 0.7);
    for (const f of this.hp) f.setup('highpass', 60 + 200 * tone, this.sr, 0.7);
    for (const f of this.dc) f.setLowpass(12, this.sr);
  }
  constructor(sr: number, type: EffectType, params: Params) {
    super(sr, type, params);
    this.update();
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const amt = num(this.p, 'fuzz', 0.7);
    const g = 10 + amt * amt * 400;
    const out = dbToGain(num(this.p, 'level', -6));
    const bufs = [L, R];
    for (let c = 0; c < 2; c++) {
      const b = bufs[c];
      for (let i = 0; i < n; i++) {
        const v = this.hp[c].process(b[i]) * g;
        // clipagem assimétrica: lado positivo duro, negativo mais macio
        let y = v > 0 ? Math.min(1, v) : Math.tanh(v * 0.6);
        y = this.lp[c].process(y);
        b[i] = (y - this.dc[c].lp(y)) * out * 0.7;
      }
    }
  }
}

class Amp extends Fx {
  private inHp = pair();
  private inter = pair(); // entre os estágios do pré
  private bass = pair();
  private mid = pair();
  private treble = pair();
  private pres = pair();
  private dc = [new OnePole(), new OnePole()];
  protected update() {
    if (!this.inHp) return;
    const p = this.p, sr = this.sr;
    const db = (k: string, range: number) => (num(p, k, 0.5) - 0.5) * 2 * range;
    for (const f of this.inHp) f.setup('highpass', 90, sr, 0.7);
    for (const f of this.inter) f.setup('lowpass', str(p, 'channel') === 'clean' ? 9000 : 6500, sr, 0.7);
    for (const f of this.bass) f.setup('lowshelf', 120, sr, 0.7, db('bass', 12));
    for (const f of this.mid) f.setup('peak', 650, sr, 0.8, db('mid', 12));
    for (const f of this.treble) f.setup('highshelf', 2800, sr, 0.7, db('treble', 12));
    for (const f of this.pres) f.setup('peak', 4500, sr, 0.9, db('presence', 9));
    for (const f of this.dc) f.setLowpass(8, sr);
  }
  constructor(sr: number, type: EffectType, params: Params) {
    super(sr, type, params);
    this.update();
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const ch = str(this.p, 'channel', 'crunch');
    const gain = num(this.p, 'gain', 0.5);
    const range = ch === 'clean' ? [1, 5] : ch === 'crunch' ? [4, 45] : [20, 220];
    const pre = range[0] * Math.pow(range[1] / range[0], gain);
    const two = ch === 'lead'; // canal lead tem um estágio a mais
    const master = dbToGain(num(this.p, 'master', -8));
    const norm = 1 / Math.tanh(Math.min(pre, 3));
    const bufs = [L, R];
    for (let c = 0; c < 2; c++) {
      const b = bufs[c];
      for (let i = 0; i < n; i++) {
        let x = this.inHp[c].process(b[i]) * pre;
        x = Math.tanh(x + 0.1) - 0.0997; // válvula de pré (assimetria leve)
        if (two) x = Math.tanh(this.inter[c].process(x) * 3.2);
        else x = this.inter[c].process(x);
        x = this.treble[c].process(this.mid[c].process(this.bass[c].process(x * norm)));
        // power amp: satura suave quando o master está alto
        x = Math.tanh(x * master * 2.2) * 0.62;
        x = this.pres[c].process(x);
        b[i] = x - this.dc[c].lp(x);
      }
    }
  }
}

const CABS: Record<string, { hp: number; res: [number, number]; mid: [number, number, number]; lp: number; lp2: number }> = {
  '1x12 combo': { hp: 90, res: [130, 3], mid: [1800, 1.2, 3], lp: 5200, lp2: 6500 },
  '2x12 aberta': { hp: 80, res: [110, 2], mid: [2400, 1.0, 2.5], lp: 5800, lp2: 7500 },
  '4x12 britânica': { hp: 75, res: [95, 4], mid: [1500, 0.9, 4], lp: 4300, lp2: 5600 },
  '4x12 moderna': { hp: 70, res: [85, 5], mid: [700, 1.1, -3], lp: 4800, lp2: 6200 },
};

class Cab extends Fx {
  private f: Biquad[][] = [];
  protected update() {
    const c = CABS[str(this.p, 'cab', '2x12 aberta')] ?? CABS['2x12 aberta'];
    const mic = num(this.p, 'mic', 0.4); // 0 = centro (brilhante), 1 = borda (escuro)
    const low = num(this.p, 'low', 0.5);
    if (!this.f.length) this.f = [0, 1].map(() => [new Biquad(), new Biquad(), new Biquad(), new Biquad(), new Biquad(), new Biquad()]);
    for (const b of this.f) {
      b[0].setup('highpass', c.hp, this.sr, 0.8);
      b[1].setup('peak', c.res[0], this.sr, 1.4, c.res[1] * (0.4 + low * 1.2));
      b[2].setup('peak', c.mid[0], this.sr, c.mid[1], c.mid[2] + (0.5 - mic) * 4);
      b[3].setup('lowpass', c.lp * Math.pow(0.55, mic), this.sr, 0.9);
      b[4].setup('lowpass', c.lp2 * Math.pow(0.6, mic), this.sr, 0.6);
      b[5].setup('peak', 3200, this.sr, 2, -2 - mic * 3); // vale típico de alto-falante
    }
  }
  process(L: Float32Array, R: Float32Array, n: number) {
    const out = dbToGain(num(this.p, 'level', 0)) * 1.4;
    const bufs = [L, R];
    for (let c = 0; c < 2; c++) {
      const b = bufs[c], f = this.f[c];
      for (let i = 0; i < n; i++) {
        let x = b[i];
        for (let k = 0; k < 6; k++) x = f[k].process(x);
        b[i] = x * out;
      }
    }
  }
}

class Wah extends Fx {
  private f = [new Svf(this.sr), new Svf(this.sr)];
  private env = 0;
  private ph = 0;
  private pos = 0.5;
  process(L: Float32Array, R: Float32Array, n: number) {
    const mode = str(this.p, 'mode', 'auto');
    const sens = num(this.p, 'sens', 0.6);
    const rate = num(this.p, 'rate', 1.5);
    const q = 0.55 + num(this.p, 'q', 0.75) * 0.4;
    const rel = Math.exp(-1 / (0.12 * this.sr)), att = Math.exp(-1 / (0.004 * this.sr));
    for (let i = 0; i < n; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = x + (this.env - x) * (x > this.env ? att : rel);
      if ((i & 15) === 0) {
        let target: number;
        if (mode === 'pedal') target = num(this.p, 'pedal', 0.5);
        else if (mode === 'lfo') {
          this.ph = (this.ph + (16 * rate) / this.sr) % 1;
          target = 0.5 - 0.5 * Math.cos(TAU * this.ph);
        } else target = clamp(this.env * (2 + sens * 30), 0, 1);
        this.pos += (target - this.pos) * 0.3;
        const fc = 350 * Math.pow(2400 / 350, this.pos);
        this.f[0].set(fc, q);
        this.f[1].set(fc, q);
      }
      L[i] = this.f[0].process(L[i], 2) * 1.8;
      R[i] = this.f[1].process(R[i], 2) * 1.8;
    }
  }
}

class Tremolo extends Fx {
  private ph = 0;
  process(L: Float32Array, R: Float32Array, n: number) {
    const rate = num(this.p, 'rate', 5), depth = num(this.p, 'depth', 0.6);
    const wave = str(this.p, 'wave', 'sine');
    const inc = rate / this.sr;
    for (let i = 0; i < n; i++) {
      this.ph = (this.ph + inc) % 1;
      const w = wave === 'square' ? (this.ph < 0.5 ? 1 : 0) : wave === 'triangle' ? 1 - Math.abs(this.ph * 2 - 1) : 0.5 + 0.5 * Math.sin(TAU * this.ph);
      const g = 1 - depth * (1 - w);
      L[i] *= g;
      R[i] *= g;
    }
  }
}

export function createEffect(sr: number, type: EffectType, params: Params): Fx {
  const fx = makeEffect(sr, type, params);
  fx.setParams(params); // update() só depois que os campos da subclasse existem
  return fx;
}

function makeEffect(sr: number, type: EffectType, params: Params): Fx {
  switch (type) {
    case 'phaser': return new Phaser(sr, type, params);
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
    case 'gate': return new Gate(sr, type, params);
    case 'overdrive': return new Overdrive(sr, type, params);
    case 'fuzz': return new Fuzz(sr, type, params);
    case 'amp': return new Amp(sr, type, params);
    case 'cab': return new Cab(sr, type, params);
    case 'wah': return new Wah(sr, type, params);
    case 'tremolo': return new Tremolo(sr, type, params);
  }
}
