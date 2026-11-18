// Operações de edição. Toda mudança no projeto (interface, MCP, import) vira
// uma lista de Ops aplicada pelo mesmo código em todos os lados, o que mantém
// navegador e servidor sincronizados e dá undo/redo de graça.

import type { Project } from './model.js';

export type PathSeg = string | number;

export type Op =
  | { op: 'set'; path: PathSeg[]; value: unknown }
  | { op: 'insert'; path: PathSeg[]; value: unknown; index?: number; many?: boolean }
  | { op: 'remove'; path: PathSeg[] }
  | { op: 'replace'; value: Project };

/** Resolve um segmento: em arrays, string casa com item.id, número é índice. */
function step(container: any, seg: PathSeg): any {
  if (Array.isArray(container)) {
    if (typeof seg === 'number') return container[seg];
    const byId = container.find((x: any) => x && x.id === seg);
    if (byId !== undefined) return byId;
    const n = Number(seg);
    return Number.isInteger(n) ? container[n] : undefined;
  }
  return container?.[seg];
}

function indexIn(arr: any[], seg: PathSeg): number {
  if (typeof seg === 'number') return seg;
  const i = arr.findIndex((x) => x && x.id === seg);
  if (i >= 0) return i;
  const n = Number(seg);
  return Number.isInteger(n) ? n : -1;
}

function walk(root: any, path: PathSeg[]): any {
  let cur = root;
  for (const seg of path) {
    cur = step(cur, seg);
    if (cur === undefined || cur === null) throw new Error(`Caminho inexistente: ${path.join('/')}`);
  }
  return cur;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Aplica ops mutando o projeto; devolve o projeto (novo em caso de replace). */
export function applyOps(project: Project, ops: Op[]): Project {
  let p = project;
  for (const o of ops) {
    switch (o.op) {
      case 'replace':
        p = clone(o.value);
        break;
      case 'set': {
        if (o.path.length === 0) throw new Error('set sem caminho');
        const parent = walk(p, o.path.slice(0, -1));
        const last = o.path[o.path.length - 1];
        if (Array.isArray(parent)) {
          const i = indexIn(parent, last);
          if (i < 0) throw new Error(`Item inexistente: ${o.path.join('/')}`);
          parent[i] = clone(o.value);
        } else {
          if (o.value === undefined) delete parent[last];
          else parent[last] = clone(o.value);
        }
        break;
      }
      case 'insert': {
        // Cria a lista se o último segmento ainda não existir (ex.: notes[ch]).
        const parent = walk(p, o.path.slice(0, -1));
        const last = o.path[o.path.length - 1];
        let arr = Array.isArray(parent) ? step(parent, last) : parent[last];
        if (arr === undefined && !Array.isArray(parent)) arr = parent[last] = [];
        if (!Array.isArray(arr)) throw new Error(`Não é lista: ${o.path.join('/')}`);
        const values = Array.isArray(o.value) && o.many ? (o.value as unknown[]) : [o.value];
        const at = o.index === undefined || o.index < 0 || o.index > arr.length ? arr.length : o.index;
        arr.splice(at, 0, ...values.map(clone));
        break;
      }
      case 'remove': {
        const parent = walk(p, o.path.slice(0, -1));
        const last = o.path[o.path.length - 1];
        if (Array.isArray(parent)) {
          const i = indexIn(parent, last);
          if (i >= 0 && i < parent.length) parent.splice(i, 1);
        } else delete parent[last];
        break;
      }
    }
  }
  return p;
}

/** Atalhos para montar ops. */
export const set = (path: PathSeg[], value: unknown): Op => ({ op: 'set', path, value });
export const ins = (path: PathSeg[], value: unknown, index?: number): Op => ({ op: 'insert', path, value, index });
export const insMany = (path: PathSeg[], values: unknown[]): Op => ({ op: 'insert', path, value: values, many: true });
export const rem = (path: PathSeg[]): Op => ({ op: 'remove', path });

/** Histórico de undo baseado em snapshots (projetos são pequenos). */
export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  constructor(private limit = 200) {}
  push(before: Project) {
    this.undoStack.push(JSON.stringify(before));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(current: Project): Project | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(JSON.stringify(current));
    return JSON.parse(s);
  }
  redo(current: Project): Project | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(JSON.stringify(current));
    return JSON.parse(s);
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
