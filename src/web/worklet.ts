// AudioWorklet: roda a engine do Music Labs na thread de áudio do navegador.
import { Engine } from '../core/engine';
import { applyOps } from '../core/ops';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  port: MessagePort;
}

class MusicLabsProcessor extends AudioWorkletProcessor {
  engine = new Engine(sampleRate);
  blocks = 0;
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      const eng = this.engine;
      switch (m.type) {
        case 'project':
          eng.setProject(m.project);
          break;
        case 'ops':
          if (eng.project) {
            try {
              eng.setProject(applyOps(eng.project, m.ops));
            } catch (err) {
              this.port.postMessage({ type: 'resync', error: String(err) });
            }
          }
          break;
        case 'sample':
          eng.setSample(m.path, { sr: m.sr, ch: m.ch, root: m.root, loop: m.loop });
          break;
        case 'sampleset':
          eng.setSampleSet(m.path, m.set);
          break;
        case 'play':
          eng.play(m.mode, m.patternId, m.tick);
          break;
        case 'stop':
          eng.stop(m.rewind !== false);
          break;
        case 'seek':
          eng.tick = m.tick;
          break;
        case 'mode':
          eng.mode = m.mode;
          if (m.patternId) eng.patternId = m.patternId;
          break;
        case 'pattern':
          eng.patternId = m.patternId;
          break;
        case 'liveOn':
          eng.liveOn(m.channel, m.key, m.vel ?? 0.8, m.gate ?? null);
          break;
        case 'liveOff':
          eng.liveOff(m.channel, m.key);
          break;
        case 'panic':
          eng.panic();
          break;
        case 'watch':
          eng.watch(m.channel);
          break;
      }
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    try {
      this.engine.process(L, R, L.length);
    } catch (err) {
      this.port.postMessage({ type: 'error', error: String(err) });
      this.engine.panic();
    }
    if (++this.blocks % 10 === 0) this.port.postMessage({ type: 'status', status: this.engine.status() });
    return true;
  }
}

registerProcessor('musiclabs', MusicLabsProcessor);
