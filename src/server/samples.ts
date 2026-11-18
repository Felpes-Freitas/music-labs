// Carregamento de samples no Node via ffmpeg (qualquer formato -> WAV float).
// Também resolve caminhos vindos do FL Studio/Wine para caminhos Linux.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import type { SampleData } from '../core/instruments.js';
import { decodeWav } from '../core/wav.js';

export const WINE_C = process.env.MUSICLABS_WINE_C ?? join(homedir(), '.wine/drive_c');
export const FL_DIR = process.env.MUSICLABS_FL_DIR ?? join(WINE_C, 'Program Files/Image-Line/FL Studio 2025');
export const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff', '.m4a', '.opus', '.wv']);

function wineUserDocs(): string | null {
  const users = join(WINE_C, 'users');
  if (!existsSync(users)) return null;
  for (const u of readdirSync(users)) {
    const d = join(users, u, 'Documents/Image-Line/FL Studio');
    if (existsSync(d)) return d;
  }
  return null;
}

/** Converte "%FLStudioFactoryData%\\Patches\\..." ou "C:\\..." para caminho local. */
export function resolveFlPath(p: string): string {
  if (!p) return p;
  let s = p.replace(/\\/g, '/');
  const docs = wineUserDocs();
  s = s
    .replace(/^%FLStudioFactoryData%/i, join(FL_DIR, 'Data'))
    .replace(/^%FLStudioData%/i, join(FL_DIR, 'Data'))
    .replace(/^%FLStudioFactory%/i, FL_DIR)
    .replace(/^%FLStudioUserData%/i, docs ?? join(FL_DIR, 'Data'));
  const drive = /^([A-Za-z]):\//.exec(s);
  if (drive) s = drive[1].toLowerCase() === 'z' ? s.slice(2) : join(WINE_C, s.slice(3));
  if (existsSync(s)) return s;
  // Fallback: procura pelo nome de arquivo nas pastas de packs do FL.
  const alt = findByName(basename(s));
  return alt ?? s;
}

let nameIndex: Map<string, string> | null = null;
function findByName(name: string): string | null {
  if (!nameIndex) {
    nameIndex = new Map();
    const roots = [join(FL_DIR, 'Data/Patches'), wineUserDocs()].filter(Boolean) as string[];
    const walk = (d: string, depth: number) => {
      if (depth > 7) return;
      let entries: string[] = [];
      try { entries = readdirSync(d); } catch { return; }
      for (const e of entries) {
        const full = join(d, e);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, depth + 1);
        else if (AUDIO_EXT.has(extname(e).toLowerCase())) nameIndex!.set(e.toLowerCase(), full);
      }
    };
    for (const r of roots) walk(r, 0);
  }
  return nameIndex.get(name.toLowerCase()) ?? null;
}

/** Converte qualquer áudio em WAV float32 (bytes). Mantém taxa e até 2 canais. */
export function toWavBytes(path: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'wav', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) reject(new Error(`ffmpeg falhou em ${path}: ${err.slice(0, 300)}`));
      else resolve(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

const cache = new Map<string, Promise<SampleData>>();
const wavCache = new Map<string, Promise<Uint8Array>>();

export function wavFor(path: string): Promise<Uint8Array> {
  let p = wavCache.get(path);
  if (!p) {
    p = toWavBytes(path);
    wavCache.set(path, p);
    p.catch(() => wavCache.delete(path));
    if (wavCache.size > 400) wavCache.delete(wavCache.keys().next().value!);
  }
  return p;
}

export function loadSample(path: string): Promise<SampleData> {
  let p = cache.get(path);
  if (!p) {
    p = wavFor(path).then(decodeWav);
    cache.set(path, p);
    p.catch(() => cache.delete(path));
  }
  return p;
}
