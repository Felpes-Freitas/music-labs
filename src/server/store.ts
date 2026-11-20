// Estado do projeto no servidor: fonte da verdade, histórico, arquivo e autosave.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type { Project } from '../core/model.js';
import { emptyProject, isProjectData, PROJECT_EXT, PROJECT_FORMAT } from '../core/model.js';
import { History, Op, applyOps } from '../core/ops.js';
import { completeOps } from '../core/audiochan.js';

export const HOME_DIR = process.env.MUSICLABS_HOME ?? join(homedir(), 'MusicLabs');
export const PROJECTS_DIR = join(HOME_DIR, 'Projetos');
export const RENDERS_DIR = join(HOME_DIR, 'Renders');
export const SAMPLES_DIR = join(HOME_DIR, 'Samples');
export const RECORDINGS_DIR = join(HOME_DIR, 'Gravações');
export const IMPORTS_DIR = join(HOME_DIR, 'Importados');
/** Pasta de estado (autosave, índice da biblioteca) no lugar padrão de cada sistema. */
function defaultStateDir() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'MusicLabs');
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/MusicLabs');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'musiclabs');
}
export const STATE_DIR = process.env.MUSICLABS_STATE_DIR ?? defaultStateDir();
const AUTOSAVE = join(STATE_DIR, 'autosave.json');

for (const d of [PROJECTS_DIR, RENDERS_DIR, SAMPLES_DIR, RECORDINGS_DIR, IMPORTS_DIR, STATE_DIR]) mkdirSync(d, { recursive: true });

export type Listener = (msg: { type: 'ops'; ops: Op[]; rev: number; origin: string; label?: string } | { type: 'project'; project: Project; rev: number; path: string | null; dirty: boolean }) => void;

export class Store {
  project: Project;
  path: string | null = null;
  rev = 0;
  dirty = false;
  private history = new History();
  private listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.project = emptyProject();
    try {
      if (existsSync(AUTOSAVE)) {
        const s = JSON.parse(readFileSync(AUTOSAVE, 'utf8'));
        if (isProjectData(s?.project)) {
          this.project = { ...s.project, format: PROJECT_FORMAT };
          this.path = movedProject(s.path ?? null);
          this.dirty = !!s.dirty;
        }
      }
    } catch {
      /* autosave corrompido: começa vazio */
    }
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emitProject() {
    for (const l of this.listeners) l({ type: 'project', project: this.project, rev: this.rev, path: this.path, dirty: this.dirty });
  }

  /** Aplica ops (com undo). origin identifica quem editou (cliente ou "mcp"). */
  apply(ops: Op[], origin: string, label?: string) {
    if (!ops.length) return;
    const before = JSON.stringify(this.project);
    let extra: Op[] = [];
    try {
      this.project = applyOps(this.project, ops);
      // áudio novo → canal de áudio no rack, pattern-grupo, insert; tracks usadas existem
      extra = completeOps(this.project);
      if (extra.length) this.project = applyOps(this.project, extra);
    } catch (e) {
      this.project = JSON.parse(before);
      throw e;
    }
    this.history.push(JSON.parse(before));
    this.rev++;
    this.dirty = true;
    const replaced = ops.some((o) => o.op === 'replace');
    if (replaced) this.emitProject();
    else {
      for (const l of this.listeners) l({ type: 'ops', ops, rev: this.rev, origin, label });
      // o que o servidor completou vai para todos (inclusive quem fez a edição)
      if (extra.length) for (const l of this.listeners) l({ type: 'ops', ops: extra, rev: this.rev, origin: 'server' });
    }
    this.scheduleAutosave();
  }

  undo() {
    const p = this.history.undo(this.project);
    if (!p) return false;
    this.project = p;
    this.rev++;
    this.emitProject();
    this.scheduleAutosave();
    return true;
  }
  redo() {
    const p = this.history.redo(this.project);
    if (!p) return false;
    this.project = p;
    this.rev++;
    this.emitProject();
    this.scheduleAutosave();
    return true;
  }

  load(p: Project, path: string | null) {
    // projetos antigos: áudios sem canal ganham o canal deles (e o pattern-grupo)
    const extra = completeOps(p);
    this.project = extra.length ? applyOps(p, extra) : p;
    this.path = path;
    this.dirty = path === null;
    this.history.clear();
    this.rev++;
    this.emitProject();
    this.scheduleAutosave();
  }

  save(path?: string): string {
    let target = path ?? this.path;
    if (!target) target = join(PROJECTS_DIR, `${safeName(this.project.name)}${PROJECT_EXT}`);
    if (!target.includes('/')) target = join(PROJECTS_DIR, target);
    if (!target.endsWith(PROJECT_EXT)) target += PROJECT_EXT;
    // salvar num arquivo escolhido ("Salvar como", MCP com path): o projeto passa a ter o nome do arquivo
    if (path) this.project = { ...this.project, name: basename(target, PROJECT_EXT) };
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(this.project, null, 1));
    this.path = target;
    this.dirty = false;
    this.emitProject();
    this.scheduleAutosave();
    return target;
  }

  open(path: string) {
    const p = JSON.parse(readFileSync(path, 'utf8'));
    if (!isProjectData(p)) throw new Error('Arquivo não é um projeto do Music Labs');
    // arquivo de versão antiga: abre normalmente; o próximo "Salvar" grava no formato atual
    const legacy = p.format !== PROJECT_FORMAT || !path.endsWith(PROJECT_EXT);
    this.load({ ...p, format: PROJECT_FORMAT }, legacy ? path.slice(0, path.length - extname(path).length) + PROJECT_EXT : path);
    if (legacy) {
      this.dirty = true;
      this.emitProject();
    }
  }

  /** Grava o autosave já (sem esperar o intervalo). */
  flushAutosave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      writeFileSync(AUTOSAVE, JSON.stringify({ project: this.project, path: this.path, dirty: this.dirty }));
    } catch {
      /* sem disco: ignora */
    }
  }

  private scheduleAutosave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        writeFileSync(AUTOSAVE, JSON.stringify({ project: this.project, path: this.path, dirty: this.dirty }));
      } catch {
        /* sem disco: ignora */
      }
    }, 800);
  }
}

/** Caminho do projeto do autosave; se o arquivo mudou de extensão (formato antigo → .mlstudio), segue o novo. */
function movedProject(path: string | null) {
  if (!path || existsSync(path)) return path;
  const renamed = path.slice(0, path.length - extname(path).length) + PROJECT_EXT;
  return existsSync(renamed) ? renamed : path;
}

export function safeName(s: string) {
  return s.replace(/[^\p{L}\p{N} _.-]+/gu, '_').trim() || 'projeto';
}

export function listProjects() {
  const out: { name: string; path: string; modified: string }[] = [];
  for (const f of readdirSync(PROJECTS_DIR)) {
    if (!f.endsWith(PROJECT_EXT)) continue;
    const full = join(PROJECTS_DIR, f);
    out.push({ name: basename(f, PROJECT_EXT), path: full, modified: statSync(full).mtime.toISOString() });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}
