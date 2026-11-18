// Engine de áudio do Music Labs: sequenciador (pattern/song), rack de canais,
// mixer com inserts, efeitos, roteamento e sidechain. Roda igual no
// AudioWorklet do navegador e no Node (render offline e análise via MCP).

import type { Channel, Insert, Project } from './model.js';
import { PPQ, STEP, patternLength, songLength } from './model.js';
import { Instrument, SampleBank, SampleData, SampleSet, createInstrument } from './instruments.js';
import { Fx, FxContext, createEffect } from './effects.js';
import { PitchShifter, panGains } from './dsp.js';
import { ANALYZER_SIZE, analyzeSpectrum } from './analyzer.js';

export const BLOCK = 128;

interface ChannelState {
  inst: Instrument;
  sig: string; // type + params serializados
  L: Float32Array;
  R: Float32Array;
  fx: Map<string, { fx: Fx; sig: string }>;
  shifter: PitchShifter | null;
  quiet: number; // amostras seguidas em silêncio (para parar de processar a cauda dos efeitos)
}

interface InsertState {
  fx: Map<string, { fx: Fx; sig: string }>;
  L: Float32Array;
  R: Float32Array;
  peakL: number;
  peakR: number;
  sumSq: number;
  peakAll: number;
}

interface Ev {
  ch: string;
  frame: number;
  key: number;
  played: number; // tecla tocada (antes da transposição), para o teclado da tela
  vel: number;
  gateTicks: number;
  pan: number;
  slide?: boolean;
}

export interface EngineStatus {
  playing: boolean;
  mode: 'pattern' | 'song';
  patternId: string | null;
  tick: number;
  meters: [number, number][];
  gr: number[];
  activeChannels: string[];
  /** Teclas soando agora no canal observado (watch), como foram tocadas. */
  lit: number[];
  /** Espectro (dB por faixa) do som do canal observado; null se em silêncio. */
  spectrum: number[] | null;
}

export interface InsertStats {
  index: number;
  name: string;
  peakDb: number;
  rmsDb: number;
}

export class Engine {
  project: Project | null = null;
  playing = false;
  mode: 'pattern' | 'song' = 'pattern';
  patternId: string | null = null;
  tick = 0;
  private channels = new Map<string, ChannelState>();
  private inserts: InsertState[] = [];
  private samples = new Map<string, SampleData>();
  private sets = new Map<string, SampleSet>();
  private bank: SampleBank = { get: (p) => this.samples.get(p), set: (p) => this.sets.get(p) };
  private order: number[] = [];
  private flashes = new Set<string>();
  private watched: string | null = null;
  private lit = new Map<number, number>(); // tecla -> amostras restantes acesa
  private scope = new Float32Array(ANALYZER_SIZE);
  private scopeW = 0;
  private scopeFresh = false;
  statFrames = 0;

  constructor(public sr: number) {}

  setSample(path: string, data: SampleData) {
    this.samples.set(path, data);
  }
  hasSample(path: string) {
    return this.samples.has(path) || this.sets.has(path);
  }
  setSampleSet(path: string, set: SampleSet) {
    this.sets.set(path, set);
  }

  setProject(p: Project) {
    this.project = p;
    const seen = new Set<string>();
    for (const ch of p.channels) {
      seen.add(ch.id);
      const sig = ch.type + JSON.stringify(ch.params);
      const cur = this.channels.get(ch.id);
      if (!cur || cur.inst.type !== ch.type) {
        this.channels.set(ch.id, {
          inst: createInstrument(this.sr, ch.type, ch.params, this.bank),
          sig,
          L: new Float32Array(BLOCK),
          R: new Float32Array(BLOCK),
          fx: cur?.fx ?? new Map(),
          shifter: null,
          quiet: 0,
        });
      } else if (cur.sig !== sig) {
        cur.inst.setParams(ch.params);
        cur.sig = sig;
      }
      const st = this.channels.get(ch.id)!;
      const keep = new Set<string>();
      for (const e of ch.effects ?? []) {
        keep.add(e.id);
        const esig = e.type + JSON.stringify(e.params);
        const ce = st.fx.get(e.id);
        if (!ce || ce.fx.type !== e.type) st.fx.set(e.id, { fx: createEffect(this.sr, e.type, e.params), sig: esig });
        else if (ce.sig !== esig) {
          ce.fx.setParams(e.params);
          ce.sig = esig;
        }
      }
      for (const id of [...st.fx.keys()]) if (!keep.has(id)) st.fx.delete(id);
    }
    for (const id of [...this.channels.keys()]) if (!seen.has(id)) this.channels.delete(id);

    while (this.inserts.length < p.mixer.length)
      this.inserts.push({ fx: new Map(), L: new Float32Array(BLOCK), R: new Float32Array(BLOCK), peakL: 0, peakR: 0, sumSq: 0, peakAll: 0 });
    this.inserts.length = p.mixer.length;
    p.mixer.forEach((ins, i) => {
      const st = this.inserts[i];
      const keep = new Set<string>();
      for (const e of ins.effects) {
        keep.add(e.id);
        const sig = e.type + JSON.stringify(e.params);
        const cur = st.fx.get(e.id);
        if (!cur || cur.fx.type !== e.type) st.fx.set(e.id, { fx: createEffect(this.sr, e.type, e.params), sig });
        else if (cur.sig !== sig) {
          cur.fx.setParams(e.params);
          cur.sig = sig;
        }
      }
      for (const id of [...st.fx.keys()]) if (!keep.has(id)) st.fx.delete(id);
    });
    this.order = processingOrder(p.mixer);
    if (this.patternId && !p.patterns.some((x) => x.id === this.patternId)) this.patternId = p.patterns[0]?.id ?? null;
    if (!this.patternId) this.patternId = p.patterns[0]?.id ?? null;
  }

