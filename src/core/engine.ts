// Engine de áudio do Music Labs: sequenciador (pattern/song), rack de canais,
// mixer com inserts, efeitos, roteamento e sidechain. Roda igual no
// AudioWorklet do navegador e no Node (render offline e análise via MCP).

import type { Channel, Clip, Insert, Project } from './model.js';
import { PPQ, STEP, autoValue, isPatternClip, patternLength, songLength } from './model.js';
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
  fx: Map<string, { fx: Fx; sig: string; autoSig?: string }>;
  shifter: PitchShifter | null;
  autoSig?: string;
  quiet: number; // amostras seguidas em silêncio (para parar de processar a cauda dos efeitos)
}

interface InsertState {
  fx: Map<string, { fx: Fx; sig: string; autoSig?: string }>;
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
  /** Contagem antes de começar: tempos que faltam (0 = tocando de verdade). */
  countIn: number;
  /** Andamento tocando agora (muda com automação de BPM). */
  bpm?: number;
  /** Quantas vezes o loop recomeçou desde o play (a gravação usa para trocar de track). */
  loops: number;
  /** Número do play (ver Engine.play). */
  playId?: number;
  /** Ticks que faltam da contagem (exato; countIn é em tempos, arredondado para cima). */
  countInTicks?: number;
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
        cur.autoSig = undefined;
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
          ce.autoSig = undefined;
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
          cur.autoSig = undefined;
        }
      }
      for (const id of [...st.fx.keys()]) if (!keep.has(id)) st.fx.delete(id);
    });
    this.order = processingOrder(p.mixer);
    if (this.patternId && !p.patterns.some((x) => x.id === this.patternId)) this.patternId = p.patterns[0]?.id ?? null;
    if (!this.patternId) this.patternId = p.patterns[0]?.id ?? null;
  }

  /** Clipes de áudio do canal que tocam em algum trecho do bloco. */
  private audioClipsIn(p: Project, chId: string, segs: { f0: number; f1: number; t0: number }[], tps: number) {
    const out: Clip[] = [];
    for (const c of p.clips) {
      if (c.kind !== 'audio' || c.channel !== chId || c.muted || !c.sample || p.tracks[c.track]?.mute) continue;
      if (segs.some((sg) => sg.t0 < c.pos + c.len && sg.t0 + (sg.f1 - sg.f0) * tps > c.pos)) out.push(c);
    }
    return out;
  }
  /** Soma um clipe de áudio nos buffers (com o ganho do clipe), trecho a trecho do bloco. */
  private mixClip(p: Project, c: Clip, L: Float32Array, R: Float32Array, segs: { f0: number; f1: number; t0: number }[], tps: number) {
    if (c.muted || p.tracks[c.track]?.mute || !c.sample) return;
    const data = this.samples.get(c.sample);
    if (!data) return;
    const ch0 = data.ch[0], ch1 = data.ch[1] ?? ch0;
    const len = ch0.length;
    const g = c.gain ?? 1;
    const secPerTick = 60 / (p.bpm * PPQ);
    for (const sg of segs) {
      for (let f = sg.f0; f < sg.f1; f++) {
        const tk = sg.t0 + (f - sg.f0) * tps;
        if (tk < c.pos || tk >= c.pos + c.len) continue;
        const pos = ((tk - c.pos) * secPerTick + (c.startSec ?? 0)) * data.sr;
        const i = pos | 0;
        if (i < 0 || i >= len - 1) continue;
        const fr = pos - i;
        L[f] += (ch0[i] + (ch0[i + 1] - ch0[i]) * fr) * g;
        R[f] += (ch1[i] + (ch1[i + 1] - ch1[i]) * fr) * g;
      }
    }
  }

  /** Número do play atual: a gravação só acredita no status do play que ela mesma iniciou. */
  playId = 0;
  play(mode: 'pattern' | 'song', patternId?: string | null, fromTick?: number, countInBeats = 0, id?: number) {
    this.playId = id ?? this.playId + 1;
    this.mode = mode;
    if (patternId) this.patternId = patternId;
    if (fromTick !== undefined) this.tick = fromTick;
    this.playing = true;
    this.loops = 0;
    // contagem: só o metrônomo soa durante esses tempos; a música começa depois
    this.preroll = countInBeats * PPQ;
    this.prerollPos = 0;
  }

  // ---- transporte (não fica salvo no projeto)
  /** Área selecionada na playlist (ticks): o play começa nela e o loop fica nela. */
  region: [number, number] | null = null;
  loopOn = false;
  metronome = false;
  /** Gravando sem área selecionada: não volta nem para no fim da música. */
  endless = false;
  loops = 0;
  /** Início da próxima coleta de notas quando ele não é a agulha (volta no fim do bloco). */
  private collectFrom: { from: number; tick: number } | null = null;
  /** Andamento usado no último bloco (com automação de BPM). */
  curBpm = 120;
  /** BPM agora: o clipe de automação de BPM que está tocando, se houver. */
  private bpmAt(p: Project) {
    if (!this.playing || this.mode !== 'song' || this.preroll > 0) return p.bpm;
    for (const c of p.clips) {
      if (c.kind !== 'auto' || c.muted || p.tracks[c.track]?.mute || !c.target || c.target.path.length !== 1 || c.target.path[0] !== 'bpm') continue;
      if (this.tick < c.pos || this.tick >= c.pos + c.len) continue;
      const v = autoValue(c, this.tick - c.pos);
      if (v !== null) return Math.max(20, Math.min(400, v));
    }
    return p.bpm;
  }
  private preroll = 0;
  private prerollPos = 0;
  private click = { left: 0, freq: 0, ph: 0, gain: 0 };
  setTransport(t: { region?: [number, number] | null; loopOn?: boolean; metronome?: boolean; endless?: boolean }) {
    if (t.endless !== undefined) this.endless = t.endless;
    if (t.region !== undefined) this.region = t.region && t.region[1] > t.region[0] ? t.region : null;
    if (t.loopOn !== undefined) this.loopOn = t.loopOn;
    if (t.metronome !== undefined) this.metronome = t.metronome;
  }
  private startClick(accent: boolean) {
    this.click = { left: Math.round(this.sr * 0.035), freq: accent ? 1760 : 1175, ph: 0, gain: accent ? 0.42 : 0.3 };
  }
  /** Soma o clique do metrônomo a partir do frame f. */
  private renderClick(L: Float32Array, R: Float32Array, f0: number, n: number) {
    const c = this.click;
    const total = Math.round(this.sr * 0.035);
    for (let i = f0; i < n && c.left > 0; i++, c.left--) {
      const env = c.left / total;
      const v = Math.sin(c.ph) * c.gain * env * env;
      c.ph += (2 * Math.PI * c.freq) / this.sr;
      L[i] += v;
      R[i] += v;
    }
  }
  stop(rewind = true) {
    this.playing = false;
    if (rewind) this.tick = this.mode === 'song' && this.project?.loop ? this.project.loop.start : 0;
    for (const c of this.channels.values()) c.inst.allOff();
  }
  /** Corta tudo: notas e caudas de efeitos (reverb, delay...), recriando os efeitos zerados. */
  panic() {
    for (const c of this.channels.values()) c.inst.hardStop();
    const p = this.project;
    if (!p) return;
    const fresh = (rec: { fx: Fx; autoSig?: string }, params: Record<string, unknown> | undefined) => {
      rec.fx = createEffect(this.sr, rec.fx.type, (params ?? {}) as any);
      rec.autoSig = undefined;
    };
    for (const [id, st] of this.channels) {
      const ch = p.channels.find((x) => x.id === id);
      for (const [eid, rec] of st.fx) fresh(rec, ch?.effects?.find((e) => e.id === eid)?.params);
    }
    this.inserts.forEach((st, i) => {
      for (const [eid, rec] of st.fx) fresh(rec, p.mixer[i]?.effects.find((e) => e.id === eid)?.params);
    });
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
    // gravando: só o loop com área selecionada volta; o resto segue sem fim (não para no fim da música)
    if (this.endless) return this.loopOn && this.region ? this.region : [0, Number.MAX_SAFE_INTEGER];
    if (this.region) {
      // com loop: a área inteira; sem loop: da área até o fim da música
      if (this.loopOn) return this.region;
      return [0, Math.max(songLength(p), this.region[1])];
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
      if (c.muted || !isPatternClip(c)) continue;
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
    // andamento do bloco: automação de BPM (song) ou o do projeto
    const bpm = this.bpmAt(p);
    this.curBpm = bpm;
    const tps = (bpm * PPQ) / (60 * this.sr); // ticks por amostra
    const events: Ev[] = [];
    const beatAtStart = this.tick / PPQ;
    // trechos contínuos de tempo neste bloco (o loop pode quebrar o bloco em dois)
    const segs: { f0: number; f1: number; t0: number }[] = [];

    // contagem antes de começar: só o metrônomo, a música espera
    if (this.playing && this.preroll > 0) {
      const ticks = n * tps;
      let from = 0;
      for (let b = Math.ceil(this.prerollPos / PPQ) * PPQ; b < this.prerollPos + ticks && b < this.preroll; b += PPQ) {
        const f = Math.floor((b - this.prerollPos) / tps);
        this.renderClick(outL, outR, from, f);
        from = f;
        this.startClick(b === 0);
      }
      this.renderClick(outL, outR, from, n);
      this.prerollPos += ticks;
      if (this.prerollPos < this.preroll) return;
      this.preroll = 0;
    }

    if (this.playing) {
      const [ls, le] = this.loopRange();
      if (this.tick >= le || this.tick < ls) this.tick = ls;
      let t0 = this.tick;
      let f0 = 0;
      // de onde coletar notas: depois de uma volta, o começo exato do loop (a agulha passa
      // dele por uma fração de tick e a nota que está bem no começo ficava de fora)
      // (só vale se a agulha não foi mexida de fora: play, seek, stop)
      let c0 = this.collectFrom && this.collectFrom.tick === t0 && this.collectFrom.from >= ls ? this.collectFrom.from : t0;
      this.collectFrom = null;
      while (f0 < n) {
        const remain = n - f0;
        const t1 = t0 + remain * tps;
        if (t1 <= le) {
          const ff = f0, tt = t0;
          this.collect(c0, t1, (tk) => ff + Math.max(0, Math.floor((tk - tt) / tps)), events);
          segs.push({ f0, f1: n, t0 });
          t0 = t1;
          c0 = t1;
          f0 = n;
        } else {
          const framesToEnd = Math.max(1, Math.ceil((le - t0) / tps));
          const ft = f0;
          const tt = t0;
          this.collect(c0, le, (tk) => ft + Math.max(0, Math.floor((tk - tt) / tps)), events);
          segs.push({ f0: ft, f1: Math.min(n, ft + framesToEnd), t0: tt });
          f0 += framesToEnd;
          t0 = ls + (t0 + framesToEnd * tps - le);
          c0 = ls;
          this.loops++;
          if (this.mode === 'song' && !p.loop && !this.loopOn) {
            // Fim da música: para no fim, como num player.
            this.playing = false;
            this.tick = 0;
            for (const c of this.channels.values()) c.inst.allOff();
            break;
          }
        }
      }
      if (this.playing) {
        this.tick = t0;
        // a volta caiu no fim do bloco: o próximo coleta desde o começo do loop
        if (c0 < t0) this.collectFrom = { from: c0, tick: t0 };
      }
    }

    // Automação (song mode): valores do bloco, por caminho do parâmetro
    const auto = new Map<string, number>();
    if (this.playing && this.mode === 'song' && segs.length) {
      const t = segs[0].t0;
      for (const c of p.clips) {
        if (c.kind !== 'auto' || c.muted || p.tracks[c.track]?.mute || t < c.pos || t >= c.pos + c.len || !c.target) continue;
        const v = autoValue(c, t - c.pos);
        if (v !== null) auto.set(c.target.path.join('/'), v);
      }
    }
    this.auto = auto;

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
      bpm,
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
      this.applyChannelAuto(ch, st);
      // canal de áudio: o som são os clipes dele na playlist que caem neste bloco
      const clipsIn = ch.type === 'audio' && this.playing && this.mode === 'song' ? this.audioClipsIn(p, ch.id, segs, tps) : null;
      if (!evs && !clipsIn?.length && !st.inst.busy && (!(fxOn || stretch) || st.quiet > this.sr * 4)) continue;
      st.L.fill(0, 0, n);
      st.R.fill(0, 0, n);
      if (clipsIn) for (const c of clipsIn) this.mixClip(p, c, st.L, st.R, segs, tps);
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
        const rec = st.fx.get(e.id);
        if (!rec) continue;
        this.applyFxAuto(['channels', ch.id, 'effects', e.id, 'params'], e.params, rec);
        const fx = rec.fx;
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
      const [gl, gr] = panGains(this.av(['channels', ch.id, 'pan'], ch.pan));
      const vol = ch.mute ? 0 : this.av(['channels', ch.id, 'volume'], ch.volume);
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

    // Clipes de áudio sem canal (projetos antigos, antes da migração): direto no insert
    if (this.playing && this.mode === 'song')
      for (const c of p.clips) {
        if (c.kind !== 'audio' || (c.channel && p.channels.some((x) => x.id === c.channel))) continue;
        const bus = this.inserts[c.insert ?? 0] ?? this.inserts[0];
        this.mixClip(p, c, bus.L, bus.R, segs, tps);
      }

    // Mixer
    const anySolo = p.mixer.some((m, i) => i > 0 && m.solo);
    const ctx: FxContext = {
      sr: this.sr,
      bpm,
      beat: beatAtStart,
      insertBus: (i) => (this.inserts[i] ? [this.inserts[i].L, this.inserts[i].R] : undefined),
    };
    for (const idx of this.order) {
      const m = p.mixer[idx];
      const st = this.inserts[idx];
      for (const e of m.effects) {
        if (!e.enabled) continue;
        const rec = st.fx.get(e.id);
        if (!rec) continue;
        this.applyFxAuto(['mixer', idx, 'effects', e.id, 'params'], e.params, rec);
        const fx = rec.fx;
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
      const [gl, gr] = panGains(this.av(['mixer', idx, 'pan'], m.pan));
      const mvol = this.av(['mixer', idx, 'volume'], m.volume);
      const vl = muted ? 0 : mvol * gl;
      const vr = muted ? 0 : mvol * gr;
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
    const mv = p.mixer[0]?.mute ? 0 : this.av(['mixer', 0, 'volume'], p.mixer[0]?.volume ?? 0.8);
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
    // metrônomo: um clique a cada tempo (mais agudo no começo do compasso); fica fora dos medidores
    if (this.metronome && this.playing && !collectStats) {
      const bar = PPQ * (p.timeSig?.[0] ?? 4);
      let from = 0;
      for (const sg of segs) {
        const t1 = sg.t0 + (sg.f1 - sg.f0) * tps;
        for (let b = Math.ceil(sg.t0 / PPQ) * PPQ; b < t1; b += PPQ) {
          const f = sg.f0 + Math.floor((b - sg.t0) / tps);
          this.renderClick(outL, outR, from, f);
          from = f;
          this.startClick(b % bar === 0);
        }
      }
      this.renderClick(outL, outR, from, n);
    }
  }

  private auto = new Map<string, number>();

  /** Valor automatizado (se houver) ou o salvo no projeto. */
  private av(path: (string | number)[], base: number): number {
    if (!this.auto.size) return base;
    return this.auto.get(path.join('/')) ?? base;
  }

  /** Sobrepõe a automação nos parâmetros de um conjunto (instrumento ou efeito). */
  private overrides(prefix: (string | number)[]): Record<string, number> {
    const out: Record<string, number> = {};
    if (!this.auto.size) return out;
    const pre = prefix.join('/') + '/';
    for (const [k, v] of this.auto) if (k.startsWith(pre) && !k.slice(pre.length).includes('/')) out[k.slice(pre.length)] = v;
    return out;
  }

  private applyChannelAuto(ch: Channel, st: ChannelState) {
    const ov = this.overrides(['channels', ch.id, 'params']);
    const sig = JSON.stringify(ov);
    if (sig === (st.autoSig ?? '{}')) return;
    st.inst.setParams({ ...ch.params, ...ov });
    st.autoSig = sig;
  }

  private applyFxAuto(prefix: (string | number)[], params: Record<string, unknown>, rec: { fx: Fx; autoSig?: string }) {
    const ov = this.overrides(prefix);
    const sig = JSON.stringify(ov);
    if (sig === (rec.autoSig ?? '{}')) return;
    rec.fx.setParams({ ...(params as any), ...ov });
    rec.autoSig = sig;
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
    const countIn = this.playing && this.preroll > 0 ? Math.ceil((this.preroll - this.prerollPos) / PPQ) : 0;
    return { playing: this.playing, mode: this.mode, patternId: this.patternId, tick: this.tick, meters, gr, activeChannels: active, lit: [...this.lit.keys()], spectrum, bpm: this.curBpm, countIn, countInTicks: this.playing && this.preroll > 0 ? this.preroll - this.prerollPos : 0, loops: this.loops, playId: this.playId };
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
