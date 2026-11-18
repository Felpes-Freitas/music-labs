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