  play(mode: 'pattern' | 'song', patternId?: string | null, fromTick?: number) {
    this.mode = mode;
    if (patternId) this.patternId = patternId;
    if (fromTick !== undefined) this.tick = fromTick;
    this.playing = true;
  }
  stop(rewind = true) {
    this.playing = false;
    if (rewind) this.tick = this.mode === 'song' && this.project?.loop ? this.project.loop.start : 0;
    for (const c of this.channels.values()) c.inst.allOff();
  }
  panic() {
    for (const c of this.channels.values()) c.inst.hardStop();
  }

  /** Nota ao vivo (teclado, clique no piano roll). gate = null segura até liveOff. */
  liveOn(channelId: string, key: number, vel = 0.8, gateTicks: number | null = null) {
    const c = this.channels.get(channelId);
    const ch = this.project?.channels.find((x) => x.id === channelId);
    if (!c || !ch) return;
    this.choke(ch, c);
    const gate = gateTicks === null ? 1e12 : this.ticksToFrames(gateTicks);
    c.inst.noteOn({ key: key + ch.pitch, vel, gate, pan: 0, detune: detuneFor(ch) });
    c.quiet = 0;
    this.flashes.add(channelId);
    if (channelId === this.watched) this.lit.set(key, gateTicks === null ? Infinity : gate);
  }

  /** Canal cujas teclas acesas vão no status (o que está aberto na tela). */
  watch(channelId: string | null) {
    this.watched = channelId;
    this.lit.clear();
  }
  liveOff(channelId: string, key: number) {
    const c = this.channels.get(channelId);
    const ch = this.project?.channels.find((x) => x.id === channelId);
    if (!c || !ch) return;
    for (const v of (c.inst as any).voices) if (v.key === key + ch.pitch && v.gate > 1e9) {
      v.gate = 0;
      v.release();
    }
    if (channelId === this.watched) this.lit.delete(key);
  }

  private ticksToFrames(t: number) {
    const bpm = this.project?.bpm ?? 120;
    return Math.max(1, Math.round((t * 60 * this.sr) / (bpm * PPQ)));
  }

  private choke(ch: Channel, st: ChannelState) {
    const g = st.inst.cutGroup;
    if (!g || !this.project) return;
    for (const other of this.project.channels) {
      const os = this.channels.get(other.id);
      if (os && os.inst.cutGroup === g) os.inst.choke();
    }
  }

  /** Faixa do loop atual em ticks. */
  loopRange(): [number, number] {
    const p = this.project!;
    if (this.mode === 'pattern') {
      const pat = p.patterns.find((x) => x.id === this.patternId);
      return [0, pat ? patternLength(p, pat) : 384];
    }
    if (p.loop && p.loop.end > p.loop.start) return [p.loop.start, p.loop.end];
    const end = songLength(p);
    return [0, end > 0 ? end : 384 * 4];
  }

