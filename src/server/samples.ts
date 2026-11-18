// Carregamento de samples no Node via ffmpeg (qualquer formato -> WAV float).
// Também resolve caminhos vindos do FL Studio/Wine para caminhos Linux.

import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
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

export interface RiffMeta {
  tag: number;
  /** Nota raiz (MIDI fracionário) do bloco smpl, se houver. */
  root?: number;
  /** Primeiro loop de sustentação do bloco smpl, em frames. */
  loop?: [number, number];
}

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Lê o cabeçalho RIFF/WAVE: format tag e bloco smpl (raiz e loop). */
export function riffMeta(buf: Uint8Array): RiffMeta | null {
  if (buf.length < 12 || fourcc(buf, 0) !== 'RIFF' || fourcc(buf, 8) !== 'WAVE') return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const meta: RiffMeta = { tag: 1 };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = fourcc(buf, o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 10 <= buf.length) meta.tag = dv.getUint16(o + 8, true);
    if (id === 'smpl' && size >= 36 && o + 8 + 36 <= buf.length) {
      const unity = dv.getUint32(o + 8 + 12, true);
      const frac = dv.getUint32(o + 8 + 16, true);
      const nloops = dv.getUint32(o + 8 + 28, true);
      if (unity > 0 && unity < 128) meta.root = unity + frac / 4294967296;
      if (nloops > 0 && o + 8 + 36 + 24 <= buf.length) {
        const ls = dv.getUint32(o + 8 + 36 + 8, true);
        const le = dv.getUint32(o + 8 + 36 + 12, true);
        if (le > ls + 16) meta.loop = [ls, le];
      }
    }
    o += 8 + size + (size & 1);
  }
  return meta;
}

