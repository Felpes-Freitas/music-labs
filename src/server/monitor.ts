// Retorno nativo do amp (Linux/PipeWire): entrada → cadeia de efeitos → saída, fora
// do navegador. O Chromium soma dezenas de ms de fila entre o microfone e a saída;
// aqui o caminho é pw-record → Node (mesmo código de efeitos do app) → pw-play, com o
// tamanho de bloco escolhido pelo usuário. A gravação continua no app (sinal cru).

import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { createEffect, type Fx } from '../core/effects.js';
import type { EffectType, Params } from '../core/model.js';

export interface MonitorConfig {
  /** Tamanho do bloco pedido ao PipeWire (amostras). */
  buffer: number;
  /** Nó de entrada do PipeWire (node.name); vazio = padrão do sistema. */
  source: string;
  pick: 'stereo' | 'left' | 'right';
  inGain: number; // dB
  outGain: number; // dB
  bpm: number;
  chain: { id: string; type: EffectType; enabled: boolean; mix: number; params: Params }[];
}

const SR = 48000;
let rec: ChildProcess | null = null;
let play: ChildProcess | null = null;
let cfg: MonitorConfig | null = null;
let slots: { id: string; type: EffectType; fx: Fx }[] = [];
let leftover: Buffer = Buffer.alloc(0);
let dropped = 0;
let running = false;
let gen = 0; // cada início do retorno tem um número: processos antigos não mexem nos novos
const startedWith = { buffer: 0, source: '' };

function applyChain(c: MonitorConfig) {
  const old = new Map(slots.map((s) => [s.id, s]));
  slots = c.chain.map((e) => {
    const prev = old.get(e.id);
    if (prev && prev.type === e.type) {
      prev.fx.setParams(e.params);
      return prev;
    }
    return { id: e.id, type: e.type, fx: createEffect(SR, e.type, e.params) };
  });
}

/** Processa um pedaço de áudio intercalado (f32 estéreo) e devolve o resultado. */
function processChunk(buf: Buffer): Buffer {
  const c = cfg!;
  const frames = buf.length >> 3;
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const gi = Math.pow(10, c.inGain / 20), go = Math.pow(10, c.outGain / 20);
  for (let i = 0; i < frames; i++) {
    const l = buf.readFloatLE(i * 8), r = buf.readFloatLE(i * 8 + 4);
    const x = c.pick === 'left' ? l : c.pick === 'right' ? r : 0;
    L[i] = (c.pick === 'stereo' ? l : x) * gi;
    R[i] = (c.pick === 'stereo' ? r : x) * gi;
  }
  const ctx = { sr: SR, bpm: c.bpm, insertBus: () => undefined, beat: 0 };
  const byId = new Map(c.chain.map((e) => [e.id, e]));
  // blocos de até 128 amostras (alguns efeitos têm estado pensado para isso)
  for (let a = 0; a < frames; a += 128) {
    const n = Math.min(128, frames - a);
    const l = L.subarray(a, a + n), r = R.subarray(a, a + n);
    for (const s of slots) {
      const e = byId.get(s.id);
      if (!e?.enabled) continue;
      if (e.mix >= 0.999) s.fx.process(l, r, n, ctx);
      else {
        const dl = l.slice(), dr = r.slice();
        s.fx.process(l, r, n, ctx);
        for (let i = 0; i < n; i++) {
          l[i] = l[i] * e.mix + dl[i] * (1 - e.mix);
          r[i] = r[i] * e.mix + dr[i] * (1 - e.mix);
        }
      }
    }
  }
  const out = Buffer.allocUnsafe(frames * 8);
  for (let i = 0; i < frames; i++) {
    out.writeFloatLE(Math.max(-1, Math.min(1, L[i] * go)), i * 8);
    out.writeFloatLE(Math.max(-1, Math.min(1, R[i] * go)), i * 8 + 4);
  }
  return out;
}

export function monitorStatus() {
  return { available: process.platform === 'linux', running, buffer: cfg?.buffer ?? 0, ms: cfg ? +((cfg.buffer / SR) * 1000).toFixed(2) : 0, dropped };
}