  /** Eventos com início em [a, b), convertidos para frame relativo ao bloco. */
  private collect(a: number, b: number, frameAt: (tick: number) => number, out: Ev[]) {
    const p = this.project!;
    const swing = p.swing;
    const swingTick = (pos: number) => (swing > 0 && pos % (STEP * 2) === STEP ? pos + swing * STEP * 0.5 : pos);
    const emitPattern = (patId: string, from: number, to: number, base: number, clipEnd: number) => {
      const pat = p.patterns.find((x) => x.id === patId);
      if (!pat) return;
      for (const [chId, notes] of Object.entries(pat.notes)) {
        const ch = p.channels.find((c) => c.id === chId);
        if (!ch || ch.mute) continue;
        for (const n of notes) {
          if (n.mute) continue;
          const t = swingTick(n.pos);
          if (t >= from && t < to) {
            const abs = base + t;
            out.push({ ch: chId, frame: frameAt(abs), key: n.key + ch.pitch, played: n.key, vel: n.vel, gateTicks: Math.min(n.len, clipEnd - abs), pan: n.pan ?? 0, slide: n.slide });
          }
        }
      }
    };
    if (this.mode === 'pattern') {
      if (this.patternId) emitPattern(this.patternId, a, b, 0, Infinity);
      return;
    }
    for (const c of p.clips) {
      if (c.muted) continue;
      if (p.tracks[c.track]?.mute) continue;
      const end = c.pos + c.len;
      if (end <= a || c.pos >= b) continue;
      const pat = p.patterns.find((x) => x.id === c.patternId);
      if (!pat) continue;
      const plen = patternLength(p, pat);
      // O pattern repete dentro do clip quando o clip é mais longo que ele.
      const lo = Math.max(a, c.pos);
      const hi = Math.min(b, end);
      let local = lo - c.pos + c.offset;
      let rep = Math.floor(local / plen);
      while (true) {
        const repStart = c.pos - c.offset + rep * plen; // tick absoluto do início desta repetição
        const from = Math.max(lo, repStart) - repStart;
        const to = Math.min(hi, repStart + plen) - repStart;
        if (to > from) emitPattern(c.patternId, from, to, repStart, end);
        if (repStart + plen >= hi) break;
        rep++;
        local = 0;
      }
    }
  }

