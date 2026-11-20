// Servidor do Music Labs: guarda o projeto, sincroniza a interface por WebSocket,
// expõe a API que o MCP usa, converte samples e faz render offline.

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as A from '../core/actions.js';
import * as S from '../core/studio.js';
import { applyOps, type Op } from '../core/ops.js';
import { EFFECTS, INSTRUMENTS, PRESETS } from '../core/registry.js';
import { SCALES } from '../core/theory.js';
import { importFlp } from '../core/flp.js';
import { encodeWav } from '../core/wav.js';
import { analyzeMix } from '../core/analysis.js';
import { emptyProject } from '../core/model.js';
import { Store, listProjects, RENDERS_DIR, SAMPLES_DIR, PROJECTS_DIR, RECORDINGS_DIR, IMPORTS_DIR, STATE_DIR, safeName } from './store.js';
import { startMonitor, stopMonitor, monitorStatus, monitorSources } from './monitor.js';
import { loadSample } from './samples.js';
import { initLibrary, library, libraryStatus, rescanLibrary, searchLibrary } from './library.js';
import { AUDIO_EXT, FL_DIR, resolveFlPath, wavFor } from './samples.js';
import { renderProject } from './render.js';
import { localKit, localSample } from './localkit.js';
import { folderHasLoops, localInstrument, localInstruments, samplerParamsFor, setFolder, sourceInfo, zoneWav } from './sampleset.js';

export const PORT = Number(process.env.MUSICLABS_PORT ?? 7717);
/** Raiz do projeto: sobe até achar o package.json (funciona em src/ e em build/). */
function findRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    d = dirname(d);
  }
  return process.cwd();
}
const ROOT = findRoot();
const DIST = join(ROOT, 'dist');

const store = new Store();
let uiStatus: Record<string, unknown> = { playing: false, connected: false };
const sockets = new Set<WebSocket>();

function broadcast(msg: unknown, except?: WebSocket) {
  const s = JSON.stringify(msg);
  for (const ws of sockets) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(s);
}

