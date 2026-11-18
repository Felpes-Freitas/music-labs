// Blocos de DSP básicos, sem dependências, usados por instrumentos e efeitos.

export const TAU = Math.PI * 2;
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g <= 1e-9 ? -180 : 20 * Math.log10(g));
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Correção PolyBLEP para osciladores com descontinuidade (anti-aliasing). */
function polyblep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

export type Wave = 'saw' | 'square' | 'sine' | 'triangle' | 'noise';

export class Osc {
  phase = Math.random();
  private tri = 0;
  next(wave: Wave, dt: number): number {
    const t = this.phase;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    switch (wave) {
      case 'sine':
        return Math.sin(TAU * t);
      case 'saw':
        return 2 * t - 1 - polyblep(t, dt);
      case 'square': {
        let v = t < 0.5 ? 1 : -1;
        v += polyblep(t, dt);
        v -= polyblep((t + 0.5) % 1, dt);
        return v;
      }
      case 'triangle': {
        // Integra uma quadrada band-limited (leaky) para obter triângulo limpo.
        let sq = t < 0.5 ? 1 : -1;
        sq += polyblep(t, dt);
        sq -= polyblep((t + 0.5) % 1, dt);
        this.tri = dt * 4 * sq + (1 - dt * 0.5) * this.tri;
        return this.tri;
      }
      case 'noise':
        return Math.random() * 2 - 1;
    }
  }
}

/** Envelope ADSR linear-exponencial. Tempos em segundos. */
export class Adsr {
  stage: 0 | 1 | 2 | 3 | 4 = 0; // 0 parado, 1 ataque, 2 decay, 3 sustain, 4 release
  value = 0;
  private relCoef = 0;
  constructor(private sr: number) {}
  a = 0.005;
  d = 0.3;
  s = 0.8;
  r = 0.2;
  trigger(retrigFromZero = false) {
    if (retrigFromZero) this.value = 0;
    this.stage = 1;
  }
  release() {
    if (this.stage === 0 || this.stage === 4) return;
    this.stage = 4;
    this.relCoef = Math.exp(-1 / (Math.max(0.001, this.r) * this.sr * 0.25));
  }
  get active() {
    return this.stage !== 0;
  }
  next(): number {
    switch (this.stage) {
      case 1:
        this.value += 1 / (Math.max(0.0005, this.a) * this.sr);
        if (this.value >= 1) {
          this.value = 1;
          this.stage = 2;
        }
        break;
      case 2: {
        const c = Math.exp(-1 / (Math.max(0.001, this.d) * this.sr * 0.25));
        this.value = this.s + (this.value - this.s) * c;
        if (this.value - this.s < 1e-4) {
          this.value = this.s;
          this.stage = 3;
        }
        break;
      }
      case 3:
        this.value = this.s;
        break;
      case 4:
        this.value *= this.relCoef;
        if (this.value < 1e-4) {
          this.value = 0;
          this.stage = 0;
        }
        break;
    }
    return this.value;
  }
}

/** Filtro de variável de estado (TPT/Zavalishin), estável com modulação rápida. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private k = 1;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  constructor(private sr: number) {}
  set(cutoff: number, res: number) {
    const fc = clamp(cutoff, 10, this.sr * 0.49);
    this.g = Math.tan((Math.PI * fc) / this.sr);
    this.k = 2 - 2 * clamp(res, 0, 0.98);
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  /** mode: 0 LP, 1 HP, 2 BP */
  process(x: number, mode: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (mode === 0) return v2;
    if (mode === 2) return v1;
    return x - this.k * v1 - v2;
  }
  reset() {
    this.ic1 = this.ic2 = 0;
  }
}

/** Biquad RBJ (para EQ). */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private z1 = 0;
  private z2 = 0;
  setup(type: 'lowshelf' | 'highshelf' | 'peak' | 'highpass' | 'lowpass', f: number, sr: number, q = 0.707, gainDb = 0) {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * clamp(f, 5, sr * 0.49)) / sr;
    const cs = Math.cos(w);
    const sn = Math.sin(w);
    const alpha = sn / (2 * q);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (type) {
      case 'peak':
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cs + s); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - s);
        a0 = A + 1 + (A - 1) * cs + s; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cs + s); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - s);
        a0 = A + 1 - (A - 1) * cs + s; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - s;
        break;
      }
      case 'highpass':
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'lowpass':
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Filtro de um polo (suavização / tom). */
export class OnePole {
  private z = 0;
  private a = 0;
  setLowpass(f: number, sr: number) {
    this.a = Math.exp((-TAU * f) / sr);
  }
  lp(x: number) {
    this.z = x * (1 - this.a) + this.z * this.a;
    return this.z;
  }
  hp(x: number) {
    return x - this.lp(x);
  }
}

/** Linha de atraso com leitura fracionária. */
export class DelayLine {
  buf: Float32Array;
  w = 0;
  constructor(size: number) {
    this.buf = new Float32Array(Math.max(4, size | 0));
  }
  write(x: number) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) % this.buf.length;
  }
  read(delaySamples: number): number {
    const len = this.buf.length;
    const d = clamp(delaySamples, 1, len - 2);
    let r = this.w - d;
    while (r < 0) r += len;
    const i = r | 0;
    const f = r - i;
    const a = this.buf[i];
    const b = this.buf[(i + 1) % len];
    return a + (b - a) * f;
  }
}

/** Parâmetro com rampa curta para evitar cliques ao mexer em knobs. */
export class Smooth {
  v: number;
  constructor(v: number, private coef = 0.995) {
    this.v = v;
  }
  next(target: number) {
    this.v = target + (this.v - target) * this.coef;
    return this.v;
  }
}

/** Pan de potência constante. */
export function panGains(pan: number): [number, number] {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
}
