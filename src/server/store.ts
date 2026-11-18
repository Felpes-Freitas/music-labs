// Estado do projeto no servidor: fonte da verdade, histórico, arquivo e autosave.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Project } from '../core/model.js';
import { emptyProject } from '../core/model.js';
import { History, Op, applyOps } from '../core/ops.js';

export const HOME_DIR = process.env.MUSICLABS_HOME ?? join(homedir(), 'Music Labs');
export const PROJECTS_DIR = join(HOME_DIR, 'Projetos');
export const RENDERS_DIR = join(HOME_DIR, 'Renders');
export const SAMPLES_DIR = join(HOME_DIR, 'Samples');
const STATE_DIR = join(homedir(), '.local/share/musiclabs');
const AUTOSAVE = join(STATE_DIR, 'autosave.json');

for (const d of [PROJECTS_DIR, RENDERS_DIR, SAMPLES_DIR, STATE_DIR]) mkdirSync(d, { recursive: true });

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
        if (s?.project?.format === 'musiclabs') {
          this.project = s.project;
          this.path = s.path ?? null;
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
    try {
      this.project = applyOps(this.project, ops);
    } catch (e) {
      this.project = JSON.parse(before);
      throw e;
    }
    this.history.push(JSON.parse(before));
    this.rev++;
    this.dirty = true;
    const replaced = ops.some((o) => o.op === 'replace');
    if (replaced) this.emitProject();
    else for (const l of this.listeners) l({ type: 'ops', ops, rev: this.rev, origin, label });
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
    this.project = p;
    this.path = path;
    this.dirty = path === null;
    this.history.clear();
    this.rev++;
    this.emitProject();
    this.scheduleAutosave();
  }

  save(path?: string): string {
    let target = path ?? this.path;
    if (!target) target = join(PROJECTS_DIR, `${safeName(this.project.name)}.musiclabs`);
    if (!target.includes('/')) target = join(PROJECTS_DIR, target);
    if (!/\.musiclabs$/.test(target)) target += '.musiclabs';
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(this.project, null, 1));
    this.path = target;
    this.dirty = false;
    this.emitProject();
    this.scheduleAutosave();
    return target;
  }

  open(path: string) {
    const p = JSON.parse(readFileSync(path, 'utf8')) as Project;
    if (p.format !== 'musiclabs') throw new Error('Arquivo não é um projeto do Music Labs');
    this.load(p, path);
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

export function safeName(s: string) {
  return s.replace(/[^\p{L}\p{N} _.-]+/gu, '_').trim() || 'projeto';
}

export function listProjects() {
  const out: { name: string; path: string; modified: string }[] = [];
  for (const f of readdirSync(PROJECTS_DIR)) {
    if (!f.endsWith('.musiclabs')) continue;
    const full = join(PROJECTS_DIR, f);
    out.push({ name: basename(f, '.musiclabs'), path: full, modified: statSync(full).mtime.toISOString() });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}