store.on((m) => {
  if (m.type === 'ops') {
    // O cliente que originou já aplicou localmente; os outros recebem.
    for (const ws of sockets) if ((ws as any).clientId !== m.origin && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    if (m.origin === 'mcp' && m.label) broadcast({ type: 'toast', text: m.label, from: 'mcp' });
  } else broadcast(m);
});

// ---------------------------------------------------------------- ações

type ActionFn = (p: any, a: any) => A.ActionResult;
export const ACTIONS: Record<string, ActionFn> = {
  addChannel: A.addChannel,
  updateChannel: A.updateChannel,
  removeChannel: A.removeChannel,
  addPattern: A.addPattern,
  updatePattern: A.updatePattern,
  removePattern: A.removePattern,
  duplicatePattern: A.duplicatePattern,
  addNotes: A.addNotes,
  setSteps: A.setSteps,
  addChords: A.addChords,
  clearNotes: A.clearNotes,
  transformNotes: A.transformNotes,
  placePattern: A.placePattern,
  removeClips: A.removeClips,
  updateTrack: A.updateTrack,
  updateInsert: A.updateInsert,
  addEffect: A.addEffect,
  updateEffect: A.updateEffect,
  removeEffect: A.removeEffect,
  addChannelEffect: A.addChannelEffect,
  addAudioClip: A.addAudioClip,
  addAutomation: A.addAutomation,
  updateChannelEffect: A.updateChannelEffect,
  removeChannelEffect: A.removeChannelEffect,
  setProjectProps: A.setProjectProps,
  // estúdio (core/studio.ts)
  duplicateChannel: S.duplicateChannel,
  copyNotes: S.copyNotes,
  editClips: S.editClips,
  insertBars: S.insertBars,
  deleteBars: S.deleteBars,
  copySection: S.copySection,
  automate: S.automate,
  editAutomation: S.editAutomation,
  resetInsert: S.resetInsert,
  copyEffects: S.copyEffects,
  addAudio: S.addAudio,
  renameAudio: S.renameAudio,
  removeAudio: S.removeAudio,
  toggleAudioEdits: S.toggleAudioEdits,
  fillSteps: S.fillSteps,
  replaceInstrument: S.replaceInstrument,
};

/** "localSample": nome de um som do kit local (ex. "Kick") vira um sampler com o caminho. */
function expandLocalSample(name: string, args: any) {
  if ((name !== 'addChannel' && name !== 'updateChannel' && name !== 'replaceInstrument') || !args?.localSample) return args;
  const { localSample: wanted, ...rest } = args;
  const ls = localSample(String(wanted));
  if (ls) return { name: ls.name, ...rest, type: 'sampler', preset: undefined, params: { sample: ls.path, keytrack: true, oneshot: true, ...(ls.cut ? { cut: ls.cut } : {}), ...(rest.params ?? {}) } };
  const li = localInstrument(String(wanted));
  if (li) return { name: li.name, ...rest, type: 'sampler', preset: undefined, params: { sample: li.path, ...(rest.params ?? {}) } };
  const all = [...localKit().map((x) => x.name), ...localInstruments().map((x) => x.name)];
  throw new Error(`Som local "${wanted}" não encontrado. Disponíveis: ${all.join(', ') || 'nenhum (FL Studio não instalado)'}`);
}

/**
 * Canais sampler criados pelo MCP ganham o modo certo para o som: bateria em
 * one-shot; instrumento segurando enquanto a nota dura, com loop de sustentação
 * e raiz detectada. Parâmetros passados explicitamente têm prioridade.
 */
async function enrichSampler(list: { name: string; args: any }[]) {
  for (const a of list) {
    if (a.name !== 'addChannel' && a.name !== 'updateChannel') continue;
    const args = expandLocalSample(a.name, a.args ?? {});
    a.args = args;
    const sample = args?.params?.sample;
    if (args?.preset || typeof sample !== 'string' || !sample) continue;
    if (args.type && args.type !== 'sampler') continue;
    const given = { ...args.params };
    delete given.sample;
    const { params } = await samplerParamsFor(resolveFlPath(sample), given);
    a.args = { ...args, type: 'sampler', params };
  }
}

/** Projeto novo: 4 canais de bateria (samples da instalação local, ou sintetizados). */
function templateProject(name: string, withKit: boolean) {
  let p = emptyProject(name);
  if (!withKit) return p;
  const kit = localKit();
  for (const n of ['Kick', 'Clap', 'Hat', 'Snare']) {
    const ls = kit.find((k) => k.name === n);
    const r = ls
      ? A.addChannel(p, { name: n, type: 'sampler', params: { sample: ls.path, keytrack: true, oneshot: true, ...(ls.cut ? { cut: ls.cut } : {}) }, insert: 'master' })
      : A.addChannel(p, { preset: n, insert: 'master' });
    p = applyOps(p, r.ops);
  }
  return p;
}

function runActions(list: { name: string; args: any }[], origin: string, label?: string) {
  // Aplica em sequência sobre uma cópia; só publica se tudo der certo.
  let draft = JSON.parse(JSON.stringify(store.project));
  const all: Op[] = [];
  const results: unknown[] = [];
  for (const { name, args } of list) {
    const fn = ACTIONS[name];
    if (!fn) throw new Error(`Ação desconhecida: ${name}`);
    const r = fn(draft, expandLocalSample(name, args ?? {}));
    draft = applyOps(draft, r.ops);
    all.push(...r.ops);
    results.push(r.result ?? null);
  }
  store.apply(all, origin, label);
  return results;
}

// ---------------------------------------------------------------- arquivos

function browseRoots() {
  const roots: { name: string; path: string }[] = [];
  const add = (name: string, path: string) => existsSync(path) && roots.push({ name, path });
  add('Samples do Music Labs', SAMPLES_DIR);
  const ix = library();
  if (ix) for (const src of ix.sources) add(src.label, src.root);
  else add('Packs do FL Studio', join(FL_DIR, 'Data/Patches/Packs'));
  add('Música', join(homedir(), 'Música'));
  add('Music', join(homedir(), 'Music'));
  add('Músicas', join(homedir(), 'Músicas'));
  add('Downloads', join(homedir(), 'Downloads'));
  const wineDocs = join(homedir(), '.wine/drive_c/users');
  if (existsSync(wineDocs))
    for (const u of readdirSync(wineDocs)) add(`Projetos FL (${u})`, join(wineDocs, u, 'Documents/Image-Line/FL Studio/Projects'));
  add('Demos do FL Studio', join(FL_DIR, 'Data/Demo projects'));
  // sem duplicar a mesma pasta com dois nomes
  return roots.filter((r, i) => roots.findIndex((x) => x.path === r.path) === i);
}

function browse(dir: string) {
  const out: { name: string; path: string; kind: 'dir' | 'audio' | 'flp' | 'project' | 'instrument' }[] = [];
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const ext = extname(e).toLowerCase();
    if (st.isDirectory()) out.push({ name: e, path: full, kind: 'dir' });
    else if (AUDIO_EXT.has(ext)) out.push({ name: e, path: full, kind: 'audio' });
    else if (ext === '.flp') out.push({ name: e, path: full, kind: 'flp' });
    else if (ext === '.fst' && setFolder(full)) out.push({ name: e.replace(/\.fst$/i, ''), path: full, kind: 'instrument' });
    else if (ext === '.musiclabs') out.push({ name: e, path: full, kind: 'project' });
  }
  return out.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
}

