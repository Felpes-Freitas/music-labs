// Biblioteca de samples: na primeira inicialização, varre as pastas de conteúdo
// das DAWs instaladas (FL Studio, Ableton Live, Bitwig, LMMS, Splice...) de
// acordo com o sistema operacional, inclusive dentro de prefixos do Wine no
// Linux, e guarda um índice. Os arquivos são usados no lugar onde estão:
// nada é copiado nem redistribuído.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { noteFromName } from '../core/pitch.js';

export const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff', '.m4a', '.opus', '.wv', '.caf']);

export interface LibrarySource {
  daw: string; // "FL Studio", "Ableton Live"...
  label: string; // nome para a tela
  root: string;
}

export type Category = 'drum' | 'instrument' | 'loop' | 'fx' | 'vocal' | 'other';

export interface LibraryFile {
  p: string;
  s: number; // índice da fonte
  c: Category;
}

export interface LibraryInstrument {
  name: string;
  path: string;
  s: number;
  files: number;
}

export interface LibraryIndex {
  version: 1;
  scannedAt: string;
  platform: string;
  sources: LibrarySource[];
  files: LibraryFile[];
  instruments: LibraryInstrument[];
  truncated: boolean;
}

export interface ScanEnv {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

const defaultEnv = (): ScanEnv => ({ home: homedir(), platform: osPlatform(), env: process.env });

// ---------------------------------------------------------------- caminhos

/** Expande um caminho com segmentos curinga (ex.: "Live 1*" casa "Live 12 Suite") nas pastas existentes. */
export function expand(pattern: string): string[] {
  let root: string, rest: string;
  const m = /^([A-Za-z]:)[\\/]?(.*)$/.exec(pattern);
  if (m) {
    root = m[1] + '\\';
    rest = m[2];
  } else if (pattern.startsWith('/')) {
    root = '/';
    rest = pattern.slice(1);
  } else {
    root = '';
    rest = pattern;
  }
  const parts = rest.split(/[\\/]+/);
  let cur = [root];
  for (const seg of parts) {
    if (!seg) continue;
    const next: string[] = [];
    for (const base of cur) {
      if (!seg.includes('*')) {
        const p = join(base, seg);
        if (existsSync(p)) next.push(p);
        continue;
      }
      const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      let entries: string[] = [];
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      for (const e of entries.sort().reverse()) if (re.test(e)) next.push(join(base, e));
    }
    cur = next;
    if (!cur.length) break;
  }
  return cur.filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Unidades C: de prefixos do Wine (padrão, WINEPREFIX, Bottles, Lutris, PlayOnLinux). */
export function wineDrives(e: ScanEnv): string[] {
  const h = e.home;
  const pats = [
    join(h, '.wine/drive_c'),
    ...(e.env.WINEPREFIX ? [join(e.env.WINEPREFIX, 'drive_c')] : []),
    join(h, '.local/share/wineprefixes/*/drive_c'),
    join(h, '.local/share/bottles/bottles/*/drive_c'),
    join(h, '.var/app/com.usebottles.bottles/data/bottles/bottles/*/drive_c'),
    join(h, 'Games/*/drive_c'),
    join(h, '.PlayOnLinux/wineprefix/*/drive_c'),
  ];
  const out = new Set<string>();
  for (const p of pats) for (const d of expand(p)) out.add(d);
  return [...out];
}

/** Pastas de conteúdo dentro de uma unidade C: do Windows (real ou Wine). */
function windowsCandidates(c: string, users: string[], tag: string): [string, string, string][] {
  // [daw, rótulo, padrão]
  const L: [string, string, string][] = [];
  const pf = ['Program Files', 'Program Files (x86)'];
  for (const p of pf) {
    L.push(['FL Studio', `FL Studio${tag}`, join(c, p, 'Image-Line/FL Studio*/Data/Patches/Packs')]);
    L.push(['Ableton Live', `Ableton Live${tag}`, join(c, p, 'Ableton/Live*/Resources/Core Library')]);
    L.push(['LMMS', `LMMS${tag}`, join(c, p, 'LMMS/data/samples')]);
  }
  L.push(['Ableton Live', `Ableton Live${tag}`, join(c, 'ProgramData/Ableton/Live*/Resources/Core Library')]);
  L.push(['Native Instruments', `Native Instruments${tag}`, join(c, 'Users/Public/Documents/Native Instruments')]);
  for (const u of users) {
    const docs = join(c, 'users', u, 'Documents');
    L.push(['FL Studio', `FL Studio (usuário)${tag}`, join(docs, 'Image-Line/Downloads')]);
    L.push(['Ableton Live', `Ableton (biblioteca do usuário)${tag}`, join(docs, 'Ableton/User Library')]);
    L.push(['Ableton Live', `Ableton (packs)${tag}`, join(docs, 'Ableton/Factory Packs')]);
    L.push(['Bitwig Studio', `Bitwig${tag}`, join(docs, 'Bitwig Studio/Library')]);
    L.push(['Splice', `Splice${tag}`, join(docs, 'Splice/Samples')]);
    L.push(['Splice', `Splice${tag}`, join(c, 'users', u, 'Splice/Samples')]);
  }
  return L;
}

function windowsUsers(c: string): string[] {
  for (const dir of ['users', 'Users']) {
    try {
      return readdirSync(join(c, dir)).filter((u) => !/^(public|default|default user|all users)$/i.test(u));
    } catch {
      /* tenta a outra grafia */
    }
  }
  return [];
}

/** Todas as pastas candidatas para o sistema atual (só as que existem). */
export function candidateSources(e: ScanEnv = defaultEnv()): LibrarySource[] {
  const h = e.home;
  const L: [string, string, string][] = [];
  if (e.platform === 'win32') {
    const c = (e.env.SystemDrive ?? 'C:') + '\\';
    L.push(...windowsCandidates(c, windowsUsers(c), ''));
    L.push(['Pastas do usuário', 'Música › Samples', join(h, 'Music/Samples')]);
  } else if (e.platform === 'darwin') {
    L.push(['FL Studio', 'FL Studio', '/Applications/FL Studio*.app/Contents/Resources/FL/Data/Patches/Packs']);
    L.push(['FL Studio', 'FL Studio (usuário)', join(h, 'Documents/Image-Line/Downloads')]);
    L.push(['Ableton Live', 'Ableton Live', '/Applications/Ableton Live*.app/Contents/App-Resources/Core Library']);
    L.push(['Ableton Live', 'Ableton (biblioteca do usuário)', join(h, 'Music/Ableton/User Library')]);
    L.push(['Ableton Live', 'Ableton (packs)', join(h, 'Music/Ableton/Factory Packs')]);
    L.push(['GarageBand / Logic', 'Apple Loops', '/Library/Audio/Apple Loops']);
    L.push(['GarageBand / Logic', 'Instrumentos do GarageBand', '/Library/Application Support/GarageBand/Instrument Library/Sampler/Sampler Files']);
    L.push(['Bitwig Studio', 'Bitwig', join(h, 'Documents/Bitwig Studio/Library')]);
    L.push(['Splice', 'Splice', join(h, 'Splice/Samples')]);
    L.push(['Pastas do usuário', 'Música › Samples', join(h, 'Music/Samples')]);
  } else {
    // Linux: DAWs nativas e DAWs de Windows dentro do Wine
    for (const c of wineDrives(e)) {
      const prefix = basename(dirname(c));
      const tag = prefix === '.wine' ? ' (Wine)' : ` (Wine: ${prefix})`;
      L.push(...windowsCandidates(c, windowsUsers(c), tag));
    }
    L.push(['LMMS', 'LMMS', '/usr/share/lmms/samples']);
    L.push(['LMMS', 'LMMS', '/usr/local/share/lmms/samples']);
    L.push(['LMMS', 'LMMS (Flatpak)', '/var/lib/flatpak/app/io.lmms.LMMS/current/active/files/share/lmms/samples']);
    L.push(['LMMS', 'LMMS (usuário)', join(h, 'lmms/samples')]);
    L.push(['Hydrogen', 'Hydrogen', '/usr/share/hydrogen/data/drumkits']);
    L.push(['Hydrogen', 'Hydrogen (usuário)', join(h, '.hydrogen/data/drumkits')]);
    L.push(['Bitwig Studio', 'Bitwig', join(h, 'Bitwig Studio/Library')]);
    L.push(['Splice', 'Splice', join(h, 'Splice/Samples')]);
    L.push(['Pastas do usuário', 'Música › Samples', join(h, 'Música/Samples')]);
    L.push(['Pastas do usuário', 'Music › Samples', join(h, 'Music/Samples')]);
    L.push(['Pastas do usuário', 'Samples', join(h, 'Samples')]);
  }
  const seen = new Set<string>();
  const out: LibrarySource[] = [];
  for (const [daw, label, pat] of L)
    for (const root of expand(pat)) {
      let real = root;
      try {
        real = realpathSync(root);
      } catch {
        /* mantém */
      }
      if (seen.has(real)) continue;
      seen.add(real);
      // várias versões instaladas: mostra a pasta da versão no rótulo
      const ver = /FL Studio [^/\\]+|Live [^/\\]+/.exec(root)?.[0];
      out.push({ daw, label: ver && !label.includes(ver) ? `${label} · ${ver}` : label, root });
    }
  return out;
}

// ---------------------------------------------------------------- varredura

export function categoryFor(path: string): Category {
  const p = path.toLowerCase();
  if (/\/(drums?|drum ?kits?|kicks?|snares?|hats?|hi-?hats?|claps?|percussion|cymbals?|toms?|808s?)\//.test(p) || /kick|snare|hi-?hat|\bclap|\bperc|\brim\b|cymbal|crash|\bride\b|\btom\b/.test(basename(p))) return 'drum';
  if (/\/(loops?|apple loops)\//.test(p) || /\bloop\b|\d{2,3} ?bpm/.test(p)) return 'loop';
  if (/\/(sfx|fx|risers?|impacts?|transitions?)\//.test(p) || /riser|impact|sweep|downlifter|uplifter|whoosh/.test(p)) return 'fx';
  if (/\/(vocals?|vox|voices?)\//.test(p)) return 'vocal';
  if (/\/(instruments?|multisamples?|sampler files)\//.test(p) || /piano|rhodes|organ|string|violin|cello|choir|brass|flute|guitar|bass|synth|pad|lead|bell|marimba|harp/.test(p)) return 'instrument';
  return 'other';
}

export interface ScanOptions {
  maxFiles?: number;
  maxDepth?: number;
}

/** Varre as fontes e monta o índice (assíncrono, sem travar o servidor). */
export async function scanLibrary(sources: LibrarySource[], e: ScanEnv = defaultEnv(), o: ScanOptions = {}): Promise<LibraryIndex> {
  const maxFiles = o.maxFiles ?? 400_000;
  const maxDepth = o.maxDepth ?? 14;
  const files: LibraryFile[] = [];
  const instruments: LibraryInstrument[] = [];
  const visited = new Set<string>();
  let truncated = false;
  const walk = async (dir: string, s: number, depth: number) => {
    if (depth > maxDepth || files.length >= maxFiles) {
      truncated ||= files.length >= maxFiles;
      return;
    }
    let real = dir;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const audio: string[] = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) await walk(full, s, depth + 1);
      else if (AUDIO_EXTS.has(extname(ent.name).toLowerCase())) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        audio.push(full);
        files.push({ p: full, s, c: categoryFor(full) });
      }
    }
    // Pasta com várias notas de um mesmo instrumento = instrumento multi-sample.
    if (audio.length >= 4) {
      const named = audio.filter((f) => noteFromName(basename(f)) !== null).length;
      const looksInstrument = /[\\/](instruments?|multisamples?|sampler files)[\\/]/i.test(dir + '/') && categoryFor(dir + '/x') !== 'drum';
      // coleções de sons soltos ("Hits", "Percs"...) não são um instrumento
      const generic = /^(hits?|percs?|percussion|fx|sfx|loops?|one ?shots?|pads?)$/i.test(basename(dir));
      if (named >= audio.length * 0.5 || (looksInstrument && !generic)) instruments.push({ name: basename(dir), path: dir, s, files: audio.length });
    }
  };
  for (let i = 0; i < sources.length; i++) await walk(sources[i].root, i, 0);
  return { version: 1, scannedAt: new Date().toISOString(), platform: e.platform, sources, files, instruments, truncated };
}

// ---------------------------------------------------------------- índice salvo

let index: LibraryIndex | null = null;
let scanning: Promise<LibraryIndex> | null = null;
let indexFile = '';

export function initLibrary(stateDir: string, onDone?: (ix: LibraryIndex, first: boolean) => void) {
  indexFile = join(stateDir, 'library.json');
  try {
    if (existsSync(indexFile)) index = JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch {
    index = null;
  }
  // Primeira inicialização (ou índice de outro sistema): varre em segundo plano.
  if (!index || index.platform !== osPlatform()) rescanLibrary(true, onDone);
}

export function rescanLibrary(first = false, onDone?: (ix: LibraryIndex, first: boolean) => void): Promise<LibraryIndex> {
  if (scanning) return scanning;
  scanning = scanLibrary(candidateSources())
    .then((ix) => {
      index = ix;
      try {
        mkdirSync(dirname(indexFile), { recursive: true });
        writeFileSync(indexFile, JSON.stringify(ix));
      } catch {
        /* sem disco: fica só em memória */
      }
      onDone?.(ix, first);
      return ix;
    })
    .finally(() => (scanning = null));
  return scanning;
}

export function library(): LibraryIndex | null {
  return index;
}

export function libraryStatus() {
  const ix = index;
  const bySource = ix
    ? ix.sources.map((s, i) => ({ ...s, files: ix.files.filter((f) => f.s === i).length, instruments: ix.instruments.filter((x) => x.s === i).length }))
    : [];
  return { scanning: !!scanning, scannedAt: ix?.scannedAt ?? null, files: ix?.files.length ?? 0, instruments: ix?.instruments.length ?? 0, truncated: ix?.truncated ?? false, sources: bySource };
}

/** Busca por palavras no caminho, nas fontes indexadas. */
export function searchLibrary(query: string, limit = 40, category?: Category) {
  const ix = index;
  if (!ix) return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: { name: string; path: string; source: string; category: Category }[] = [];
  for (const f of ix.files) {
    if (category && f.c !== category) continue;
    const hay = f.p.toLowerCase();
    if (words.every((w) => hay.includes(w))) {
      out.push({ name: basename(f.p), path: f.p, source: ix.sources[f.s]?.label ?? '', category: f.c });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Primeira instalação do FL Studio encontrada (pasta da versão), para resolver caminhos de .flp. */
export function findFlInstall(e: ScanEnv = defaultEnv()): string | null {
  const pats: string[] = [];
  if (e.platform === 'win32') pats.push('C:/Program Files/Image-Line/FL Studio*', 'C:/Program Files (x86)/Image-Line/FL Studio*');
  else if (e.platform === 'darwin') pats.push('/Applications/FL Studio*.app/Contents/Resources/FL');
  else for (const c of wineDrives(e)) pats.push(join(c, 'Program Files/Image-Line/FL Studio*'), join(c, 'Program Files (x86)/Image-Line/FL Studio*'));
  for (const p of pats) for (const d of expand(p)) if (existsSync(join(d, 'Data/Patches'))) return d;
  return null;
}

// ---------------------------------------------------------------- árvore de samples (menus)

export interface SampleNode {
  name: string;
  dirs: SampleNode[];
  files: { n: string; p: string }[];
}

let treeCache: { key: string; out: { daw: string; tree: SampleNode }[] } | null = null;

/**
 * Samples soltos de cada programa, em árvore de pastas como estão no disco (para os
 * menus de instrumento). Fora: loops e os arquivos dos instrumentos multi-sample (esses
 * aparecem como instrumento). Várias pastas do mesmo programa viram uma árvore só.
 */
export function sampleTree(): { daw: string; tree: SampleNode }[] {
  const ix = library();
  if (!ix) return [];
  if (treeCache?.key === ix.scannedAt) return treeCache.out;
  const instDirs = ix.instruments.map((i) => i.path + sep);
  const byDaw = new Map<string, SampleNode>();
  for (const f of ix.files) {
    if (f.c === 'loop') continue;
    if (instDirs.some((d) => f.p.startsWith(d))) continue;
    const src = ix.sources[f.s];
    if (!src) continue;
    const rel = relative(src.root, f.p);
    if (rel.startsWith('..')) continue;
    const parts = rel.split(sep);
    if (parts.length < 2) continue; // arquivo solto na raiz: sem pasta para agrupar
    // loops e músicas de demonstração não são sons para tocar no rack
    if (parts.slice(0, -1).some((d) => /loop|songs?\b|demo/i.test(d))) continue;
    let node: SampleNode = byDaw.get(src.daw) ?? { name: src.daw, dirs: [], files: [] };
    byDaw.set(src.daw, node);
    for (const d of parts.slice(0, -1)) {
      let next: SampleNode | undefined = node.dirs.find((x) => x.name === d);
      if (!next) node.dirs.push((next = { name: d, dirs: [], files: [] }));
      node = next;
    }
    node.files.push({ n: parts[parts.length - 1].replace(/\.[a-z0-9]{2,5}$/i, ''), p: f.p });
  }
  const nat = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const sortAll = (n: SampleNode) => {
    n.dirs.sort((a, b) => nat(a.name, b.name));
    n.files.sort((a, b) => nat(a.n, b.n));
    n.dirs.forEach(sortAll);
  };
  const out = [...byDaw.entries()].map(([daw, tree]) => (sortAll(tree), { daw, tree }));
  treeCache = { key: ix.scannedAt, out };
  return out;
}
