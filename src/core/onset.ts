// Detecção de "está tocando?" para a gravação inteligente, robusta a chiado e a
// ruído de ambiente. Só serve para decidir onde os takes começam e terminam:
// nada aqui altera o som que se ouve nem o que é gravado.
//
// Como funciona: o sinal é analisado em quadros de 1024 amostras (FFT). Para cada
// faixa de frequência o detector aprende o nível do ruído de fundo (sobe devagar,
// desce rápido). O que conta como "tocando" é a energia que passa acima desse
// ruído, como num denoise espectral, mas usada só para medir. Ruído largo e
// constante (chiado de headset, ventilador, ambiente) vira "silêncio" depois de
// alguns segundos; se o ambiente piora de repente, o detector se adapta mais rápido.

const N = 1024;
const HOP = 512;

export interface DetectorState {
  /** Fim (em amostras) do trecho analisado. */
  end: number;
  /** Há som sustentado acima do ruído (batidas curtas não contam). */
  active: boolean;
  /** Fim do primeiro quadro do trecho ativo atual (para começar o take no ataque). */
  since: number;
  /** Quanto o som está acima do ruído, em dB. */
  snrDb: number;
  /** Nível do ruído de fundo aprendido (dBFS aproximado). */
  noiseDb: number;
  /** Nível do sinal (dBFS aproximado). */
  levelDb: number;
  /** Pico do quadro (dBFS). */
  peakDb: number;
}

export class TakeDetector {
  private buf = new Float32Array(N);
  private fill = 0;
  private pos = 0;
  private win = new Float32Array(N);
  private re = new Float32Array(N);
  private im = new Float32Array(N);
  private noise: Float32Array | null = null;
  private sm = new Float32Array(N / 2);
  private lo: number;
  private hi: number;
  private rise: number;
  private riseFast: number;
  private broad = 0; // quadros seguidos com ruído largo acima do aprendido
  private on = false;
  private run = 0; // quadros seguidos acima do ruído
  private runStart = 0;
  private wsum = 0;
  constructor(
    private sr: number,
    /** Margem acima do ruído para considerar que começou a tocar (dB). */
    public marginDb = 10,
    /** Tempo mínimo de som contínuo para contar como tocando (s): ignora batidas e estalos. */
    public minOnSec = 0.12,
    /** Limiar de volume (dBFS de pico): abaixo disso nunca conta como tocando. */
    public thresholdDb = -90,
  ) {
    for (let i = 0; i < N; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      this.wsum += this.win[i] * this.win[i];
    }
    this.lo = Math.max(1, Math.floor((70 * N) / sr));
    this.hi = Math.min(N / 2 - 1, Math.ceil((6000 * N) / sr));
    const hopSec = HOP / sr;
    this.rise = Math.pow(10, (3 * hopSec) / 10); // +3 dB/s
    this.riseFast = Math.pow(10, (12 * hopSec) / 10); // +12 dB/s quando o ambiente piora
  }

  /** Recebe áudio mono e devolve o estado de cada quadro completo. */
  push(x: Float32Array): DetectorState[] {
    const out: DetectorState[] = [];
    for (let i = 0; i < x.length; i++) {
      this.buf[this.fill++] = x[i];
      this.pos++;
      if (this.fill === N) {
        out.push(this.frame());
        this.buf.copyWithin(0, HOP);
        this.fill = N - HOP;
      }
    }
    return out;
  }

  private frame(): DetectorState {
    const re = this.re, im = this.im;
    for (let i = 0; i < N; i++) {
      re[i] = this.buf[i] * this.win[i];
      im[i] = 0;
    }
    fft(re, im);
    const lo = this.lo, hi = this.hi;
    // espectro suavizado entre faixas vizinhas e no tempo (o espectro de um quadro só oscila muito)
    const sm = this.sm;
    for (let k = lo; k <= hi; k++) {
      const pk = (j: number) => re[j] * re[j] + im[j] * im[j];
      const p = (pk(k - 1) + pk(k) + pk(k + 1)) / 3 + 1e-12;
      sm[k] = this.noise ? sm[k] * 0.6 + p * 0.4 : p;
    }
    if (!this.noise) this.noise = sm.slice();
    const nz = this.noise;
    let excess = 0, nsum = 0, psum = 0, above = 0;
    for (let k = lo; k <= hi; k++) {
      psum += sm[k];
      nsum += nz[k];
      if (sm[k] > 3 * nz[k]) {
        excess += sm[k] - 3 * nz[k];
        above++;
      }
    }
    const bins = hi - lo + 1;
    // ruído largo: quase todas as faixas acima do aprendido por mais de ~2 s = o ambiente mudou
    this.broad = above > bins * 0.6 ? this.broad + 1 : 0;
    const rise = this.broad > (2 * this.sr) / HOP ? this.riseFast : this.rise;
    for (let k = lo; k <= hi; k++) nz[k] = sm[k] < nz[k] ? sm[k] : nz[k] * rise;
    const snrDb = 10 * Math.log10(excess / nsum + 1e-9);
    const toDb = (pw: number) => 10 * Math.log10((2 * pw) / (N * this.wsum) + 1e-12);
    const levelDb = toDb(psum);
    // histerese: abre na margem, fecha 6 dB abaixo dela
    // pico do trecho novo deste quadro, comparado com o limiar de volume do usuário
    let peak = 0;
    for (let i = N - HOP; i < N; i++) peak = Math.max(peak, Math.abs(this.buf[i]));
    const peakDb = 20 * Math.log10(peak + 1e-9);
    const loud = peakDb > this.thresholdDb - (this.on ? 3 : 0);
    if (this.on) this.on = loud && snrDb > this.marginDb - 6 && levelDb > -80;
    else this.on = loud && snrDb > this.marginDb && levelDb > -75;
    if (this.on) {
      if (this.run++ === 0) this.runStart = this.pos;
    } else this.run = 0;
    const sustained = this.run * HOP >= this.minOnSec * this.sr;
    return { end: this.pos, active: sustained, since: this.runStart, snrDb, noiseDb: toDb(nsum), levelDb, peakDb };
  }
}

/** FFT radix-2 no lugar (re, im de tamanho potência de 2). */
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