  /** Processa um bloco de até BLOCK amostras e escreve em outL/outR. */
  process(outL: Float32Array, outR: Float32Array, n: number, collectStats = false) {
    const p = this.project;
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    if (!p) return;
    const tps = (p.bpm * PPQ) / (60 * this.sr); // ticks por amostra
    const events: Ev[] = [];
    const beatAtStart = this.tick / PPQ;

    if (this.playing) {
      const [ls, le] = this.loopRange();
      if (this.tick >= le || this.tick < ls) this.tick = ls;
      let t0 = this.tick;
      let f0 = 0;
      while (f0 < n) {
        const remain = n - f0;
        const t1 = t0 + remain * tps;
        if (t1 <= le) {
          this.collect(t0, t1, (tk) => f0 + Math.floor((tk - t0) / tps), events);
          t0 = t1;
          f0 = n;
        } else {
          const framesToEnd = Math.max(1, Math.ceil((le - t0) / tps));
          const ft = f0;
          const tt = t0;
          this.collect(t0, le, (tk) => ft + Math.floor((tk - tt) / tps), events);
          f0 += framesToEnd;
          t0 = ls + (t0 + framesToEnd * tps - le);
          if (this.mode === 'song' && !p.loop) {
            // Fim da música: para no fim, como num player.
            this.playing = false;
            this.tick = 0;
            for (const c of this.channels.values()) c.inst.allOff();
            break;
          }
        }
      }
      if (this.playing) this.tick = t0;
    }

    // Instrumentos
    const byCh = new Map<string, Ev[]>();
    for (const e of events) {
      const fr = Math.min(n - 1, Math.max(0, e.frame));
      e.frame = fr;
      let l = byCh.get(e.ch);
      if (!l) byCh.set(e.ch, (l = []));
      l.push(e);
    }
    for (const ins of this.inserts) {
      ins.L.fill(0, 0, n);
      ins.R.fill(0, 0, n);
    }
    const fxCtx: FxContext = {
      sr: this.sr,
      bpm: p.bpm,
      beat: beatAtStart,
      insertBus: (i) => (this.inserts[i] ? [this.inserts[i].L, this.inserts[i].R] : undefined),
    };
    for (const ch of p.channels) {
      const st = this.channels.get(ch.id);
      if (!st) continue;
      const evs = byCh.get(ch.id);
      const fxOn = (ch.effects ?? []).some((e) => e.enabled);
      const fine = ch.fine ?? 0;
      const stretch = ch.type === 'sampler' && (ch.pitchMode ?? 'stretch') === 'stretch' && Math.abs(fine) > 0.5;
      // Sem notas e sem voz soando: só continua se houver cauda de efeito por terminar.
      if (!evs && !st.inst.busy && (!(fxOn || stretch) || st.quiet > this.sr * 4)) continue;
      st.L.fill(0, 0, n);
      st.R.fill(0, 0, n);
      let pos = 0;
      if (evs) {
        evs.sort((x, y) => x.frame - y.frame);
        for (const e of evs) {
          if (e.frame > pos) st.inst.render(st.L, st.R, pos, e.frame);
          pos = e.frame;
          this.choke(ch, st);
          const gate = Math.max(1, Math.round(e.gateTicks / tps));
          st.inst.noteOn({ key: e.key, vel: e.vel, gate, pan: e.pan, slide: e.slide, detune: detuneFor(ch) });
          this.flashes.add(ch.id);
          if (ch.id === this.watched) this.lit.set(e.played, Math.max(this.lit.get(e.played) ?? 0, e.frame + gate));
        }
      }
      st.inst.render(st.L, st.R, pos, n);
      // Ajuste fino do sampler sem mudar o andamento.
      if (stretch) {
        if (!st.shifter) st.shifter = new PitchShifter(this.sr);
        st.shifter.process(st.L, st.R, 0, n, Math.pow(2, fine / 1200));
      } else st.shifter = null;
      // Analisador do canal aberto na tela (som do instrumento, antes dos efeitos).
      if (ch.id === this.watched) {
        const mask = ANALYZER_SIZE - 1;
        for (let i = 0; i < n; i++) {
          this.scope[this.scopeW] = (st.L[i] + st.R[i]) * 0.5;
          this.scopeW = (this.scopeW + 1) & mask;
        }
        this.scopeFresh = true;
      }
      for (const e of ch.effects ?? []) {
        if (!e.enabled) continue;
        const fx = st.fx.get(e.id)?.fx;
        if (!fx) continue;
        if (e.mix >= 0.999) fx.process(st.L, st.R, n, fxCtx);
        else {
          const dl = st.L.slice(0, n), dr = st.R.slice(0, n);
          fx.process(st.L, st.R, n, fxCtx);
          for (let i = 0; i < n; i++) {
            st.L[i] = st.L[i] * e.mix + dl[i] * (1 - e.mix);
            st.R[i] = st.R[i] * e.mix + dr[i] * (1 - e.mix);
          }
        }
      }
      let peak = 0;
      const [gl, gr] = panGains(ch.pan);
      const vol = ch.mute ? 0 : ch.volume;
      const target = this.inserts[ch.insert] ?? this.inserts[0];
      for (let i = 0; i < n; i++) {
        const l = st.L[i], r = st.R[i];
        target.L[i] += l * vol * gl;
        target.R[i] += r * vol * gr;
        const a = Math.abs(l) + Math.abs(r);
        if (a > peak) peak = a;
      }
      st.quiet = evs || st.inst.busy || peak > 1e-5 ? 0 : st.quiet + n;
    }
    // teclas acesas: conta o tempo das notas da sequência
    if (this.lit.size)
      for (const [k, left] of this.lit) {
        if (left === Infinity) continue;
        if (left - n <= 0) this.lit.delete(k);
        else this.lit.set(k, left - n);
      }

    // Mixer
    const anySolo = p.mixer.some((m, i) => i > 0 && m.solo);
    const ctx: FxContext = {
      sr: this.sr,
      bpm: p.bpm,
      beat: beatAtStart,
      insertBus: (i) => (this.inserts[i] ? [this.inserts[i].L, this.inserts[i].R] : undefined),
    };
    for (const idx of this.order) {
      const m = p.mixer[idx];
      const st = this.inserts[idx];
      for (const e of m.effects) {
        if (!e.enabled) continue;
        const fx = st.fx.get(e.id)?.fx;
        if (!fx) continue;
        if (e.mix >= 0.999) fx.process(st.L, st.R, n, ctx);
        else {
          const dl = st.L.slice(0, n), dr = st.R.slice(0, n);
          fx.process(st.L, st.R, n, ctx);
          const w = e.mix, d = 1 - e.mix;
          for (let i = 0; i < n; i++) {
            st.L[i] = st.L[i] * w + dl[i] * d;
            st.R[i] = st.R[i] * w + dr[i] * d;
          }
        }
      }
      if (idx === 0) continue;
      const muted = m.mute || (anySolo && !m.solo);
      const [gl, gr] = panGains(m.pan);
      const vl = muted ? 0 : m.volume * gl;
      const vr = muted ? 0 : m.volume * gr;
      const dest = this.inserts[m.output > 0 && m.output !== idx ? m.output : 0];
      let pl = 0, pr = 0;
      for (let i = 0; i < n; i++) {
        const l = st.L[i] * vl, r = st.R[i] * vr;
        dest.L[i] += l;
        dest.R[i] += r;
        const al = Math.abs(l), ar = Math.abs(r);
        if (al > pl) pl = al;
        if (ar > pr) pr = ar;
        if (collectStats) st.sumSq += (l * l + r * r) * 0.5;
      }
      st.peakL = Math.max(st.peakL, pl);
      st.peakR = Math.max(st.peakR, pr);
      if (collectStats) st.peakAll = Math.max(st.peakAll, pl, pr);
    }
    const master = this.inserts[0];
    const mv = p.mixer[0]?.mute ? 0 : p.mixer[0]?.volume ?? 0.8;
    let pl = 0, pr = 0;
    for (let i = 0; i < n; i++) {
      const l = master.L[i] * mv, r = master.R[i] * mv;
      outL[i] = l;
      outR[i] = r;
      if (Math.abs(l) > pl) pl = Math.abs(l);
      if (Math.abs(r) > pr) pr = Math.abs(r);
      if (collectStats) master.sumSq += (l * l + r * r) * 0.5;
    }
    master.peakL = Math.max(master.peakL, pl);
    master.peakR = Math.max(master.peakR, pr);
    if (collectStats) {
      master.peakAll = Math.max(master.peakAll, pl, pr);
      this.statFrames += n;
    }
  }

