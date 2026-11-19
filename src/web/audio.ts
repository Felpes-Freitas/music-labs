// Ponte entre a interface e o AudioWorklet: contexto de áudio, samples e transporte.
import workletUrl from './worklet.ts?worker&url';
import { decodeWav } from '../core/wav';
import type { Project } from '../core/model';
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
    const node = new AudioWorkletNode(ctx, 'musiclabs', { numberOfInputs: 0, outputChannelCount: [2] });
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    node.connect(this.analyser);
    node.connect(ctx.destination);
    node.port.onmessage = (e) => {
      if (e.data.type === 'status') {
        this.status = e.data.status;
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
  private rec: {
    stream: MediaStream | null;
    node: AudioWorkletNode;
    src: AudioNode;
    chunks: Float32Array[][];
    startTick: number;
    track: number;
    pick: RecChannels;
    frames: number;
    /** Pico de cada bloco de PEAK_FRAMES amostras, para desenhar a onda ao vivo. */
    peaks: number[];
    acc: number;
    accN: number;
  } | null = null;
  /** Gravação em andamento (para a playlist desenhar a onda enquanto grava). */
  get liveRecording() {
    const r = this.rec;
    return r && this.ctx ? { startTick: r.startTick, track: r.track, frames: r.frames, sr: this.ctx.sampleRate, peaks: r.peaks, peakFrames: PEAK_FRAMES } : null;
  }

  get recording() {
    return !!this.rec;
  }

  /** Começa a capturar o microfone; startTick é a posição da música no início. */
  async startRecording(startTick: number, track: number, opt: { deviceId?: string; channels?: RecChannels; from?: AudioNode } = {}) {
    await this.resume();
    const ctx = this.ctx!;
    let stream: MediaStream | null = null;
    let src: AudioNode;
    if (opt.from) src = opt.from; // ex.: a saída do amp, já com os efeitos
    else {
      stream = await openInput(opt.deviceId);
      src = ctx.createMediaStreamSource(stream);
    }
    const node = new AudioWorkletNode(ctx, 'ml-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const rec = { stream, node, src, chunks: [] as Float32Array[][], startTick, track, pick: (opt.from ? 'stereo' : opt.channels ?? 'stereo') as RecChannels, frames: 0, peaks: [] as number[], acc: 0, accN: 0 };
    node.port.onmessage = (e) => {
      const c = pickChannels(e.data as Float32Array[], rec.pick);
      rec.chunks.push(c);
      for (let i = 0; i < c[0].length; i++) {
        const a = Math.max(Math.abs(c[0][i]), Math.abs(c[1][i]));
        if (a > rec.acc) rec.acc = a;
        if (++rec.accN === PEAK_FRAMES) {
          rec.peaks.push(rec.acc);
          rec.acc = 0;
          rec.accN = 0;
        }
      }
      rec.frames += c[0].length;
    };
    src.connect(node);
    this.rec = rec;
  }

  // ---------------------------------------------------------------- amp de guitarra

  private amp: { stream: MediaStream; src: MediaStreamAudioSourceNode; node: AudioWorkletNode; monitor: GainNode; deviceId: string } | null = null;
  onAmpMeter: (inp: number[], out: number[]) => void = () => {};
  /** Nó com o som do amp (para gravar). */
  get ampNode() {
    return this.amp?.node ?? null;
  }
  /** Liga o amp na entrada escolhida (troca de entrada religa só a captura). */
  async startAmp(deviceId: string) {
    await this.resume();
    const ctx = this.ctx!;
    if (this.amp && this.amp.deviceId === deviceId) return;
    const stream = await openInput(deviceId || undefined);
    const src = ctx.createMediaStreamSource(stream);
    if (this.amp) {
      // mesma cadeia, só troca a entrada
      this.amp.src.disconnect();
      this.amp.stream.getTracks().forEach((t) => t.stop());
      src.connect(this.amp.node);
      Object.assign(this.amp, { stream, src, deviceId });
      return;
    }
    const node = new AudioWorkletNode(ctx, 'ml-amp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const monitor = ctx.createGain();
    node.port.onmessage = (e) => e.data.type === 'meter' && this.onAmpMeter(e.data.inp, e.data.out);
    src.connect(node);
    node.connect(monitor);
    monitor.connect(ctx.destination);
    this.amp = { stream, src, node, monitor, deviceId };
  }
  stopAmp() {
    const a = this.amp;
    if (!a) return;
    if (this.rec?.src === a.node) return; // não desliga no meio de uma gravação
    a.src.disconnect();
    a.node.disconnect();
    a.monitor.disconnect();
    a.stream.getTracks().forEach((t) => t.stop());
    this.amp = null;
  }
  configAmp(cfg: { chain: unknown[]; inGain: number; outGain: number; pick: RecChannels; bpm: number }) {
    this.amp?.node.port.postMessage({ type: 'config', ...cfg });
  }
  setAmpMonitor(on: boolean) {
    if (this.amp && this.ctx) this.amp.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }
  get ampRunning() {
    return !!this.amp;
  }

  /** Entradas de áudio disponíveis (os nomes só aparecem depois de liberar o microfone uma vez). */
  async inputDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Entrada ${i + 1}` }));
  }

  /**
   * Para a gravação e devolve o áudio (já compensando a latência de entrada e
   * saída, para alinhar com o que estava tocando).
   */
  stopRecording(): { L: Float32Array; R: Float32Array; sr: number; startTick: number; track: number } | null {
    const r = this.rec;
    if (!r) return null;
    this.rec = null;
    r.src.disconnect(r.node);
    r.node.port.onmessage = null;
    r.stream?.getTracks().forEach((t) => t.stop());
    const total = r.chunks.reduce((n, c) => n + c[0].length, 0);
    const ctx = this.ctx!;
    const latency = Math.round(((ctx.baseLatency || 0) + ((ctx as any).outputLatency || 0)) * ctx.sampleRate);
    const skip = Math.min(total, latency);
    const L = new Float32Array(total - skip), R = new Float32Array(total - skip);
    let w = -skip;
    for (const c of r.chunks) {
      for (let i = 0; i < c[0].length; i++, w++) {
        if (w < 0) continue;
        L[w] = c[0][i];
        R[w] = (c[1] ?? c[0])[i];
      }
    }
    return { L, R, sr: ctx.sampleRate, startTick: r.startTick, track: r.track };
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

/** Estéreo, ou só um canal da interface duplicado nos dois lados (guitarra, microfone). */
function pickChannels(c: Float32Array[], pick: RecChannels): Float32Array[] {
  const l = c[0], r = c[1] ?? c[0];
  if (pick === 'left') return [l, l];
  if (pick === 'right') return [r, r];
  return [l, r];
}

/** Abre uma entrada de áudio com o sinal limpo (sem cancelamento de eco, supressão de ruído nem ganho automático). */
function openInput(deviceId?: string) {
  const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}
