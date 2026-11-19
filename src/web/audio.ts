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
  status: EngineStatus = { playing: false, mode: 'pattern', patternId: null, tick: 0, meters: [], gr: [], activeChannels: [], lit: [], spectrum: null };
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
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  post(m: unknown) {
    this.node?.port.postMessage(m);
  }

  /** Envia o projeto inteiro (abrir, undo/redo). */
  setProject(p: Project) {
    if (!this.node) return; // ao ligar o áudio, start() envia o projeto atual
    this.post({ type: 'project', project: p });
    this.syncSamples(p);
  }

  /** Envia só as alterações: a thread de áudio aplica as mesmas ops na cópia dela. */
  applyOps(ops: Op[], p: Project) {
    if (!this.node) return;
    if (ops.some((o) => o.op === 'replace')) return this.setProject(p);
    this.post({ type: 'ops', ops });
    this.syncSamples(p);
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
    opt: { deviceId?: string; channels?: RecChannels; stream?: MediaStream; gainDb?: number; smart?: { marginDb: number; holdSec: number; thresholdDb: number; deviceId?: string } } = {},
  ) {
    await this.resume();
    const ctx = this.ctx!;
    const own = !opt.stream;
    const stream = opt.stream ?? (await openInput(opt.deviceId));
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ml-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const sr = ctx.sampleRate;
    const latency = Math.round(((ctx.baseLatency || 0) + ((ctx as any).outputLatency || 0)) * sr);
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
      tps: 0,
      map: [[0, startTick]],
      smart: opt.smart ? { det: new TakeDetector(sr, opt.smart.marginDb, 0.12, opt.smart.thresholdDb), hold: Math.round(opt.smart.holdSec * sr), stream: null, node: null } : null,
      noiseDb: null,
      snrDb: null,
      peakDb: null,
      takes: [],
      lastLoud: 0,
    };
    rec.tps = ((p?.bpm ?? 120) * PPQ) / 60;
    if (!rec.smart) rec.takes.push({ c0: latency, c1: null, tick: startTick, track });
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
    if (r && this.status.playing) r.map.push([r.frames, this.status.tick]);
    if (r && r.map.length > 4000) r.map.splice(1, 2000);
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
    return Math.max(0, pt[1] + ((c - pt[0]) / sr) * r.tps);
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
    for (const st of r.smart.det.push(mono)) {
      r.noiseDb = st.noiseDb;
      r.snrDb = st.snrDb;
      r.peakDb = st.peakDb;
      const last = r.takes[r.takes.length - 1];
      const open = last && last.c1 === null ? last : null;
      if (!open && st.active) {
        // começa um take um pouco antes, para não cortar o ataque da palhetada
        const prevEnd = last ? last.c1! : 0;
        const c0 = Math.max(r.skip, prevEnd, st.since - 1024 - Math.round(0.06 * sr));
        const tick = this.tickAt(r, c0 - r.skip);
        r.takes.push({ c0, c1: null, tick, track: this.takeTrack(r, tick) });
        r.lastLoud = st.end;
      } else if (open) {
        if (st.active) r.lastLoud = st.end;
        else if (st.end - r.lastLoud > r.smart.hold) open.c1 = st.end;
      }
    }
  }

  /** Track do take: a da gravação, ou a seguinte se outro take (em loop) já ocupa o trecho. */
  private takeTrack(r: Rec, tick: number) {
    let t = r.track;
    const sr = this.ctx!.sampleRate;
    const busy = (track: number) =>
      r.takes.some((x) => x.track === track && tick >= x.tick && tick < x.tick + (((x.c1 ?? r.frames) - x.c0) / sr) * r.tps);
    while (busy(t)) t++;
    return t;
  }

  /** Para a gravação e devolve cada take já recortado e alinhado com a música. */
  stopRecording(): { sr: number; takes: { tick: number; track: number; L: Float32Array; R: Float32Array }[] } | null {
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
      .map((t) => {
        const c1 = Math.min(total, t.c1 ?? total);
        const c0 = Math.min(c1, t.c0);
        return { tick: t.tick, track: t.track, L: L.slice(c0, c1), R: R.slice(c0, c1) };
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

  /** Entradas de áudio disponíveis (os nomes só aparecem depois de liberar o microfone uma vez). */
  async inputDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Entrada ${i + 1}` }));
  }

  /** Carrega um arquivo ou um instrumento multi-sample (pasta / .fst) na engine. */
  loadSample(path: string): Promise<void> {
    if (this.loaded.has(path)) return Promise.resolve();
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

  play(mode: 'pattern' | 'song', patternId: string | null, tick?: number) {
    this.start().then(() => this.post({ type: 'play', mode, patternId, tick }));
  }
  stop(rewind = true) {
    this.post({ type: 'stop', rewind });
  }
  seek(tick: number) {
    this.post({ type: 'seek', tick });
  }
  liveOn(channel: string, key: number, vel = 0.8, gate: number | null = null) {
    this.start().then(() => this.post({ type: 'liveOn', channel, key, vel, gate }));
  }
  /** Diz à engine qual canal está aberto na tela (para acender as teclas dele). */
  watch(channel: string | null) {
    this.watching = channel;
    this.post({ type: 'watch', channel });
  }
  liveOff(channel: string, key: number) {
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
  tps: number; // ticks por segundo
  map: [number, number][];
  /** Detector de "está tocando" (com aprendizado do ruído de fundo); só decide os cortes. */
  smart: { det: TakeDetector; hold: number; stream: MediaStream | null; node: AudioWorkletNode | null } | null;
  noiseDb: number | null;
  snrDb: number | null;
  peakDb: number | null;
  takes: { c0: number; c1: number | null; tick: number; track: number }[];
  lastLoud: number;
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
