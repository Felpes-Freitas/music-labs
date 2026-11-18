// Ponte entre a interface e o AudioWorklet: contexto de áudio, samples e transporte.
import workletUrl from './worklet.ts?worker&url';
import { decodeWav } from '../core/wav';
import type { Project } from '../core/model';
import type { EngineStatus } from '../core/engine';

export class Audio {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  status: EngineStatus = { playing: false, mode: 'pattern', patternId: null, tick: 0, meters: [], gr: [], activeChannels: [] };
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private pending: Project | null = null;
  onStatus: (s: EngineStatus) => void = () => {};
  analyser: AnalyserNode | null = null;

  async start() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
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
        this.onStatus(this.status);
      } else if (e.data.type === 'error') console.error('engine:', e.data.error);
    };
    this.ctx = ctx;
    this.node = node;
    if (this.pending) this.setProject(this.pending);
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  post(m: unknown) {
    this.node?.port.postMessage(m);
  }

  setProject(p: Project) {
    if (!this.node) {
      this.pending = p;
      return;
    }
    this.post({ type: 'project', project: p });
    for (const ch of p.channels) {
      if (ch.type === 'sampler' && ch.params.sample) this.loadSample(String(ch.params.sample));
    }
  }

  /** Carrega um arquivo ou um instrumento multi-sample (pasta / .fst) na engine. */
  loadSample(path: string): Promise<void> {
    if (this.loaded.has(path)) return Promise.resolve();
    let pr = this.loading.get(path);
    if (pr) return pr;
    pr = (async () => {
      const info = await fetch(`/api/source?path=${encodeURIComponent(path)}`).then((r) => r.json());
      if (info.kind === 'set') {
        this.onLoading(`Carregando ${info.name} (${info.zones.length} samples)…`);
        // Cada zona vem do servidor já decodificada; a chave casa com a do conjunto.
        await Promise.all(
          info.zones.map(async (z: { i: number }) => {
            const r = await fetch(`/api/zone?path=${encodeURIComponent(info.path)}&i=${z.i}`);
            if (!r.ok) throw new Error(`zona ${z.i}: ${r.status}`);
            const d = decodeWav(new Uint8Array(await r.arrayBuffer()));
            this.post({ type: 'sample', path: `${info.path}#${z.i}`, sr: d.sr, ch: d.ch, root: d.root, loop: d.loop });
          }),
        );
        const set = {
          name: info.name,
          zones: info.zones.map((z: any) => ({ key: `${info.path}#${z.i}`, root: z.root, lo: z.lo, hi: z.hi, vlo: z.vlo, vhi: z.vhi })),
        };
        this.post({ type: 'sampleset', path, set });
        this.onLoading(`${info.name} pronto`);
      } else {
        const r = await fetch(`/api/sample?path=${encodeURIComponent(path)}`);
        if (!r.ok) throw new Error(`sample ${path}: ${r.status}`);
        const data = decodeWav(new Uint8Array(await r.arrayBuffer()));
        this.post({ type: 'sample', path, sr: data.sr, ch: data.ch, root: data.root, loop: data.loop });
      }
      this.loaded.add(path);
    })();
    this.loading.set(path, pr);
    pr.catch((e) => console.warn(e)).finally(() => this.loading.delete(path));
    return pr;
  }
  onLoading: (msg: string) => void = () => {};

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