/** Encerra um processo do retorno de verdade (o pw-play ignora SIGINT com a entrada aberta). */
function kill(cp: ChildProcess | null) {
  if (!cp || cp.exitCode !== null) return;
  try {
    cp.stdin?.end();
  } catch {
    /* já fechado */
  }
  cp.kill('SIGTERM');
  setTimeout(() => cp.exitCode === null && cp.kill('SIGKILL'), 400);
}

export function stopMonitor() {
  running = false;
  kill(rec);
  kill(play);
  rec = play = null;
  leftover = Buffer.alloc(0);
}

/**
 * Retornos que sobraram de um servidor anterior (fechado sem limpar) continuam
 * tocando por cima do novo. Na primeira vez, mata os pw-play/pw-record do retorno
 * que não são filhos deste processo.
 */
let swept = false;
function sweepOrphans() {
  if (swept || process.platform !== 'linux') return;
  swept = true;
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(pw-play|pw-record)\s.*musiclabs-retorno/);
      if (m && Number(m[2]) !== process.pid) process.kill(Number(m[1]), 'SIGKILL');
    }
  } catch {
    /* sem ps: segue */
  }
}

/** Liga (ou atualiza) o retorno. Mudar o bloco ou a entrada reinicia os processos. */
export function startMonitor(c: MonitorConfig) {
  cfg = { ...c, buffer: Math.max(16, Math.min(2048, Math.round(c.buffer))) };
  applyChain(cfg);
  if (running && startedWith.buffer === cfg.buffer && startedWith.source === cfg.source) return monitorStatus();
  sweepOrphans();
  stopMonitor();
  const lat = String(cfg.buffer); // em amostras (pw-cat não entende "n/taxa")
  const common = ['--format', 'f32', '--channels', '2', '--rate', String(SR), '--latency', lat];
  rec = spawn('pw-record', [...common, ...(cfg.source ? ['--target', cfg.source] : []), '-P', '{ node.name = "musiclabs-retorno-in" node.description = "Music Labs (retorno)" node.group = "musiclabs-retorno" }', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  play = spawn('pw-play', [...common, '-P', '{ node.name = "musiclabs-retorno-out" node.description = "Music Labs (retorno)" node.group = "musiclabs-retorno" }', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  startedWith.buffer = cfg.buffer;
  startedWith.source = cfg.source;
  running = true;
  dropped = 0;
  const my = ++gen;
  const p = play;
  // reserva de um bloco de silêncio na saída: absorve a variação de tempo do caminho
  p.stdin!.write(Buffer.alloc(cfg.buffer * 8));
  rec.stdout!.on('data', (chunk: Buffer) => {
    if (!running || my !== gen || !p.stdin || p.stdin.destroyed) return;
    let buf: Buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % 8);
    leftover = buf.subarray(usable);
    buf = buf.subarray(0, usable);
    if (!usable) return;
    // se a saída atrasou (fila crescendo), descarta para o atraso não acumular
    if (p.stdin.writableLength > cfg!.buffer * 8 * 4) {
      dropped++;
      return;
    }
    p.stdin.write(processChunk(buf));
  });
  const onExit = () => running && my === gen && stopMonitor();
  rec.on('exit', onExit);
  play.on('exit', onExit);
  play.stdin!.on('error', () => {});
  return monitorStatus();
}

/** Entradas de áudio do PipeWire (para escolher a do retorno). */
export function monitorSources(): Promise<{ name: string; description: string }[]> {
  return new Promise((ok) =>
    execFile('pw-dump', [], { maxBuffer: 64 * 1024 * 1024, timeout: 4000 }, (_e, out) => {
      try {
        const nodes = JSON.parse(String(out)) as { type: string; info?: { props?: Record<string, string> } }[];
        ok(
          nodes
            .filter((n) => n.type === 'PipeWire:Interface:Node' && n.info?.props?.['media.class'] === 'Audio/Source')
            .map((n) => ({ name: n.info!.props!['node.name'], description: n.info!.props!['node.description'] ?? n.info!.props!['node.name'] })),
        );
      } catch {
        ok([]);
      }
    }),
  );
}

process.once('exit', () => {
  rec?.kill('SIGKILL');
  play?.kill('SIGKILL');
});