/** Metadados sem carregar o arquivo inteiro: lê só os cabeçalhos dos blocos. */
export function riffMetaOf(path: string): RiffMeta | null {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(12);
    readSync(fd, head, 0, 12, 0);
    if (fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'WAVE') return null;
    // Remonta um RIFF só com os blocos pequenos (fmt, smpl) e o cabeçalho do data.
    const parts: Buffer[] = [head];
    let o = 12;
    const h = Buffer.alloc(8);
    while (o + 8 <= size) {
      readSync(fd, h, 0, 8, o);
      const id = fourcc(h, 0);
      const len = h.readUInt32LE(4);
      if (id === 'fmt ' || id === 'smpl') {
        const body = Buffer.alloc(Math.min(len, 4096));
        readSync(fd, body, 0, body.length, o + 8);
        const hh = Buffer.from(h);
        hh.writeUInt32LE(body.length, 4);
        parts.push(hh, body);
        if (body.length & 1) parts.push(Buffer.alloc(1));
      }
      o += 8 + len + (len & 1);
    }
    return riffMeta(new Uint8Array(Buffer.concat(parts)));
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

const OGG_TAGS = [0x674f, 0x6750, 0x6751, 0x676f, 0x6770, 0x6771];

/**
 * Alguns WAV (como os packs de fábrica do FL Studio) guardam Ogg Vorbis dentro
 * do RIFF (format tag 0x674F...). Esse Ogg traz um segundo fluxo lógico
 * intercalado que faz o ffmpeg parar no meio; ficamos só com as páginas do
 * primeiro fluxo (o áudio).
 */
export function embeddedOgg(buf: Uint8Array): Uint8Array | null {
  if (buf.length < 44 || fourcc(buf, 0) !== 'RIFF') return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 12;
  let tag = 0;
  while (o + 8 <= buf.length) {
    const id = fourcc(buf, o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') tag = dv.getUint16(o + 8, true);
    if (id === 'data') {
      if (!OGG_TAGS.includes(tag)) return null;
      const data = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
      let i = -1;
      for (let k = 0; k + 4 <= data.length; k++)
        if (data[k] === 0x4f && data[k + 1] === 0x67 && data[k + 2] === 0x67 && data[k + 3] === 0x53) {
          i = k;
          break;
        }
      if (i < 0) return null;
      const out: Uint8Array[] = [];
      let first: number | null = null;
      const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      while (i + 27 <= data.length && fourcc(data, i) === 'OggS') {
        const serial = ddv.getUint32(i + 14, true);
        const nseg = data[i + 26];
        let body = 0;
        for (let k = 0; k < nseg; k++) body += data[i + 27 + k];
        const end = i + 27 + nseg + body;
        if (end > data.length) break;
        if (first === null) first = serial;
        if (serial === first) out.push(data.subarray(i, end));
        i = end;
      }
      const total = out.reduce((a, b) => a + b.length, 0);
      const joined = new Uint8Array(total);
      let w = 0;
      for (const part of out) {
        joined.set(part, w);
        w += part.length;
      }
      return joined;
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

/**
 * Corrige os tamanhos do WAV que o ffmpeg escreve em pipe (desconhecidos) e
 * anexa um bloco smpl com raiz e loop, para o navegador e o render receberem
 * os mesmos metadados que o arquivo original.
 */
export function finalizeWav(wav: Uint8Array, meta: RiffMeta | null): Uint8Array {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let o = 12;
  let dataAt = -1;
  while (o + 8 <= wav.length) {
    if (fourcc(wav, o) === 'data') {
      dataAt = o;
      break;
    }
    o += 8 + dv.getUint32(o + 4, true) + (dv.getUint32(o + 4, true) & 1);
  }
  if (dataAt < 0) return wav;
  let dataLen = wav.length - dataAt - 8;
  dataLen -= dataLen % 8; // frames inteiros (estéreo float32)
  const hasSmpl = !!meta && (meta.root !== undefined || meta.loop !== undefined);
  const smplLen = hasSmpl ? 36 + (meta!.loop ? 24 : 0) : 0;
  const out = new Uint8Array(dataAt + 8 + dataLen + (hasSmpl ? 8 + smplLen : 0));
  out.set(wav.subarray(0, dataAt + 8 + dataLen));
  const odv = new DataView(out.buffer);
  odv.setUint32(dataAt + 4, dataLen, true);
  if (hasSmpl) {
    let p = dataAt + 8 + dataLen;
    out.set([0x73, 0x6d, 0x70, 0x6c], p); // "smpl"
    odv.setUint32(p + 4, smplLen, true);
    p += 8;
    const root = meta!.root ?? 60;
    odv.setUint32(p + 12, Math.floor(root), true);
    odv.setUint32(p + 16, Math.round((root - Math.floor(root)) * 4294967295), true);
    odv.setUint32(p + 28, meta!.loop ? 1 : 0, true);
    if (meta!.loop) {
      odv.setUint32(p + 36 + 8, meta!.loop[0], true);
      odv.setUint32(p + 36 + 12, meta!.loop[1], true);
    }
  }
  odv.setUint32(4, out.length - 8, true);
  return out;
}

/** Converte qualquer áudio em WAV float32 estéreo (bytes), com smpl quando houver. */
export function toWavBytes(path: string): Promise<Uint8Array> {
  let ogg: Uint8Array | null = null;
  let meta: RiffMeta | null = null;
  if (/\.wav$/i.test(path)) {
    try {
      const raw = new Uint8Array(readFileSync(path));
      meta = riffMeta(raw);
      ogg = embeddedOgg(raw);
    } catch {
      ogg = null;
    }
  }
  return new Promise((resolve, reject) => {
    const input = ogg ? ['-f', 'ogg', '-i', 'pipe:0'] : ['-i', path];
    const ff = spawn('ffmpeg', ['-v', 'error', ...input, '-vn', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'wav', '-'], { stdio: [ogg ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    ff.stdout!.on('data', (c) => chunks.push(c));
    ff.stderr!.on('data', (c) => (err += c));
    ff.on('error', reject);
    if (ogg) {
      ff.stdin!.on('error', () => {});
      ff.stdin!.end(Buffer.from(ogg.buffer, ogg.byteOffset, ogg.byteLength));
    }
    ff.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) reject(new Error(`ffmpeg falhou em ${path}: ${err.slice(0, 300)}`));
      else resolve(finalizeWav(new Uint8Array(Buffer.concat(chunks)), meta));
    });
  });
}

/** Cache LRU limitado por bytes (samples longos ocupam muita memória). */
class ByteLru<V> {
  private map = new Map<string, { v: Promise<V>; bytes: number }>();
  private total = 0;
  constructor(private limit: number, private size: (v: V) => number) {}
  get(k: string) {
    const e = this.map.get(k);
    if (e) {
      this.map.delete(k);
      this.map.set(k, e);
    }
    return e?.v;
  }
  set(k: string, v: Promise<V>) {
    const e = { v, bytes: 0 };
    this.map.set(k, e);
    v.then((val) => {
      if (this.map.get(k) !== e) return;
      e.bytes = this.size(val);
      this.total += e.bytes;
      for (const [key, old] of this.map) {
        if (this.total <= this.limit || key === k) break;
        this.map.delete(key);
        this.total -= old.bytes;
      }
    }).catch(() => {
      if (this.map.get(k) === e) this.map.delete(k);
    });
  }
}

const wavCache = new ByteLru<Uint8Array>(200e6, (b) => b.byteLength);
const cache = new ByteLru<SampleData>(300e6, (s) => s.ch.reduce((a, c) => a + c.byteLength, 0));

export function wavFor(path: string): Promise<Uint8Array> {
  let p = wavCache.get(path);
  if (!p) {
    p = toWavBytes(path);
    wavCache.set(path, p);
  }
  return p;
}

export function loadSample(path: string): Promise<SampleData> {
  let p = cache.get(path);
  if (!p) {
    p = wavFor(path).then(decodeWav);
    cache.set(path, p);
  }
  return p;
}