  /** Lê e zera medidores (picos desde a última leitura). */
  status(): EngineStatus {
    const meters: [number, number][] = this.inserts.map((s) => {
      const m: [number, number] = [s.peakL, s.peakR];
      s.peakL = s.peakR = 0;
      return m;
    });
    const gr = this.inserts.map((s) => {
      let g = 0;
      for (const f of s.fx.values()) g = Math.max(g, f.fx.gr);
      return g;
    });
    const active = [...this.flashes];
    this.flashes.clear();
    const spectrum = this.watched && this.scopeFresh ? analyzeSpectrum(this.scope, this.scopeW, this.sr) : null;
    this.scopeFresh = false;
    return { playing: this.playing, mode: this.mode, patternId: this.patternId, tick: this.tick, meters, gr, activeChannels: active, lit: [...this.lit.keys()], spectrum };
  }

  insertStats(): InsertStats[] {
    const p = this.project!;
    return this.inserts.map((s, i) => ({
      index: i,
      name: p.mixer[i]?.name ?? `Insert ${i}`,
      peakDb: s.peakAll > 0 ? 20 * Math.log10(s.peakAll) : -Infinity,
      rmsDb: this.statFrames > 0 && s.sumSq > 0 ? 10 * Math.log10(s.sumSq / this.statFrames) : -Infinity,
    }));
  }
}

/** Afinação fina por nota: no sampler em modo "preservar andamento" quem afina é o pitch shifter do canal. */
function detuneFor(ch: Channel): number {
  if (ch.type === 'sampler' && (ch.pitchMode ?? 'stretch') === 'stretch') return 0;
  return (ch.fine ?? 0) / 100;
}

/** Ordem de processamento: fontes de sidechain e inserts roteados antes do destino; master por último. */
export function processingOrder(mixer: Insert[]): number[] {
  const n = mixer.length;
  const deps: Set<number>[] = mixer.map(() => new Set());
  mixer.forEach((m, i) => {
    if (i === 0) return;
    const out = m.output > 0 && m.output < n && m.output !== i ? m.output : 0;
    deps[out].add(i);
    for (const e of m.effects) {
      const sc = Number(e.params.sidechain ?? -1);
      if (e.type === 'compressor' && sc > 0 && sc < n && sc !== i) deps[i].add(sc);
    }
  });
  for (const e of mixer[0]?.effects ?? []) {
    const sc = Number(e.params.sidechain ?? -1);
    if (e.type === 'compressor' && sc > 0 && sc < n) deps[0].add(sc);
  }
  const order: number[] = [];
  const state = new Uint8Array(n); // 0 novo, 1 visitando, 2 feito
  const visit = (i: number) => {
    if (state[i] === 2) return;
    if (state[i] === 1) return; // ciclo: ignora a aresta
    state[i] = 1;
    for (const d of deps[i]) visit(d);
    state[i] = 2;
    order.push(i);
  };
  for (let i = 1; i < n; i++) visit(i);
  visit(0);
  return order; // visit(0) por último garante o master no fim
}
