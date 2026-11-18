// Instrumentos multi-sample a partir de pastas de samples (como os instrumentos
// dos packs do FL Studio instalados: um WAV por região do teclado). A raiz de
// cada sample vem do bloco smpl, do nome do arquivo ou da detecção de afinação.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { SampleData, SampleSet, SampleZone } from '../core/instruments.js';
import { detectPitch, fixNumberedSequence, noteFromName } from '../core/pitch.js';
import { decodeWav, encodeSampleWav } from '../core/wav.js';
import { AUDIO_EXT, FL_DIR, loadSample, riffMetaOf, toWavBytes } from './samples.js';

const MAX_ZONES = 24; // limite de arquivos carregados por instrumento
const MAX_SECONDS = 7; // samples sem loop são cortados (com fade) neste tempo

export type Category = 'drum' | 'instrument' | 'loop' | 'fx' | 'other';

export interface Suggest {
  oneshot: boolean;
  loop: boolean;
  keytrack: boolean;
  root?: number;
  a?: number;
  r?: number;
}

export interface SourceInfo {
  kind: 'file' | 'set';
  path: string;
  name: string;
  category: Category;
  suggest: Suggest;
  root?: number;
  hasLoop?: boolean;
  durationSec?: number;
  zones?: { i: number; file: string; root: number; lo: number; hi: number; vlo: number; vhi: number; loop: boolean }[];
  rootSource?: 'smpl' | 'nome' | 'afinação';
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function audioFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()) && !f.startsWith('.'))
      .sort(natural)
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Pasta de instrumento para um caminho: a própria pasta, ou a pasta irmã de um .fst. */
export function setFolder(path: string): string | null {
  try {
    if (/\.fst$/i.test(path)) {
      const dir = join(dirname(path), basename(path, extname(path)));
      return existsSync(dir) && statSync(dir).isDirectory() && audioFiles(dir).length ? dir : null;
    }
    if (existsSync(path) && statSync(path).isDirectory()) return audioFiles(path).length ? path : null;
  } catch {
    /* sem acesso */
  }
  return null;
}

