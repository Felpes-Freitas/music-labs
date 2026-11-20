// Ponte entre a interface e o AudioWorklet: contexto de áudio, samples e transporte.
import workletUrl from './worklet.ts?worker&url';
import { decodeWav } from '../core/wav';
import { PPQ, type Project } from '../core/model';
import { TakeDetector } from '../core/onset';
import type { Op } from '../core/ops';
import type { EngineStatus } from '../core/engine';

export class Audio {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  status: EngineStatus = { playing: false, mode: 'pattern', patternId: null, tick: 0, meters: [], gr: [], activeChannels: [], lit: [], spectrum: null, countIn: 0, loops: 0 };
  private watching: string | null = null;
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  getProject: () => Project | null = () => null;
  onStatus: (s: EngineStatus) => void = () => {};
  analyser: AnalyserNode | null = null;

  private initP: Promise<void> | null = null;
  /** Prepara o contexto e a engine (pode ficar suspenso até ligar o som). */
  init(): Promise<void> {
    return (this.initP ??= this.doInit());
  }
  /** Liga o som. Devolve false se o navegador exigir um clique antes. */
  async resume(): Promise<boolean> {
    await this.init();
    const ctx = this.ctx!;
    if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    return ctx.state === 'running';
  }
  async start() {
    await this.resume();
  }
  private async doInit() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'batuque', { numberOfInputs: 0, outputChannelCount: [2] });
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    node.connect(this.analyser);
    node.connect(ctx.destination);
    node.port.onmessage = (e) => {
      if (e.data.type === 'status') {
        this.status = e.data.status;
        this.statusAt = performance.now();
        this.markRec();
        this.onStatus(this.status);
      } else if (e.data.type === 'error') console.error('engine:', e.data.error);
      else if (e.data.type === 'resync') {
        const p = this.getProject();
        if (p) this.setProject(p);
      }
    };
    this.ctx = ctx;
    this.node = node;
    const p = this.getProject();
    if (p) this.setProject(p);
    if (this.watching) this.post({ type: 'watch', channel: this.watching });
    this.post({ type: 'transport', ...this.tp });
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  post(m: unknown) {
    // mudanças de projeto que ainda estão juntando vão antes (a ordem das mensagens importa)
    if (this.pendOps?.length && (m as { type?: string }).type !== 'ops') this.flushOps();
    this.node?.port.postMessage(m);
  }

  /** Envia o projeto inteiro (abrir, undo/redo). */
  setProject(p: Project) {
    if (!this.node) return; // ao ligar o áudio, start() envia o projeto atual
    this.post({ type: 'project', project: p });
    this.syncSamples(p);
  }

  /** Envia só as alterações: a thread de áudio aplica as mesmas ops na cópia dela. */
  /**
   * Manda as mudanças para a engine. Mexidas seguidas (arrastar um knob, editar uma
   * automação) chegam a cada movimento do mouse: a primeira vai na hora e as próximas
   * são juntadas por ~20 ms — de um lote de "set" igual ao anterior só vale o último.
   */
  applyOps(ops: Op[], p: Project) {
    if (!this.node) return;
    if (ops.some((o) => o.op === 'replace')) {
      this.pendOps = [];
      return this.setProject(p);
    }
    const last = this.pendOps[this.pendOps.length - 1];
    const sameSets = (a: Op[], b: Op[]) => a.length === b.length && a.every((o, i) => o.op === 'set' && b[i].op === 'set' && o.path.join('/') === b[i].path.join('/'));
    if (last && sameSets(last, ops)) this.pendOps[this.pendOps.length - 1] = ops;
    else this.pendOps.push(ops);
    if (this.pendTimer) return;
    this.flushOps();
    this.pendTimer = setTimeout(() => {
      this.pendTimer = 0;
      if (this.pendOps.length) this.flushOps();
    }, 20) as unknown as number;
  }
  private pendOps: Op[][] = [];
  private pendTimer = 0;
  private flushOps() {
    const ops = this.pendOps.flat();
    this.pendOps = [];
    if (!ops.length) return;
    this.post({ type: 'ops', ops });
    const p = this.getProject();
    if (p) this.syncSamples(p);
  }

  private syncSamples(p: Project) {
    for (const ch of p.channels) if (ch.type === 'sampler' && ch.params.sample) this.loadSample(String(ch.params.sample));
    for (const c of p.clips) if (c.kind === 'audio' && c.sample) this.loadSample(c.sample);
  }

  // ---------------------------------------------------------------- gravação
  //
  // A captura guarda o sinal cru. Cada gravação é dividida em "takes" (segmentos):
  // no modo normal há um take do começo ao fim; no modo inteligente um take abre
  // quando o sinal passa do limiar e fecha depois de uma pausa em silêncio.
  // A posição de cada take na música vem de pares (amostras capturadas, tick)
  // anotados a cada atualização da engine, então funciona até com loop.

  private rec: Rec | null = null;

  /** Gravação em andamento (para a playlist desenhar os takes enquanto grava). */
  get liveRecording() {
    const r = this.rec;
    if (!r || !this.ctx) return null;
    return {
      sr: this.ctx.sampleRate,
      peaks: r.peaks,
      peakFrames: PEAK_FRAMES,
      frames: r.frames,
      smart: !!r.smart,
      noiseDb: r.noiseDb,
      snrDb: r.snrDb,
      peakDb: r.peakDb,
      echoCancel: !!r.smart?.node,
      takes: r.takes.map((t) => ({ tick: t.tick, track: t.track, c0: t.c0, c1: t.c1 ?? r.frames })),
    };
  }

  get recording() {
    return !!this.rec;
  }

  /** Começa a capturar; startTick é a posição da música no início. */
  async startRecording(
    startTick: number,
    track: number,
    opt: { deviceId?: string; channels?: RecChannels; stream?: MediaStream; gainDb?: number; smart?: { marginDb: number; holdSec: number; thresholdDb: number; deviceId?: string }; countInSec?: number; loop?: [number, number] | null; onTakeClosed?: (k: number) => void } = {},
  ) {
    await this.resume();
    const ctx = this.ctx!;
    const own = !opt.stream;
    const stream = opt.stream ?? (await openInput(opt.deviceId));
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ml-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const sr = ctx.sampleRate;
    const latency = this.recLatencyFrames();
    // durante a contagem a música não anda: o que chega antes disso não entra no take
    const preroll = Math.round((opt.countInSec ?? 0) * sr);
    const p = this.getProject();
    const rec: Rec = {
      stream,
      own,
      node,
      src,
      chunks: [],
      startTick,
      track,
      pick: opt.channels ?? 'stereo',
      gain: Math.pow(10, (opt.gainDb ?? 0) / 20),
      frames: 0,
      peaks: [],
      acc: 0,
      accN: 0,
      skip: latency,
      preroll,
      loop: opt.loop ?? null,
      lastLoops: 0,
      lastWrap: -1,
      onClose: opt.onTakeClosed ?? (() => {}),
      tps: 0,
      map: [[preroll, startTick]],
      smart: opt.smart ? { det: new TakeDetector(sr, opt.smart.marginDb, 0.12, opt.smart.thresholdDb), hold: Math.round(opt.smart.holdSec * sr), stream: null, node: null } : null,
      noiseDb: null,
      snrDb: null,
      peakDb: null,
      takes: [],
      lastLoud: 0,
      detBase: null,
      detPushed: 0,
      playId: null,
      base: 0,
    };
    rec.tps = ((p?.bpm ?? 120) * PPQ) / 60;
    if (!rec.smart) rec.takes.push({ c0: latency + preroll, c1: null, tick: startTick, track });
    node.port.onmessage = (e) => this.onRecChunk(rec, e.data as Float32Array[]);
    src.connect(node);
    this.rec = rec;
    if (rec.smart) {
      // Segunda captura do mesmo microfone, só para detectar: com o cancelamento de eco
      // do navegador (tira a música que sai dos alto-falantes) e a supressão de ruído.
      // O áudio gravado continua sendo o cru.
      try {
        const dev = opt.smart!.deviceId ?? opt.deviceId;
        const ds = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, ...(dev ? { deviceId: { exact: dev } } : {}) } });
        const dsrc = ctx.createMediaStreamSource(ds);
        const dnode = new AudioWorkletNode(ctx, 'ml-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
        dnode.port.onmessage = (e) => this.detect(rec, (e.data as Float32Array[])[0], true);
        dsrc.connect(dnode);
        Object.assign(rec.smart, { stream: ds, node: dnode });
      } catch {
        /* sem a captura extra: detecta no sinal cru */
      }
    }
  }

  /** Anota onde a música está (chamado a cada status da engine). */
  private markRec() {
    const r = this.rec;
    // status de outro play (ex.: a música que já tocava antes de apertar gravar) não conta:
    // ele traria a posição e o contador de voltas antigos
    if (!r || r.playId === null || this.status.playId !== r.playId || !this.status.playing || this.status.countIn) return;
    // o loop recomeçou: fecha o take no ponto exato da volta e (se ainda estiver gravando) abre outro no começo
    if (r.loop && this.status.loops > r.lastLoops) {
      r.lastLoops = this.status.loops;
      const prev = r.map[r.map.length - 1];
      const sr = this.ctx!.sampleRate;
      const wrap = Math.round(prev[0] + ((r.loop[1] - prev[1]) / r.tps) * sr) + r.skip;
      r.lastWrap = wrap;
      const last = r.takes[r.takes.length - 1];
      if (last && last.c1 === null && last.onset !== undefined && last.onset >= wrap) {
        // o take abriu um instante antes da volta, mas o som começou depois dela: o take
        // inteiro é da volta nova (sem deixar um "toco" de pré-ataque no fim da área)
        last.c0 = Math.max(last.c0, wrap);
        last.tick = r.loop[0];
        last.track = -1; // não conta a si mesmo ao procurar a track
        last.track = this.takeTrack(r, r.loop[0]);
      } else if (last && last.c1 === null && wrap > last.c0) {
        last.c1 = wrap;
        r.onClose(r.takes.length - 1);
        // gravação normal: a próxima volta é outro take; inteligente: só se você ainda estiver tocando
        if (!r.smart || r.frames - r.lastLoud < r.smart.hold) r.takes.push({ c0: wrap, c1: null, tick: r.loop[0], track: this.takeTrack(r, r.loop[0]) });
      }
      // a volta reinicia a contagem de tempo do mapa
      r.map.push([wrap - r.skip, r.loop[0]]);
    }
    r.map.push([r.frames, this.status.tick]);
    if (r.map.length > 4000) r.map.splice(1, 2000);
  }

  /** Áudio de um take (já fechado) da gravação em andamento. */
  takeAudio(k: number): { L: Float32Array; R: Float32Array; sr: number; tick: number } | null {
    const r = this.rec;
    const t = r?.takes[k];
    if (!r || !t) return null;
    const c1 = Math.min(r.frames, t.c1 ?? r.frames), c0 = Math.min(c1, t.c0);
    const L = new Float32Array(c1 - c0), R = new Float32Array(c1 - c0);
    let pos = 0;
    for (const ch of r.chunks) {
      const a = Math.max(c0, pos), b = Math.min(c1, pos + ch[0].length);
      if (b > a) {
        L.set(ch[0].subarray(a - pos, b - pos), a - c0);
        R.set(ch[1].subarray(a - pos, b - pos), a - c0);
      }
      pos += ch[0].length;
      if (pos >= c1) break;
    }
    return { L, R, sr: this.ctx!.sampleRate, tick: t.tick };
  }

  /** Coloca um áudio na engine sem passar pelo servidor (prévia de take, caminho "live:…"). */
  postLiveSample(path: string, sr: number, ch: Float32Array[]) {
    this.post({ type: 'sample', path, sr, ch });
    this.loaded.add(path);
  }

  /** Tick da música que estava soando quando a amostra capturada c chegou. */
  private tickAt(r: Rec, c: number) {
    const sr = this.ctx!.sampleRate;
    let pt = r.map[0];
    for (let i = r.map.length - 1; i >= 0; i--)
      if (r.map[i][0] <= c) {
        pt = r.map[i];
        break;
      }
    let tick = Math.max(0, pt[1] + ((c - pt[0]) / sr) * r.tps);
    // a volta do loop pode ainda não ter chegado no status: dobra para dentro da área
    if (r.loop && tick >= r.loop[1]) tick = r.loop[0] + ((tick - r.loop[1]) % (r.loop[1] - r.loop[0]));
    return tick;
  }

  private onRecChunk(r: Rec, raw: Float32Array[]) {
    const c = pickChannels(raw, r.pick, r.gain);
    r.chunks.push(c);
    const sr = this.ctx!.sampleRate;
    for (let i = 0; i < c[0].length; i++) {
      const a = Math.max(Math.abs(c[0][i]), Math.abs(c[1][i]));
      if (a > r.acc) r.acc = a;
      if (++r.accN < PEAK_FRAMES) continue;
      r.peaks.push(r.acc);
      r.acc = 0;
      r.accN = 0;
    }
    r.frames += c[0].length;
    if (!r.smart || r.smart.node) return;
    // sem a captura de detecção: analisa uma cópia mono do sinal cru (o gravado não muda)
    const mono = new Float32Array(c[0].length);
    for (let i = 0; i < mono.length; i++) mono[i] = (c[0][i] + c[1][i]) * 0.5;
    this.detect(r, mono, false);
  }

  /** Alimenta o detector e abre/fecha takes. ec = veio da captura com cancelamento de eco. */
  private detect(r: Rec, mono: Float32Array, ec: boolean) {
    if (!r.smart || this.rec !== r) return;
    const sr = this.ctx!.sampleRate;
    if (ec && r.gain !== 1) {
      const g = new Float32Array(mono.length);
      for (let i = 0; i < g.length; i++) g[i] = mono[i] * r.gain;
      mono = g;
    }
    // a captura de detecção conta do zero a partir de quando abriu: leva para o relógio da principal
    // (quando a detecção assume, o contador do detector está em detPushed e a principal em r.frames)
    if (ec && r.detBase === null) r.detBase = Math.max(0, r.frames - mono.length) - r.detPushed;
    const off = ec ? (r.detBase ?? 0) : 0;
    r.detPushed += mono.length;
    for (const raw of r.smart.det.push(mono)) {
      const st = { ...raw, since: raw.since + off, end: raw.end + off };
      r.noiseDb = st.noiseDb;
      r.snrDb = st.snrDb;
      r.peakDb = st.peakDb;
      const last = r.takes[r.takes.length - 1];
      const open = last && last.c1 === null ? last : null;
      if (!open && st.active) {
        // começa um take um pouco antes, para não cortar o ataque da palhetada
        const prevEnd = last ? last.c1! : 0;
        let c0 = Math.max(r.base + r.skip + r.preroll, prevEnd, st.since - 1024 - Math.round(0.06 * sr));
        // tocou logo depois de o loop recomeçar: o "pouco antes do ataque" não pode cair na
        // volta anterior (o take iria para o fim da área e passaria dela) — começa no início do loop
        const onset = st.since - 1024;
        if (r.loop && r.lastWrap >= 0 && onset >= r.lastWrap && c0 < r.lastWrap) c0 = r.lastWrap;
        const tick = c0 === r.lastWrap && r.loop ? r.loop[0] : this.tickAt(r, c0 - r.skip);
        r.takes.push({ c0, c1: null, tick, track: this.takeTrack(r, tick), onset });
        r.lastLoud = st.end;
      } else if (open) {
        if (st.active) r.lastLoud = st.end;
        else if (st.end - r.lastLoud > r.smart.hold) {
          open.c1 = st.end;
          r.onClose(r.takes.length - 1);
        }
      }
    }
  }

  /** Track do take: a da gravação, ou a seguinte se outro take (em loop) já ocupa o trecho. */
  /** Track provável de um take novo (a definitiva é escolhida ao colocar o take, com o tamanho real). */
  private takeTrack(r: Rec, tick: number) {
    let t = r.track;
    const sr = this.ctx!.sampleRate;
    const end = r.loop ? r.loop[1] : tick + r.tps * 4;
    const p = this.getProject();
    const busy = (track: number) =>
      (p?.clips ?? []).some((c) => c.track === track && c.pos < end && c.pos + c.len > tick) ||
      r.takes.some((x) => x.track === track && x.tick < end && x.tick + (((x.c1 ?? r.frames) - x.c0) / sr) * r.tps > tick);
    while (busy(t)) t++;
    return t;
  }

  /** Para a gravação e devolve cada take já recortado e alinhado com a música. */
  stopRecording(): { sr: number; takes: { k: number; tick: number; track: number; L: Float32Array; R: Float32Array }[] } | null {
    const r = this.rec;
    if (!r) return null;
    this.rec = null;
    r.src.disconnect();
    r.node.port.onmessage = null;
    if (r.own) r.stream.getTracks().forEach((t) => t.stop());
    if (r.smart?.node) {
      r.smart.node.port.onmessage = null;
      r.smart.node.disconnect();
      r.smart.stream?.getTracks().forEach((t) => t.stop());
    }
    const total = r.frames;
    const L = new Float32Array(total), R = new Float32Array(total);
    let w = 0;
    for (const c of r.chunks) {
      L.set(c[0], w);
      R.set(c[1], w);
      w += c[0].length;
    }
    const takes = r.takes
      .map((t, k) => {
        const c1 = Math.min(total, t.c1 ?? total);
        const c0 = Math.min(c1, t.c0);
        return { k, tick: t.tick, track: t.track, L: L.slice(c0, c1), R: R.slice(c0, c1) };
      })
      .filter((t) => t.L.length > 0);
    return { sr: this.ctx!.sampleRate, takes };
  }

  // ---------------------------------------------------------------- amp de guitarra
  //
  // O retorno (o que você ouve tocando) roda num contexto de áudio próprio, com o
  // menor buffer que o sistema aceitar e a cadeia na versão leve. A gravação usa
  // o sinal cru e os efeitos são reaplicados em alta qualidade ao fechar o take.

  private mon: AudioContext | null = null;
  private amp: { stream: MediaStream; src: MediaStreamAudioSourceNode; node: AudioWorkletNode; monitor: GainNode; deviceId: string } | null = null;
  onAmpMeter: (inp: number[], out: number[]) => void = () => {};
  /** Entrada crua do amp (para gravar). */
  get ampStream() {
    return this.amp?.stream ?? null;
  }
  /** Atraso do retorno do amp em ms (buffer de saída do contexto de retorno). */
  get monitorLatencyMs() {
    const m = this.mon;
    return m ? Math.round(((m.baseLatency || 0) + ((m as any).outputLatency || 0)) * 1000) : null;
  }
  /** Liga o amp na entrada escolhida (troca de entrada religa só a captura). */
  async startAmp(deviceId: string) {
    await this.resume();
    if (!this.mon) {
      this.mon = new AudioContext({ latencyHint: 0, sampleRate: this.ctx?.sampleRate });
      await this.mon.audioWorklet.addModule(workletUrl);
    }
    const mon = this.mon;
    if (mon.state !== 'running') await mon.resume().catch(() => {});
    if (this.amp && this.amp.deviceId === deviceId) return;
    const stream = await openInput(deviceId || undefined);
    const src = mon.createMediaStreamSource(stream);
    if (this.amp) {
      if (this.rec && this.rec.stream === this.amp.stream) throw new Error('não dá para trocar a entrada no meio de uma gravação');
      this.amp.src.disconnect();
      this.amp.stream.getTracks().forEach((t) => t.stop());
      src.connect(this.amp.node);
      Object.assign(this.amp, { stream, src, deviceId });
      return;
    }
    const node = new AudioWorkletNode(mon, 'ml-amp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const monitor = mon.createGain();
    node.port.onmessage = (e) => e.data.type === 'meter' && this.onAmpMeter(e.data.inp, e.data.out);
    src.connect(node);
    node.connect(monitor);
    monitor.connect(mon.destination);
    this.amp = { stream, src, node, monitor, deviceId };
  }
  /** Analisador na entrada crua do amp (afinador de guitarra). Desligue com o retorno de off. */
  ampTap(): { an: AnalyserNode; sr: number; off: () => void } | null {
    const a = this.amp;
    if (!a || !this.mon) return null;
    const an = this.mon.createAnalyser();
    an.fftSize = 8192;
    a.src.connect(an);
    return { an, sr: this.mon.sampleRate, off: () => a.src.disconnect(an) };
  }
  stopAmp() {
    const a = this.amp;
    if (!a) return;
    if (this.rec?.stream === a.stream) return; // não desliga no meio de uma gravação
    a.src.disconnect();
    a.node.disconnect();
    a.monitor.disconnect();
    a.stream.getTracks().forEach((t) => t.stop());
    this.amp = null;
    this.mon?.suspend().catch(() => {});
  }
  configAmp(cfg: { chain: unknown[]; inGain: number; outGain: number; pick: RecChannels; bpm: number }) {
    this.amp?.node.port.postMessage({ type: 'config', ...cfg });
  }
  setAmpMonitor(on: boolean) {
    if (this.amp && this.mon) this.amp.monitor.gain.setTargetAtTime(on ? 1 : 0, this.mon.currentTime, 0.01);
  }
  get ampRunning() {
    return !!this.amp;
  }

  /**
   * Atraso de ida e volta da gravação (ms): do som sair até o que você toca voltar
   * pela entrada. null = estimado pelo navegador (só a saída; costuma ficar curto).
   */
  recLatencyMs: number | null = null;
  recLatencyFrames() {
    const ctx = this.ctx!;
    const est = (ctx.baseLatency || 0) + ((ctx as any).outputLatency || 0);
    return Math.round((this.recLatencyMs !== null ? this.recLatencyMs / 1000 : est) * ctx.sampleRate);
  }

  /**
   * Mede o atraso de ida e volta da gravação: toca cliques e procura, no que a
   * entrada captou, o ataque logo depois de cada um (o próprio clique vazando nas
   * caixas, ou você tocando junto com fone). Devolve a mediana em ms.
   */
  async calibrateLatency(opt: { deviceId?: string; channels?: RecChannels }, onProgress: (k: number, n: number) => void) {
    await this.resume();
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const stream = await openInput(opt.deviceId);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ml-recorder-t', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const chunks: { t: number; x: Float32Array }[] = [];
    node.port.onmessage = (e) => {
      const c = pickChannels(e.data.ch as Float32Array[], opt.channels ?? 'stereo');
      chunks.push({ t: e.data.t, x: c[0] });
    };
    src.connect(node);
    const n = 8, beat = 60 / 90;
    const t0 = ctx.currentTime + 0.8;
    const ticks = Array.from({ length: n }, (_, i) => t0 + i * beat);
    ticks.forEach((t, i) => this.click(t, i === 0));
    for (let i = 0; i < n; i++) setTimeout(() => onProgress(i + 1, n), (ticks[i] - ctx.currentTime) * 1000);
    await new Promise((r) => setTimeout(r, (ticks[n - 1] - ctx.currentTime + 0.7) * 1000));
    src.disconnect();
    node.port.onmessage = null;
    stream.getTracks().forEach((t) => t.stop());
    if (!chunks.length) throw new Error('nada foi captado');
    // amostras com o horário do contexto
    const start = chunks[0].t;
    const total = chunks.reduce((s, c) => s + c.x.length, 0);
    const x = new Float32Array(total);
    let w = 0;
    for (const c of chunks) {
      x.set(c.x, Math.round((c.t - start) * sr));
      w += c.x.length;
    }
    void w;
    const at = (t: number) => Math.round((t - start) * sr);
    // ruído de fundo: antes do primeiro clique
    let floor = 0;
    for (let i = Math.max(0, at(t0 - 0.6)); i < at(t0 - 0.05); i++) floor = Math.max(floor, Math.abs(x[i]));
    const delays: number[] = [];
    for (const tk of ticks) {
      const a = at(tk), b = Math.min(x.length, at(tk + 0.45));
      let peak = 0;
      for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
      if (peak < Math.max(floor * 3, 0.01)) continue; // nada nesse tempo
      const thr = Math.max(floor * 2.5, peak * 0.3);
      for (let i = a; i < b; i++)
        if (Math.abs(x[i]) > thr) {
          delays.push(((i - a) / sr) * 1000);
          break;
        }
    }
    if (delays.length < 4) throw new Error('não deu para ouvir os cliques (ou o que você tocou) na entrada');
    delays.sort((p, q) => p - q);
    const med = delays[delays.length >> 1];
    const spread = delays[Math.floor(delays.length * 0.8)] - delays[Math.floor(delays.length * 0.2)];
    return { ms: Math.round(med), hits: delays.length, spread: Math.round(spread) };
  }

  /** Toca n cliques de contagem no tempo da música; resolve quando o último tempo termina. */
  async countInClicks(n: number, bpm: number, onBeat: (left: number) => void) {
    await this.resume();
    const ctx = this.ctx!;
    const beat = 60 / bpm;
    const t0 = ctx.currentTime + 0.08;
    for (let i = 0; i < n; i++) this.click(t0 + i * beat, i === 0);
    for (let i = 0; i < n; i++) setTimeout(() => onBeat(n - i), Math.max(0, (t0 - ctx.currentTime + i * beat) * 1000));
    await new Promise((r) => setTimeout(r, (t0 - ctx.currentTime + n * beat) * 1000));
    onBeat(0);
  }
  /** Um clique de metrônomo no tempo t do contexto. */
  click(t: number, accent = false) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(accent ? 0.42 : 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.04);
  }

  // ---------------------------------------------------------------- captura avulsa (Afinador, Stitcher)
  // Grava só a entrada, sem tocar a música e sem ligação com a playlist.

  private cap: { stream: MediaStream; src: MediaStreamAudioSourceNode; node: AudioWorkletNode; chunks: Float32Array[][]; frames: number; peaks: number[]; acc: number; accN: number; pick: RecChannels; armed: boolean } | null = null;
  armCapture() {
    if (this.cap) this.cap.armed = true;
  }
  onCapture: () => void = () => {};
  get capturing() {
    return !!this.cap;
  }
  /** Captura em andamento: amostras e picos (um a cada PEAK_FRAMES) para desenhar ao vivo. */
  get liveCapture() {
    const c = this.cap;
    return c && this.ctx ? { frames: c.frames, sr: this.ctx.sampleRate, peaks: c.peaks, peakFrames: PEAK_FRAMES } : null;
  }
  /** arm = só começa a guardar depois de armCapture() (contagem). */
  async startCapture(opt: { deviceId?: string; channels?: RecChannels; arm?: boolean } = {}) {
    await this.resume();
    const ctx = this.ctx!;
    const stream = await openInput(opt.deviceId);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ml-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const cap = { stream, src, node, chunks: [] as Float32Array[][], frames: 0, peaks: [] as number[], acc: 0, accN: 0, pick: opt.channels ?? 'stereo', armed: !opt.arm };
    node.port.onmessage = (e) => {
      if (!cap.armed) return; // ainda na contagem: descarta
      const c = pickChannels(e.data as Float32Array[], cap.pick);
      cap.chunks.push(c);
      for (let i = 0; i < c[0].length; i++) {
        const a = Math.max(Math.abs(c[0][i]), Math.abs(c[1][i]));
        if (a > cap.acc) cap.acc = a;
        if (++cap.accN === PEAK_FRAMES) {
          cap.peaks.push(cap.acc);
          cap.acc = 0;
          cap.accN = 0;
        }
      }
      cap.frames += c[0].length;
      this.onCapture();
    };
    src.connect(node);
    this.cap = cap;
  }
  stopCapture(): { L: Float32Array; R: Float32Array; sr: number } | null {
    const c = this.cap;
    if (!c) return null;
    this.cap = null;
    c.src.disconnect();
    c.node.port.onmessage = null;
    c.stream.getTracks().forEach((t) => t.stop());
    const L = new Float32Array(c.frames), R = new Float32Array(c.frames);
    let w = 0;
    for (const ch of c.chunks) {
      L.set(ch[0], w);
      R.set(ch[1], w);
      w += ch[0].length;
    }
    return { L, R, sr: this.ctx!.sampleRate };
  }

  /** Toca um áudio avulso (prévia das ferramentas). Devolve a função de parar e o instante de início. */
  playBuffer(ch: Float32Array[], sr: number, fromSec = 0, onEnd?: () => void) {
    const ctx = this.ctx;
    if (!ctx) return null;
    const buf = ctx.createBuffer(2, ch[0].length, sr);
    buf.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel((ch[1] ?? ch[0]) as Float32Array<ArrayBuffer>, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => onEnd?.();
    const t0 = ctx.currentTime;
    src.start(t0, fromSec);
    return { stop: () => src.stop(), started: t0, pos: () => fromSec + (ctx.currentTime - t0) };
  }

  /** Entradas de áudio disponíveis (os nomes só aparecem depois de liberar o microfone uma vez). */
  async inputDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Entrada ${i + 1}` }));
  }

  /** Carrega um arquivo ou um instrumento multi-sample (pasta / .fst) na engine. */
  loadSample(path: string): Promise<void> {
    if (this.loaded.has(path) || path.startsWith('live:')) return Promise.resolve();
    let pr = this.loading.get(path);
    if (pr) return pr;
    pr = (async () => {
      const info = await fetch(`/api/source?path=${encodeURIComponent(path)}`).then((r) => r.json());
      if (info.kind === 'set') {
        this.step(info.zones.length, 0, info.name);
        // Cada zona vem do servidor já decodificada; a chave casa com a do conjunto.
        await Promise.all(
          info.zones.map(async (z: { i: number }) => {
            const r = await fetch(`/api/zone?path=${encodeURIComponent(info.path)}&i=${z.i}`);
            if (!r.ok) throw new Error(`zona ${z.i}: ${r.status}`);
            const d = decodeWav(new Uint8Array(await r.arrayBuffer()));
            this.post({ type: 'sample', path: `${info.path}#${z.i}`, sr: d.sr, ch: d.ch, root: d.root, loop: d.loop });
            this.step(0, 1);
          }),
        );
        const set = {
          name: info.name,
          zones: info.zones.map((z: any) => ({ key: `${info.path}#${z.i}`, root: z.root, lo: z.lo, hi: z.hi, vlo: z.vlo, vhi: z.vhi })),
        };
        this.post({ type: 'sampleset', path, set });

      } else {
        this.step(1, 0, path.split('/').pop());
        const r = await fetch(`/api/sample?path=${encodeURIComponent(path)}`);
        if (!r.ok) throw new Error(`sample ${path}: ${r.status}`);
        const data = decodeWav(new Uint8Array(await r.arrayBuffer()));
        this.post({ type: 'sample', path, sr: data.sr, ch: data.ch, root: data.root, loop: data.loop });
        this.step(0, 1);
      }
      this.loaded.add(path);
    })();
    this.loading.set(path, pr);
    pr.catch((e) => console.warn(e)).finally(() => this.loading.delete(path));
    return pr;
  }
  onLoading: (msg: string) => void = () => {};
  /** Progresso do carregamento de samples (unidades: arquivos ou zonas). */
  progress = { done: 0, total: 0, label: '' };
  onProgress: () => void = () => {};
  private step(total: number, done: number, label?: string) {
    this.progress.total += total;
    this.progress.done += done;
    if (label) this.progress.label = label;
    this.onProgress();
  }
  /** Espera todos os carregamentos em andamento (inclusive os que começarem no meio). */
  async idle() {
    while (this.loading.size) await Promise.allSettled([...this.loading.values()]);
  }
  get pending() {
    return this.loading.size;
  }

  private playSeq = 0;
  /** Último play pedido (status de plays anteriores ainda podem chegar). */
  playId = 0;
  /** Quando o último play foi pedido (performance.now), de onde e com quantos tempos de contagem. */
  playAt = 0;
  playFrom = 0;
  playCountIn = 0;
  play(mode: 'pattern' | 'song', patternId: string | null, tick?: number, countIn = 0) {
    const id = ++this.playSeq + Math.floor(Math.random() * 1e6) * 1000;
    this.playId = id;
    this.playAt = performance.now();
    this.playFrom = tick ?? 0;
    this.playCountIn = countIn;
    const r = this.rec;
    if (r && r.playId === null) {
      // a música (ou a contagem) começa agora: o relógio da gravação passa a valer daqui.
      // Até aqui a captura já podia estar aberta (abrir a detecção leva um tempo).
      r.playId = id;
      r.base = r.frames;
      r.map[0] = [r.frames + r.preroll, tick ?? r.startTick];
      const t0 = r.takes[0];
      if (t0 && !r.smart) t0.c0 = r.skip + r.preroll + r.frames;
    }
    this.start().then(() => this.post({ type: 'play', mode, patternId, tick, countIn, id }));
  }
  /** Área selecionada, loop e metrônomo (estado de transporte, fora do projeto). */
  private tp: { region?: [number, number] | null; loopOn?: boolean; metronome?: boolean; endless?: boolean } = {};
  transport(t: { region?: [number, number] | null; loopOn?: boolean; metronome?: boolean; endless?: boolean }) {
    Object.assign(this.tp, t);
    this.post({ type: 'transport', ...t });
  }
  stop(rewind = true) {
    this.post({ type: 'stop', rewind });
  }
  seek(tick: number) {
    this.post({ type: 'seek', tick });
  }
  /** Avisado a cada nota ao vivo (a gravação de notas escuta isto). */
  onLive: (on: boolean, channel: string, key: number, vel: number) => void = () => {};
  /** Quando chegou o último status da engine (para estimar a posição entre atualizações). */
  statusAt = 0;
  liveOn(channel: string, key: number, vel = 0.8, gate: number | null = null) {
    if (gate === null) this.onLive(true, channel, key, vel);
    this.start().then(() => this.post({ type: 'liveOn', channel, key, vel, gate }));
  }
  /** Diz à engine qual canal está aberto na tela (para acender as teclas dele). */
  watch(channel: string | null) {
    this.watching = channel;
    this.post({ type: 'watch', channel });
  }
  liveOff(channel: string, key: number) {
    this.onLive(false, channel, key, 0);
    this.post({ type: 'liveOff', channel, key });
  }

  /** Pré-escuta de arquivo do navegador (fora da engine). */
  private previewSrc: AudioBufferSourceNode | null = null;
  async previewFile(path: string) {
    await this.start();
    const ctx = this.ctx!;
    this.previewSrc?.stop();
    const r = await fetch(`/api/sample?path=${encodeURIComponent(path)}`);
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.8;
    src.connect(g).connect(ctx.destination);
    src.start();
    this.previewSrc = src;
  }
  stopPreview() {
    this.previewSrc?.stop();
    this.previewSrc = null;
  }
}

