// AudioWorklet: roda a engine do Music Labs na thread de áudio do navegador.
import { Engine } from '../core/engine';
import { applyOps } from '../core/ops';
import { createEffect, type Fx } from '../core/effects';
import type { EffectType } from '../core/model';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  port: MessagePort;
}
declare const currentTime: number;

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

registerProcessor('batuque', MusicLabsProcessor);

/** Gravador: repassa os blocos de entrada (microfone) para a interface. */
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]) {
    const inp = inputs[0];
    if (inp && inp.length) this.port.postMessage(inp.map((c) => c.slice()));
    return true;
  }
}
registerProcessor('ml-recorder', RecorderProcessor);

/**
 * Amp de guitarra: recebe a entrada de áudio, passa pela cadeia de efeitos e
 * devolve o som processado (para ouvir e para gravar). Também manda medidores e
 * o contorno da onda para o visualizador.
 */
interface AmpSlot { id: string; type: EffectType; enabled: boolean; mix: number; fx: Fx }
class AmpProcessor extends AudioWorkletProcessor {
  chain: AmpSlot[] = [];
  inGain = 1;
  outGain = 1;
  pick: 'stereo' | 'left' | 'right' = 'stereo';
  bpm = 120;
  L = new Float32Array(128);
  R = new Float32Array(128);
  dl = new Float32Array(128);
  dr = new Float32Array(128);
  inPk = 0;
  outPk = 0;
  frames = 0;
  wIn: number[] = [];
  wOut: number[] = [];
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type !== 'config') return;
      this.inGain = Math.pow(10, (m.inGain ?? 0) / 20);
      this.outGain = Math.pow(10, (m.outGain ?? 0) / 20);
      this.pick = m.pick ?? 'stereo';
      this.bpm = m.bpm ?? 120;
      const old = new Map(this.chain.map((c) => [c.id, c]));
      this.chain = (m.chain as { id: string; type: EffectType; enabled: boolean; mix: number; params: Record<string, unknown> }[]).map((c) => {
        const prev = old.get(c.id);
        let fx: Fx;
        if (prev && prev.type === c.type) {
          fx = prev.fx;
          fx.setParams(c.params as any);
        } else fx = createEffect(sampleRate, c.type, c.params as any);
        return { id: c.id, type: c.type, enabled: c.enabled, mix: c.mix, fx };
      });
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0]?.length ?? 128;
    if (this.L.length < n) {
      this.L = new Float32Array(n);
      this.R = new Float32Array(n);
      this.dl = new Float32Array(n);
      this.dr = new Float32Array(n);
    }
    const L = this.L, R = this.R;
    const a = inp?.[0], b = inp?.[1] ?? inp?.[0];
    for (let i = 0; i < n; i++) {
      const l = a ? a[i] : 0, r = b ? b[i] : 0;
      const x = this.pick === 'left' ? l : this.pick === 'right' ? r : 0;
      L[i] = (this.pick === 'stereo' ? l : x) * this.inGain;
      R[i] = (this.pick === 'stereo' ? r : x) * this.inGain;
      const pk = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (pk > this.inPk) this.inPk = pk;
    }
    const ctx = { sr: sampleRate, bpm: this.bpm, insertBus: () => undefined, beat: (currentTime * this.bpm) / 60 };
    for (const s of this.chain) {
      if (!s.enabled) continue;
      if (s.mix >= 0.999) s.fx.process(L, R, n, ctx);
      else {
        this.dl.set(L.subarray(0, n));
        this.dr.set(R.subarray(0, n));
        s.fx.process(L, R, n, ctx);
        for (let i = 0; i < n; i++) {
          L[i] = L[i] * s.mix + this.dl[i] * (1 - s.mix);
          R[i] = R[i] * s.mix + this.dr[i] * (1 - s.mix);
        }
      }
    }
    const oL = out[0], oR = out[1] ?? out[0];
    for (let i = 0; i < n; i++) {
      const l = L[i] * this.outGain, r = R[i] * this.outGain;
      oL[i] = l;
      oR[i] = r;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      if (pk > this.outPk) this.outPk = pk;
    }
    // contorno da onda: um pico a cada 512 amostras; envia ~20x por segundo
    this.frames += n;
    if (this.frames % 512 < n) {
      this.wIn.push(this.inPk);
      this.wOut.push(this.outPk);
      this.inPk = this.outPk = 0;
    }
    if (this.wIn.length >= 4) {
      this.port.postMessage({ type: 'meter', inp: this.wIn, out: this.wOut });
      this.wIn = [];
      this.wOut = [];
    }
    return true;
  }
}
registerProcessor('ml-amp', AmpProcessor);