export function categoryOf(path: string): Category {
  const p = path.toLowerCase();
  if (/\/(drums?|kicks?|snares?|hats?|claps?|percussion|cymbals?|toms?)\b|kick|snare|hi-?hat|\bclap|\bperc|\b808\b|\brim\b|cymbal|crash|ride\b/.test(p)) return 'drum';
  if (/\/loops?\//.test(p) || /\bloop\b|\d{2,3} ?bpm/.test(p)) return 'loop';
  if (/\/(sfx|risers?|fx)\//.test(p) || /riser|impact|sweep|downlifter|uplifter/.test(p)) return 'fx';
  if (/\/instruments?\/|piano|grand|rhodes|keys|organ|strings?|violin|cello|choir|brass|horn|trumpet|flute|woodwind|clarinet|guitar|bass|pad\b|synth|lead|pluck|bell|marimba|harp/.test(p)) return 'instrument';
  return 'other';
}

function suggestFor(cat: Category, hasLoop: boolean, path: string): Suggest {
  const p = path.toLowerCase();
  if (cat !== 'instrument') return { oneshot: true, loop: false, keytrack: cat !== 'loop' };
  const r = /string|choir|pad|brass|woodwind|organ|flute/.test(p) ? 0.45 : /piano|grand|keys|rhodes|electric/.test(p) ? 0.35 : /bass/.test(p) ? 0.12 : 0.25;
  return { oneshot: false, loop: hasLoop, keytrack: true, a: 0.002, r };
}

// ---------------------------------------------------------------- conjuntos

interface Built {
  set: SampleSet;
  data: SampleData[];
  info: SourceInfo;
}

const built = new Map<string, Promise<Built>>();

function truncate(s: SampleData): SampleData {
  if (s.loop) {
    // mantém até o fim do loop (mais um pouco de cauda)
    const end = Math.min(s.ch[0].length, s.loop[1] + Math.round(s.sr * 0.5));
    return end < s.ch[0].length ? { ...s, ch: s.ch.map((c) => c.slice(0, end)) } : s;
  }
  const max = Math.round(s.sr * MAX_SECONDS);
  if (s.ch[0].length <= max) return s;
  const fade = Math.round(s.sr * 0.25);
  const ch = s.ch.map((c) => {
    const out = c.slice(0, max);
    for (let i = 0; i < fade; i++) out[max - fade + i] *= 1 - i / fade;
    return out;
  });
  return { ...s, ch };
}

function peakOf(s: SampleData) {
  let m = 0;
  const c = s.ch[0];
  const n = Math.min(c.length, s.sr * 2);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(c[i]));
  return m;
}

async function decodeFile(path: string): Promise<SampleData> {
  return decodeWav(await toWavBytes(path));
}

async function buildSet(dir: string): Promise<Built> {
  let files = audioFiles(dir);
  if (files.length > MAX_ZONES) {
    const step = files.length / MAX_ZONES;
    files = Array.from({ length: MAX_ZONES }, (_, i) => files[Math.min(files.length - 1, Math.round(i * step + step / 2 - 0.5))]);
  }
  const metas = files.map((f) => riffMetaOf(f));
  const smplRoots = metas.map((m) => m?.root);
  const distinctSmpl = new Set(smplRoots.filter((r) => r !== undefined).map((r) => Math.round(r!))).size;
  const smplOk = smplRoots.every((r) => r !== undefined) && (files.length === 1 || distinctSmpl >= Math.max(2, Math.ceil(files.length * 0.5)));
  const nameRoots = files.map((f) => noteFromName(basename(f)));
  const nameOk = !smplOk && nameRoots.every((r) => r !== null) && new Set(nameRoots).size >= Math.max(2, Math.ceil(files.length * 0.5));
  const datas: SampleData[] = [];
  const detected: (number | null)[] = [];
  let metaOverridden = false;
  const baseSource: SourceInfo['rootSource'] = smplOk ? 'smpl' : nameOk ? 'nome' : 'afinação';
  for (let i = 0; i < files.length; i++) {
    const full = await decodeFile(files[i]);
    const mono = full.ch.length > 1 ? full.ch[0].map((v, k) => (v + full.ch[1][k]) * 0.5) : full.ch[0];
    const pr = detectPitch(mono, full.sr);
    detected.push(pr && pr.clarity > 0.8 ? pr.midi : null);
    datas.push(truncate(full));
  }
  let roots: number[];
  if (smplOk || nameOk) {
    roots = (smplOk ? smplRoots : nameRoots).map((r) => r as number);
    // Se a maioria das medições confiáveis discorda dos metadados, eles estão errados
    // (há packs com smpl uma oitava fora, ou com F marcado onde o áudio é F#).
    let measured = 0;
    let disagree = 0;
    roots.forEach((r, i) => {
      const d = detected[i];
      if (d === null) return;
      measured++;
      if (Math.abs(d - r) > 0.6) disagree++;
    });
    if (measured >= 3 && disagree >= measured * 0.5) {
      roots = roots.map((r, i) => detected[i] ?? r);
      metaOverridden = true;
    }
  } else {
    roots = detected.map((d) => d ?? 60);
    // Pastas numeradas: a nota acompanha o número do arquivo.
    const nums = files.map((f) => Number(/(\d+)\D*$/.exec(basename(f, extname(f)))?.[1] ?? NaN));
    if (nums.every((x) => Number.isFinite(x)) && new Set(nums).size === nums.length) roots = fixNumberedSequence(nums, roots);
  }
  roots.forEach((r, i) => (datas[i].root = r));
  const source: SourceInfo['rootSource'] = metaOverridden ? 'afinação' : baseSource;
  // Zonas: raízes iguais viram camadas de velocity (ordenadas pelo volume).
  const groups = new Map<number, number[]>();
  roots.forEach((r, i) => {
    const k = Math.round(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  });
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const zones: SampleZone[] = [];
  const infoZones: NonNullable<SourceInfo['zones']> = [];
  keys.forEach((k, gi) => {
    const lo = gi === 0 ? 0 : Math.floor((keys[gi - 1] + k) / 2) + 1;
    const hi = gi === keys.length - 1 ? 127 : Math.floor((k + keys[gi + 1]) / 2);
    const idx = groups.get(k)!.sort((a, b) => peakOf(datas[a]) - peakOf(datas[b]));
    idx.forEach((fi, li) => {
      const vlo = li / idx.length;
      const vhi = li === idx.length - 1 ? 1 : (li + 1) / idx.length - 1e-6;
      zones.push({ key: `${dir}#${fi}`, root: roots[fi], lo, hi, vlo, vhi });
      infoZones.push({ i: fi, file: basename(files[fi]), root: Math.round(roots[fi] * 100) / 100, lo, hi, vlo, vhi, loop: !!datas[fi].loop });
    });
  });
  const hasLoop = datas.some((d) => !!d.loop);
  const name = basename(dir);
  const info: SourceInfo = {
    kind: 'set',
    path: dir,
    name,
    category: 'instrument',
    suggest: suggestFor('instrument', hasLoop, dir),
    hasLoop,
    zones: infoZones,
    rootSource: source,
  };
  return { set: { name, zones }, data: datas, info };
}

export function getSet(dir: string): Promise<Built> {
  let p = built.get(dir);
  if (!p) {
    p = buildSet(dir);
    built.set(dir, p);
    p.catch(() => built.delete(dir));
    if (built.size > 6) built.delete(built.keys().next().value!);
  }
  return p;
}

export async function zoneWav(dir: string, i: number): Promise<Uint8Array> {
  const b = await getSet(dir);
  const d = b.data[i];
  if (!d) throw new Error(`Zona ${i} inexistente`);
  return encodeSampleWav(d);
}

// ---------------------------------------------------------------- informação

export async function sourceInfo(path: string): Promise<SourceInfo> {
  const dir = setFolder(path);
  if (dir) return (await getSet(dir)).info;
  const meta = riffMetaOf(path);
  let cat = categoryOf(path);
  const nameRoot = noteFromName(basename(path));
  if (cat === 'other' && (meta?.loop || meta?.root !== undefined || nameRoot !== null)) cat = 'instrument';
  const hasLoop = !!meta?.loop;
  const s: SourceInfo = { kind: 'file', path, name: basename(path, extname(path)), category: cat, suggest: suggestFor(cat, hasLoop, path), hasLoop };
  let root = meta?.root ?? nameRoot ?? undefined;
  if (root !== undefined) s.rootSource = meta?.root !== undefined ? 'smpl' : 'nome';
  if (cat === 'instrument') {
    try {
      const data = await loadSample(path);
      s.durationSec = Math.round((data.ch[0].length / data.sr) * 100) / 100;
      const mono = data.ch.length > 1 ? data.ch[0].map((v, k) => (v + data.ch[1][k]) * 0.5) : data.ch[0];
      const pr = detectPitch(mono, data.sr);
      // Medição confiável vence metadado divergente (há packs com smpl errado).
      if (pr && pr.clarity >= 0.9 && (root === undefined || Math.abs(pr.midi - root) > 0.6)) {
        root = pr.midi;
        s.rootSource = 'afinação';
      }
    } catch {
      /* sem decodificar: fica com o que tiver */
    }
  }
  if (root !== undefined) {
    s.root = Math.round(root * 100) / 100;
    s.suggest.root = s.root;
  }
  return s;
}

/** Parâmetros de sampler sugeridos para um caminho (sem sobrescrever o que já foi pedido). */
export async function samplerParamsFor(path: string, given: Record<string, unknown> = {}) {
  const info = await sourceInfo(path);
  const sg = info.suggest;
  const out: Record<string, unknown> = { sample: info.kind === 'set' ? info.path : path, oneshot: sg.oneshot, loop: sg.loop, keytrack: sg.keytrack };
  if (sg.root !== undefined) out.root = sg.root;
  if (sg.a !== undefined) out.a = sg.a;
  if (sg.r !== undefined) out.r = sg.r;
  if (!sg.oneshot) {
    out.d = 8;
    out.s = 1;
  }
  return { info, params: { ...out, ...given } };
}

// ---------------------------------------------------------------- instrumentos locais

export interface LocalInstrument {
  name: string;
  category: string;
  path: string;
}

let localInst: LocalInstrument[] | null = null;

/** Instrumentos multi-sample dos packs do FL instalados (Packs/Instruments/<categoria>/<nome>). */
export function localInstruments(): LocalInstrument[] {
  if (localInst) return localInst;
  localInst = [];
  const base = join(FL_DIR, 'Data/Patches/Packs/Instruments');
  try {
    for (const cat of readdirSync(base).sort(natural)) {
      const cdir = join(base, cat);
      if (!statSync(cdir).isDirectory()) continue;
      for (const n of readdirSync(cdir).sort(natural)) {
        const d = join(cdir, n);
        if (statSync(d).isDirectory() && audioFiles(d).length) localInst.push({ name: n, category: cat, path: d });
      }
    }
  } catch {
    /* FL não instalado */
  }
  return localInst;
}

export function localInstrument(name: string): LocalInstrument | undefined {
  const n = name.toLowerCase().trim();
  return localInstruments().find((i) => i.name.toLowerCase() === n);
}

/** Pontos de loop no primeiro arquivo da pasta (leitura rápida, síncrona). */
export function folderHasLoops(dir: string): boolean {
  const f = audioFiles(dir)[0];
  return !!(f && riffMetaOf(f)?.loop);
}