export const audio = new Audio();

export type RecChannels = 'stereo' | 'left' | 'right';
const PEAK_FRAMES = 256;

interface Rec {
  stream: MediaStream;
  own: boolean; // a gravação abriu a entrada (e fecha no fim)
  node: AudioWorkletNode;
  src: MediaStreamAudioSourceNode;
  chunks: Float32Array[][];
  startTick: number;
  track: number;
  pick: RecChannels;
  gain: number;
  frames: number;
  /** Pico de cada bloco de PEAK_FRAMES amostras, para desenhar a onda ao vivo. */
  peaks: number[];
  acc: number;
  accN: number;
  /** Latência a compensar (amostras): a amostra c soou junto com a música em c - skip. */
  skip: number;
  /** Amostras capturadas durante a contagem (antes da música começar). */
  preroll: number;
  /** Área do loop: cada volta fecha um take. */
  loop: [number, number] | null;
  lastLoops: number;
  /** Amostra capturada (com a latência) em que o loop recomeçou pela última vez. */
  lastWrap: number;
  /** Avisado quando um take fecha (para ele já entrar na playlist e tocar na próxima volta). */
  onClose: (k: number) => void;
  tps: number; // ticks por segundo
  map: [number, number][];
  /** Detector de "está tocando" (com aprendizado do ruído de fundo); só decide os cortes. */
  smart: { det: TakeDetector; hold: number; stream: MediaStream | null; node: AudioWorkletNode | null } | null;
  noiseDb: number | null;
  snrDb: number | null;
  peakDb: number | null;
  takes: { c0: number; c1: number | null; tick: number; track: number; onset?: number }[];
  lastLoud: number;
  /**
   * Amostra da captura principal em que a captura de detecção começou. Ela abre
   * depois (getUserMedia leva um tempo) e conta as amostras a partir de 0: sem
   * somar isto, todo take começaria adiantado (e caía antes da volta do loop).
   */
  detBase: number | null;
  /** Amostras já entregues ao detector (cru antes da detecção abrir, depois a detecção). */
  detPushed: number;
  /** Play que esta gravação iniciou (null até a música começar). */
  playId: number | null;
  /** Amostra da captura em que a música (ou a contagem) começou. */
  base: number;
}

/** Estéreo, ou só um canal da interface duplicado nos dois lados (guitarra, microfone); aplica o ganho. */
function pickChannels(c: Float32Array[], pick: RecChannels, gain = 1): Float32Array[] {
  const l = c[0], r = c[1] ?? c[0];
  const sc = (x: Float32Array) => {
    if (gain === 1) return x.slice();
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] * gain;
    return y;
  };
  if (pick === 'left') {
    const a = sc(l);
    return [a, a];
  }
  if (pick === 'right') {
    const a = sc(r);
    return [a, a];
  }
  return [sc(l), sc(r)];
}

/** Abre uma entrada de áudio com o sinal limpo (sem cancelamento de eco, supressão de ruído nem ganho automático). */
function openInput(deviceId?: string) {
  const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}
