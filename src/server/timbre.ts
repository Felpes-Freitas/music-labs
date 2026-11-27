// Timbre transfer (versão crua, offline): um áudio do projeto passa por um modelo de IA
// (RAVE, do IRCAM, exportado em TorchScript) e sai soando como outro instrumento.
//
// O modelo roda num Python à parte (PyTorch só CPU) num ambiente próprio em
// STATE_DIR/timbre/venv; os modelos ficam em STATE_DIR/timbre/models/<nome>.ts. Os modelos
// prontos vêm da lista pública do IRCAM — muitos têm licença não comercial, por isso o app
// não os traz junto: o usuário baixa o que quiser.
//
// Conversão de/para WAV e reamostragem: ffmpeg (o mesmo das amostras); o Python só recebe
// e devolve float32 mono cru na taxa do modelo.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync, renameSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { STATE_DIR, RECORDINGS_DIR } from './store.js';
import { ffmpegPath } from './samples.js';

const DIR = join(STATE_DIR, 'timbre');
const MODELS = join(DIR, 'models');
const VENV = join(DIR, 'venv');
const PY = process.platform === 'win32' ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');
const API = 'https://play.forum.ircam.fr/rave-vst-api';
const NAME_OK = /^[\w.-]{1,80}$/;

const SCRIPT = String.raw`
import json, sys, time, warnings
warnings.filterwarnings("ignore")
import numpy as np
import torch
torch.set_grad_enabled(False)
if sys.argv[1] == "--info":
    m = torch.jit.load(sys.argv[2]).eval()
    print(json.dumps({"sr": int(m.sr), "channels": int(getattr(m, "n_channels", 1))}))
    sys.exit(0)
model_path, inp, out = sys.argv[1:4]
t0 = time.time()
m = torch.jit.load(model_path).eval()
x = np.fromfile(inp, dtype=np.float32)
# o modelo exportado é "streaming" (guarda estado entre chamadas): em blocos dá o mesmo
# resultado que o arquivo inteiro, com menos memória
ratio = int(m.encode_params[3]) if hasattr(m, "encode_params") else 2048
block = 2**18 - (2**18) % ratio
xx = np.concatenate([x, np.zeros((-len(x)) % ratio, dtype=np.float32)])
parts = [m(torch.from_numpy(xx[i:i + block]).reshape(1, 1, -1)).reshape(-1).numpy() for i in range(0, len(xx), block)]
np.concatenate(parts)[:len(x)].astype(np.float32).tofile(out)
print(json.dumps({"sr": int(m.sr), "seconds": round(time.time() - t0, 2)}))
`;

function scriptPath() {
  mkdirSync(DIR, { recursive: true });
  const p = join(DIR, 'timbre.py');
  writeFileSync(p, SCRIPT);
  return p;
}

function run(cmd: string, args: string[], timeoutMs = 20 * 60_000): Promise<string> {
  return new Promise((ok, fail) => {
    const cp = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', (d) => (out += d));
    cp.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => cp.kill('SIGKILL'), timeoutMs);
    cp.on('error', (e) => (clearTimeout(t), fail(e)));
    cp.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) ok(out);
      else fail(new Error(err.trim().split('\n').slice(-3).join(' ') || `${cmd} saiu com código ${code}`));
    });
  });
}

/** O ambiente Python com PyTorch está pronto? */
export async function timbreReady(): Promise<boolean> {
  if (!existsSync(PY)) return false;
  try {
    await run(PY, ['-c', 'import torch, numpy'], 60_000);
    return true;
  } catch {
    return false;
  }
}

