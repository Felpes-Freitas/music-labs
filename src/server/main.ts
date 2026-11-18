// Servidor do Batuque: guarda o projeto, sincroniza a interface por WebSocket,
// expõe a API que o MCP usa, converte samples e faz render offline.

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as A from '../core/actions.js';
import { applyOps, type Op } from '../core/ops.js';
import { EFFECTS, INSTRUMENTS, PRESETS } from '../core/registry.js';
import { SCALES } from '../core/theory.js';
import { importFlp } from '../core/flp.js';
import { encodeWav } from '../core/wav.js';
import { analyzeMix } from '../core/analysis.js';
import { emptyProject } from '../core/model.js';
import { Store, listProjects, RENDERS_DIR, SAMPLES_DIR, PROJECTS_DIR, safeName } from './store.js';
import { AUDIO_EXT, FL_DIR, resolveFlPath, wavFor } from './samples.js';
import { renderProject } from './render.js';

export const PORT = Number(process.env.BATUQUE_PORT ?? 7717);
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
  setProjectProps: A.setProjectProps,
};

function runActions(list: { name: string; args: any }[], origin: string, label?: string) {
  // Aplica em sequência sobre uma cópia; só publica se tudo der certo.
  let draft = JSON.parse(JSON.stringify(store.project));
  const all: Op[] = [];
  const results: unknown[] = [];
  for (const { name, args } of list) {
    const fn = ACTIONS[name];
    if (!fn) throw new Error(`Ação desconhecida: ${name}`);
    const r = fn(draft, args ?? {});
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
  add('Samples do Batuque', SAMPLES_DIR);
  add('Packs do FL Studio', join(FL_DIR, 'Data/Patches/Packs'));
  add('Música', join(homedir(), 'Música'));
  add('Músicas', join(homedir(), 'Músicas'));
  add('Downloads', join(homedir(), 'Downloads'));
  const wineDocs = join(homedir(), '.wine/drive_c/users');
  if (existsSync(wineDocs))
    for (const u of readdirSync(wineDocs)) add(`Projetos FL (${u})`, join(wineDocs, u, 'Documents/Image-Line/FL Studio/Projects'));
  add('Demos do FL Studio', join(FL_DIR, 'Data/Demo projects'));
  return roots;
}

function browse(dir: string) {
  const out: { name: string; path: string; kind: 'dir' | 'audio' | 'flp' | 'project' }[] = [];
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
    else if (ext === '.batuque') out.push({ name: e, path: full, kind: 'project' });
  }
  return out.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
}

function searchSamples(query: string, limit = 40) {
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
  for (const r of browseRoots()) if (!r.name.startsWith('Projetos') && !r.name.startsWith('Demos')) walk(r.path, 0);
  return hits;
}

function importFlpFile(path: string) {
  const buf = new Uint8Array(readFileSync(path));
  const { project, report } = importFlp(buf, basename(path, extname(path)), { resolveSample: resolveFlPath, exists: existsSync });
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
        return json(res, 200, { instruments: INSTRUMENTS, effects: EFFECTS, presets: PRESETS, scales: Object.keys(SCALES) });
      case 'GET /api/status':
        return json(res, 200, uiStatus);
      case 'POST /api/ops': {
        const b = await body(req);
        store.apply(b.ops, b.origin ?? 'http', b.label);
        return json(res, 200, { rev: store.rev });
      }
      case 'POST /api/actions': {
        const b = await body(req);
        const results = runActions(b.actions, b.origin ?? 'mcp', b.label);
        return json(res, 200, { results, rev: store.rev });
      }
      case 'POST /api/undo':
        return json(res, 200, { ok: store.undo() });
      case 'POST /api/redo':
        return json(res, 200, { ok: store.redo() });
      case 'POST /api/new': {
        const b = await body(req);
        store.load(emptyProject(b.name ?? 'Sem título'), null);
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
      case 'GET /api/search':
        return json(res, 200, searchSamples(q('q'), Number(q('limit') || 40)));
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
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

export function startServer(port = PORT) {
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
  startServer().then(() => console.log(`Batuque rodando em http://127.0.0.1:${PORT}`));
}