function searchSamples(query: string, limit = 40) {
  if (library()) {
    const hits = searchLibrary(query, limit);
    // pastas pessoais não indexadas (Downloads, Música) entram depois
    if (hits.length >= limit) return hits;
    const extra = searchFolders(query, limit - hits.length, [join(homedir(), 'Downloads'), SAMPLES_DIR]);
    return [...hits, ...extra.filter((e) => !hits.some((h) => h.path === e.path))];
  }
  return searchFolders(query, limit, browseRoots().filter((r) => !r.name.startsWith('Projetos') && !r.name.startsWith('Demos')).map((r) => r.path));
}

function searchFolders(query: string, limit: number, dirs: string[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { name: string; path: string }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 8 || hits.length >= limit) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (AUDIO_EXT.has(extname(e).toLowerCase())) {
        const hay = full.toLowerCase();
        if (words.every((w) => hay.includes(w))) hits.push({ name: e, path: full });
      }
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d, 0);
  return hits;
}

function importFlpFile(path: string) {
  const buf = new Uint8Array(readFileSync(path));
  const { project, report } = importFlp(buf, basename(path, extname(path)), {
    resolveSample: resolveFlPath,
    exists: existsSync,
    // Canais com o nome de um instrumento dos packs locais (ex.: "Strings Section")
    // viram o instrumento multi-sample correspondente.
    instrumentFor: (name) => {
      const li = localInstrument(name.replace(/\s*#\d+$/, ''));
      return li ? { path: li.path, loop: folderHasLoops(li.path) } : undefined;
    },
  });
  store.load(project, null);
  return report;
}

async function doRender(args: any) {
  const r = await renderProject(store.project, args);
  const analysis = analyzeMix(r.L, r.R, r.sr);
  let file: string | null = null;
  if (args.save !== false) {
    mkdirSync(RENDERS_DIR, { recursive: true });
    file = args.out ?? join(RENDERS_DIR, `${safeName(store.project.name)}${args.mode === 'pattern' ? '-pattern' : ''}.wav`);
    writeFileSync(file!, encodeWav(r.L, r.R, r.sr, args.bits ?? 24));
  }
  return {
    file,
    analysis,
    inserts: r.inserts.filter((i) => Number.isFinite(i.peakDb)).map((i) => ({ insert: i.index, name: i.name, peakDb: +i.peakDb.toFixed(1), rmsDb: +i.rmsDb.toFixed(1) })),
    missingSamples: r.missingSamples,
  };
}

// ---------------------------------------------------------------- HTTP

async function rawBody(req: IncomingMessage, limit = 1024 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Arquivo grande demais');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Contorno da forma de onda (máximo absoluto por faixa) para desenhar clipes. */
async function peaksOf(path: string, n: number) {
  const d = await loadSample(path);
  const ch = d.ch[0];
  const per = Math.max(1, Math.floor(ch.length / n));
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(ch.length, (i + 1) * per);
    for (let k = i * per; k < end; k++) {
      const a = Math.abs(ch[k]);
      if (a > m) m = a;
    }
    peaks.push(Math.round(m * 1000) / 1000);
  }
  return { duration: ch.length / d.sr, peaks };
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function json(res: ServerResponse, code: number, v: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(v));
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

/**
 * Só aceita requisições locais do próprio app: bloqueia sites abertos no
 * navegador (CSRF / DNS rebinding) de mexer no projeto ou gravar arquivos.
 */
function trusted(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(o.hostname);
  } catch {
    return false;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!trusted(req)) return json(res, 403, { error: 'origem não permitida' });
  const url = new URL(req.url ?? '/', 'http://x');
  const route = `${req.method} ${url.pathname}`;
  const q = (k: string) => url.searchParams.get(k) ?? '';
  try {
    switch (route) {
      case 'GET /api/project':
        return json(res, 200, { project: store.project, rev: store.rev, path: store.path, dirty: store.dirty });
      case 'GET /api/summary':
        return json(res, 200, { ...A.describe(store.project), file: store.path, unsaved: store.dirty, ui: uiStatus });
      case 'GET /api/registry':
        return json(res, 200, { instruments: INSTRUMENTS, effects: EFFECTS, presets: PRESETS, scales: Object.keys(SCALES), localSamples: localKit(), localInstruments: localInstruments() });
      case 'GET /api/status':
        return json(res, 200, uiStatus);
      case 'GET /api/build': {
        // versão da interface compilada (muda a cada build): a tela se recarrega quando muda
        const html = existsSync(join(DIST, 'index.html')) ? readFileSync(join(DIST, 'index.html'), 'utf8') : '';
        return json(res, 200, { build: /assets\/index-[^"']+\.js/.exec(html)?.[0] ?? '' });
      }
      case 'POST /api/ops': {
        const b = await body(req);
        store.apply(b.ops, b.origin ?? 'http', b.label);
        return json(res, 200, { rev: store.rev });
      }
      case 'POST /api/actions': {
        const b = await body(req);
        await enrichSampler(b.actions);
        // clipe de áudio sem tamanho: usa a duração do arquivo
        for (const a of b.actions)
          if (a.name === 'addAudioClip' && a.args?.sample && !a.args.bars && !a.args.lengthSec) {
            a.args.sample = resolveFlPath(String(a.args.sample));
            const d = await loadSample(a.args.sample);
            a.args.lengthSec = d.ch[0].length / d.sr - (a.args.startSec ?? 0);
          }
        const results = runActions(b.actions, b.origin ?? 'mcp', b.label);
        return json(res, 200, { results, rev: store.rev });
      }
      case 'POST /api/undo':
        return json(res, 200, { ok: store.undo() });
      case 'POST /api/redo':
        return json(res, 200, { ok: store.redo() });
      case 'POST /api/new': {
        const b = await body(req);
        store.load(templateProject(b.name ?? 'Sem título', b.template !== 'empty'), null);
        if (b.bpm) store.apply(A.setProjectProps(store.project, { bpm: b.bpm }).ops, 'http');
        return json(res, 200, { ok: true });
      }
      case 'POST /api/save': {
        const b = await body(req);
        return json(res, 200, { path: store.save(b.path) });
      }
      case 'POST /api/open': {
        const b = await body(req);
        if (/\.flp$/i.test(b.path)) return json(res, 200, { imported: importFlpFile(b.path) });
        store.open(b.path);
        return json(res, 200, { ok: true });
      }
      case 'GET /api/projects':
        return json(res, 200, { dir: PROJECTS_DIR, projects: listProjects() });
      case 'GET /api/roots':
        return json(res, 200, browseRoots());
      case 'GET /api/browse':
        return json(res, 200, browse(q('dir')));
      case 'GET /api/library':
        return json(res, 200, libraryStatus());
      case 'POST /api/library/rescan': {
        rescanLibrary(false, announceLibrary);
        return json(res, 200, { scanning: true });
      }
      case 'GET /api/search':
        return json(res, 200, searchSamples(q('q'), Number(q('limit') || 40)));
      case 'GET /api/source':
        return json(res, 200, await sourceInfo(resolveFlPath(q('path'))));
      case 'GET /api/zone': {
        const wav = await zoneWav(q('path'), Number(q('i')));
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'max-age=3600' });
        return res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
      }
      case 'GET /api/peaks':
        return json(res, 200, await peaksOf(resolveFlPath(q('path')), Math.min(4000, Number(q('n') || 1000))));
      case 'POST /api/recording': {
        // WAV gravado pela interface: salva em ~/MusicLabs/Gravações
        const buf = await rawBody(req);
        if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error('Gravação inválida');
        const d = new Date();
        const z = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}h${z(d.getMinutes())}m${z(d.getSeconds())}s`;
        const file = join(RECORDINGS_DIR, `${safeName(q('name') || 'Gravação')} ${stamp}.wav`);
        writeFileSync(file, buf);
        return json(res, 200, { path: file });
      }
      case 'GET /api/monitor':
        return json(res, 200, monitorStatus());
      case 'GET /api/monitor/sources':
        return json(res, 200, await monitorSources());
      case 'POST /api/monitor': {
        // retorno nativo do amp: { on, buffer, source, pick, inGain, outGain, bpm, chain }
        const b = await body(req);
        if (!b.on) {
          stopMonitor();
          return json(res, 200, monitorStatus());
        }
        return json(res, 200, startMonitor(b));
      }
      case 'GET /api/latency':
        return json(res, 200, await pwQuantum());
      case 'POST /api/latency': {
        // modo de baixa latência: força o tamanho dos blocos do PipeWire enquanto o app roda
        const b = await body(req);
        const q = [0, 64, 128, 256, 512].includes(Number(b.quantum)) ? Number(b.quantum) : 0;
        await setPwQuantum(q);
        return json(res, 200, await pwQuantum());
      }
      case 'POST /api/import': {
        // arquivo de áudio escolhido no computador (qualquer formato que o ffmpeg leia): salva em ~/MusicLabs/Importados
        const buf = await rawBody(req);
        if (!buf.length) throw new Error('Arquivo vazio');
        const name = safeName(q('name') || 'audio');
        const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'wav').toLowerCase();
        const base = name.replace(/\.[a-z0-9]{1,5}$/i, '');
        let file = join(IMPORTS_DIR, `${base}.${ext}`);
        for (let i = 2; existsSync(file); i++) file = join(IMPORTS_DIR, `${base} (${i}).${ext}`);
        writeFileSync(file, buf);
        return json(res, 200, { path: file });
      }
      case 'GET /api/sample': {
        const path = resolveFlPath(q('path'));
        const wav = await wavFor(path);
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'max-age=3600' });
        return res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
      }
      case 'POST /api/render': {
        const b = await body(req);
        return json(res, 200, await doRender(b));
      }
      case 'POST /api/transport': {
        const b = await body(req);
        broadcast({ type: 'transport', ...b });
        return json(res, 200, { ok: true, uiConnected: sockets.size > 0 });
      }
      case 'POST /api/ui': {
        // comandos para a interface aberta (área selecionada, loop, janelas...)
        const b = await body(req);
        broadcast({ type: 'ui', ...b });
        return json(res, 200, { ok: true, uiConnected: sockets.size > 0 });
      }
      case 'POST /api/preview': {
        const b = await body(req);
        broadcast({ type: 'preview', ...b });
        return json(res, 200, { ok: true, uiConnected: sockets.size > 0 });
      }
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api')) return serveStatic(url.pathname, res);
    json(res, 404, { error: `Rota inexistente: ${route}` });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
}

function serveStatic(pathname: string, res: ServerResponse) {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Interface não compilada. Rode "npm run build" ou use "npm run dev".');
  }
  let file = join(DIST, decodeURIComponent(pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  // a página nunca fica em cache (os arquivos de assets têm nome com hash e podem ficar)
  const html = extname(file) === '.html';
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': html ? 'no-cache, no-store' : 'max-age=31536000, immutable' });
  res.end(readFileSync(file));
}

/** Avisa a tela quando a varredura termina. */
function announceLibrary(ix: NonNullable<ReturnType<typeof library>>, first: boolean) {
  const daws = [...new Set(ix.sources.map((s) => s.daw))].join(', ');
  broadcast({
    type: 'toast',
    text: ix.files.length
      ? `${first ? 'Biblioteca montada' : 'Biblioteca atualizada'}: ${ix.files.length} samples e ${ix.instruments.length} instrumentos de ${daws}.`
      : 'Nenhuma biblioteca de outra DAW encontrada nesta máquina.',
  });
  broadcast({ type: 'library' });
}

export function startServer(port = PORT) {
  initLibrary(STATE_DIR, announceLibrary);
  const server = createServer(handle);
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }: { req: IncomingMessage }) => trusted(req) });
  wss.on('connection', (ws, req) => {
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('client') ?? Math.random().toString(36).slice(2);
    (ws as any).clientId = id;
    sockets.add(ws);
    uiStatus = { ...uiStatus, connected: true };
    ws.send(JSON.stringify({ type: 'project', project: store.project, rev: store.rev, path: store.path, dirty: store.dirty }));
    ws.on('message', (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (m.type === 'ops') store.apply(m.ops, id, m.label);
        else if (m.type === 'undo') store.undo();
        else if (m.type === 'redo') store.redo();
        else if (m.type === 'status') uiStatus = { ...m.status, connected: true };
        else if (m.type === 'action') runActions(m.actions, id);
      } catch (e) {
        // Rejeitado: devolve o estado verdadeiro para o cliente se realinhar.
        ws.send(JSON.stringify({ type: 'error', error: (e as Error).message }));
        ws.send(JSON.stringify({ type: 'project', project: store.project, rev: store.rev, path: store.path, dirty: store.dirty }));
      }
    });
    ws.on('close', () => {
      sockets.delete(ws);
      if (!sockets.size) uiStatus = { ...uiStatus, connected: false, playing: false };
    });
  });
  return new Promise<typeof server>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startServer().then(() => console.log(`Music Labs rodando em http://127.0.0.1:${PORT}`));
}

// ---------------------------------------------------------------- latência do PipeWire (Linux)

import { execFile, execFileSync } from 'node:child_process';
const run = (cmd: string, args: string[]) => new Promise<string>((ok) => execFile(cmd, args, { timeout: 3000 }, (_e, out) => ok(String(out ?? ''))));
let forcedQuantum = 0;
/** Tamanho dos blocos do PipeWire: padrão do sistema e o forçado (0 = não forçado). */
async function pwQuantum() {
  if (process.platform !== 'linux') return { available: false };
  const out = await run('pw-metadata', ['-n', 'settings', '0']);
  if (!out) return { available: false };
  const get = (k: string) => Number(new RegExp(`'${k}' value:'(\\d+)'`).exec(out)?.[1] ?? 0);
  return { available: true, quantum: get('clock.quantum'), force: get('clock.force-quantum'), rate: get('clock.rate') || 48000 };
}
async function setPwQuantum(q: number) {
  if (process.platform !== 'linux') return;
  await run('pw-metadata', ['-n', 'settings', '0', 'clock.force-quantum', String(q)]);
  forcedQuantum = q;
}
// ao fechar, devolve o PipeWire ao normal (o resto do sistema não fica em baixa latência)
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => {
    if (!forcedQuantum) process.exit(0);
    execFile('pw-metadata', ['-n', 'settings', '0', 'clock.force-quantum', '0'], () => process.exit(0));
  });
process.once('exit', () => {
  if (forcedQuantum) {
    try {
      execFileSync('pw-metadata', ['-n', 'settings', '0', 'clock.force-quantum', '0'], { timeout: 2000 });
    } catch {
      /* sem pw-metadata */
    }
  }
});