let setupRunning: Promise<void> | null = null;
/** Cria o ambiente Python e instala PyTorch (só CPU) e numpy. Demora alguns minutos. */
export function timbreSetup(): Promise<void> {
  if (setupRunning) return setupRunning;
  setupRunning = (async () => {
    mkdirSync(DIR, { recursive: true });
    const candidates = process.platform === 'win32' ? ['py', 'python'] : ['python3.12', 'python3.11', 'python3.10', 'python3'];
    let base = '';
    for (const c of candidates) {
      try {
        const v = (await run(c, ['-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])'], 20_000)).trim();
        if (+v >= 310 && +v <= 313) {
          base = c;
          break;
        }
      } catch {
        /* tenta o próximo */
      }
    }
    if (!base) throw new Error('Precisa de Python 3.10 a 3.13 instalado no sistema');
    if (!existsSync(PY)) await run(base, ['-m', 'venv', VENV]);
    await run(PY, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip']);
    await run(PY, ['-m', 'pip', 'install', '-q', 'numpy']);
    await run(PY, ['-m', 'pip', 'install', '-q', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu']);
  })().finally(() => (setupRunning = null));
  return setupRunning;
}

let catalog: { at: number; list: { name: string; description: string; model: string }[] } | null = null;
/** Modelos: os baixados e os da lista do IRCAM (a lista fica guardada por 1 h). */
export async function timbreModels(): Promise<{ name: string; description: string; model: string; downloaded: boolean; mb?: number }[]> {
  if (!catalog || Date.now() - catalog.at > 3600_000) {
    try {
      const r = await fetch(`${API}/get_available_models`, { signal: AbortSignal.timeout(10_000) });
      const d = (await r.json()) as Record<string, { Model?: string; Description?: string }>;
      catalog = { at: Date.now(), list: Object.entries(d).filter(([, v]) => v && typeof v === 'object' && 'Model' in v).map(([name, v]) => ({ name, description: v.Description ?? '', model: v.Model ?? '' })) };
    } catch {
      catalog = catalog ?? { at: 0, list: [] };
    }
  }
  const local = existsSync(MODELS) ? readdirSync(MODELS).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)) : [];
  const names = [...new Set([...local, ...catalog.list.map((m) => m.name)])];
  return names
    .filter((n) => !n.endsWith('_onnx')) // versões ONNX não rodam aqui (o RAVE em TorchScript sim)
    .map((name) => {
      const c = catalog!.list.find((m) => m.name === name);
      const file = join(MODELS, `${name}.ts`);
      const has = existsSync(file);
      return { name, description: c?.description ?? 'modelo local', model: c?.model ?? '', downloaded: has, ...(has ? { mb: Math.round(statSync(file).size / 1e6) } : {}) };
    });
}

/** Baixa um modelo da lista do IRCAM. */
export async function timbreDownload(name: string): Promise<void> {
  if (!NAME_OK.test(name)) throw new Error('Nome de modelo inválido');
  mkdirSync(MODELS, { recursive: true });
  const dest = join(MODELS, `${name}.ts`);
  const tmp = `${dest}.part`;
  const r = await fetch(`${API}/get_model/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`Download falhou (${r.status})`);
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(tmp));
  renameSync(tmp, dest);
}

/**
 * Passa um arquivo de áudio pelo modelo e salva o resultado em ~/MusicLabs/Gravações.
 * Devolve o caminho do WAV novo (estéreo duplicado, 48 kHz, 24 bits) e o tempo gasto.
 */
export async function timbreTransfer(input: string, model: string, outName: string): Promise<{ path: string; seconds: number }> {
  if (!NAME_OK.test(model)) throw new Error('Nome de modelo inválido');
  const file = join(MODELS, `${model}.ts`);
  if (!existsSync(file)) throw new Error(`Modelo "${model}" não baixado`);
  if (!(await timbreReady())) throw new Error('Ambiente do timbre transfer não instalado');
  const script = scriptPath();
  const info = JSON.parse(await run(PY, [script, '--info', file], 120_000)) as { sr: number };
  const work = join(tmpdir(), `musiclabs-timbre-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const ff = ffmpegPath();
  try {
    const inRaw = join(work, 'in.f32'), outRaw = join(work, 'out.f32');
    await run(ff, ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', String(info.sr), '-f', 'f32le', inRaw]);
    const res = JSON.parse((await run(PY, [script, file, inRaw, outRaw])).trim().split('\n').pop()!) as { seconds: number };
    const safe = outName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    let out = join(RECORDINGS_DIR, `${safe}.wav`);
    for (let i = 2; existsSync(out); i++) out = join(RECORDINGS_DIR, `${safe} (${i}).wav`);
    await run(ff, ['-v', 'error', '-f', 'f32le', '-ar', String(info.sr), '-ac', '1', '-i', outRaw, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s24le', out]);
    return { path: out, seconds: res.seconds };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export const timbreDirs = { DIR, MODELS, VENV };
