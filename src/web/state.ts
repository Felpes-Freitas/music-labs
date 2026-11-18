// Estado da interface: cópia local do projeto sincronizada com o servidor,
// seleção atual, janelas e status ao vivo da engine.

import { useEffect, useReducer } from 'preact/hooks';
import type { Project } from '../core/model';
import { emptyProject, findPattern, findChannel, parseNote, PPQ, ticksPerBar } from '../core/model';
import { applyOps, type Op } from '../core/ops';
import type { ActionResult } from '../core/actions';
import type { EngineStatus } from '../core/engine';
import { audio } from './audio';

export type WindowId = 'rack' | 'piano' | 'playlist' | 'mixer' | 'browser' | 'channel';

export interface WinState {
  open: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface Toast {
  id: number;
  text: string;
  from?: string;
}

/** Layout inicial proporcional à tela (área de trabalho = janela - navegador - barra). */
function defaultLayout(): Record<WindowId, WinState> {
  const W = Math.max(900, window.innerWidth - 240);
  const H = Math.max(500, window.innerHeight - 46);
  const rackH = Math.min(340, Math.round(H * 0.42));
  return {
    browser: { open: true, x: 0, y: 0, w: 240, h: 0, z: 1 },
    rack: { open: true, x: 8, y: 8, w: Math.min(720, W * 0.55), h: rackH, z: 3 },
    playlist: { open: true, x: 8, y: rackH + 16, w: W - 16, h: H - rackH - 24, z: 2 },
    piano: { open: false, x: 40, y: 40, w: W - 80, h: H - 80, z: 4 },
    mixer: { open: false, x: 30, y: Math.max(8, H - 470), w: Math.min(W - 60, 1200), h: 450, z: 5 },
    channel: { open: false, x: Math.min(W - 480, Math.min(720, W * 0.55) + 16), y: 8, w: 470, h: 440, z: 6 },
  };
}

export const state = {
  project: emptyProject() as Project,
  rev: 0,
  path: null as string | null,
  dirty: false,
  connected: false,
  patternId: null as string | null,
  channelId: null as string | null,
  insert: 1,
  mode: 'pattern' as 'pattern' | 'song',
  snap: 24, // ticks (1 step)
  scaleRoot: 'C',
  scale: 'chromatic',
  toasts: [] as Toast[],
  windows: defaultLayout(),
};

const listeners = new Set<() => void>();
const liveListeners = new Set<(s: EngineStatus) => void>();
let scheduled = false;

export function emit() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const l of listeners) l();
  });
}

export function useApp() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const l = () => force(undefined);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

export function onLive(fn: (s: EngineStatus) => void) {
  liveListeners.add(fn);
  return () => void liveListeners.delete(fn);
}
audio.onStatus = (s) => {
  for (const l of liveListeners) l(s);
  if (!s.playing && playingFlag) {
    playingFlag = false;
    emit();
  }
};
let playingFlag = false;

// ---------------------------------------------------------------- servidor

const clientId = Math.random().toString(36).slice(2);
let ws: WebSocket | null = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?client=${clientId}`);
  ws.onopen = () => {
    state.connected = true;
    emit();
  };
  ws.onclose = () => {
    state.connected = false;
    emit();
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.type) {
      case 'project':
        state.project = m.project;
        state.rev = m.rev;
        state.path = m.path;
        state.dirty = m.dirty;
        fixSelection();
        audio.setProject(state.project);
        emit();
        break;
      case 'ops':
        try {
          state.project = applyOps(state.project, m.ops);
        } catch (err) {
          console.warn('ops fora de sincronia, recarregando', err);
          fetch('/api/project').then((r) => r.json()).then((d) => {
            state.project = d.project;
            audio.setProject(state.project);
            emit();
          });
        }
        state.rev = m.rev;
        state.dirty = true;
        fixSelection();
        audio.setProject(state.project);
        emit();
        break;
      case 'toast':
        toast(m.text, m.from);
        break;
      case 'error':
        toast(`Erro: ${m.error}`);
        break;
      case 'transport':
        remoteTransport(m);
        break;
      case 'preview':
        remotePreview(m);
        break;
    }
  };
}
connect();

function send(m: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function fixSelection() {
  const p = state.project;
  if (!state.patternId || !p.patterns.some((x) => x.id === state.patternId)) state.patternId = p.patterns[0]?.id ?? null;
  if (state.channelId && !p.channels.some((c) => c.id === state.channelId)) state.channelId = null;
  if (!state.channelId) state.channelId = p.channels[0]?.id ?? null;
  if (state.insert >= p.mixer.length) state.insert = 0;
}

// Status para o MCP saber o que está tocando.
setInterval(() => {
  const s = audio.status;
  send({ type: 'status', status: { playing: s.playing, mode: s.mode, bar: Math.floor(s.tick / ticksPerBar(state.project)) + 1, patternId: s.patternId, audioRunning: audio.running } });
}, 1000);

// ---------------------------------------------------------------- edição

/** Aplica ops localmente (resposta imediata) e envia ao servidor. */
export function edit(ops: Op[], label?: string) {
  if (!ops.length) return;
  try {
    state.project = applyOps(state.project, ops);
  } catch (e) {
    toast(`Erro: ${(e as Error).message}`);
    return;
  }
  state.dirty = true;
  fixSelection();
  audio.setProject(state.project);
  send({ type: 'ops', ops, label });
  emit();
}

/** Mudança local sem enviar (durante arrasto de knob); confirme depois com edit(). */
export function previewEdit(ops: Op[]) {
  try {
    state.project = applyOps(state.project, ops);
  } catch {
    return;
  }
  audio.setProject(state.project);
  emit();
}

/** Roda uma ação de alto nível do core e devolve o resultado. */
export function act<A>(fn: (p: Project, a: A) => ActionResult, args: A): any {
  try {
    const r = fn(state.project, args);
    edit(r.ops);
    return r.result;
  } catch (e) {
    toast(`Erro: ${(e as Error).message}`);
    return null;
  }
}

export const undo = () => send({ type: 'undo' });
export const redo = () => send({ type: 'redo' });

export async function api(method: 'GET' | 'POST', path: string, body?: unknown) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? r.statusText);
  return d;
}

let toastId = 0;
export function toast(text: string, from?: string) {
  const t = { id: ++toastId, text, from };
  state.toasts = [...state.toasts.slice(-4), t];
  emit();
  setTimeout(() => {
    state.toasts = state.toasts.filter((x) => x !== t);
    emit();
  }, from === 'mcp' ? 6000 : 3500);
}

// ---------------------------------------------------------------- janelas

let zTop = 10;
export function openWindow(id: WindowId, toggle = false) {
  const w = state.windows[id];
  if (toggle && w.open && w.z === zTop) w.open = false;
  else {
    w.open = true;
    w.z = ++zTop;
  }
  emit();
}
export function focusWindow(id: WindowId) {
  if (state.windows[id].z !== zTop) {
    state.windows[id].z = ++zTop;
    emit();
  }
}
export function closeWindow(id: WindowId) {
  state.windows[id].open = false;
  emit();
}

// ---------------------------------------------------------------- transporte

export function play(mode = state.mode) {
  state.mode = mode;
  playingFlag = true;
  audio.play(mode, state.patternId, undefined);
  emit();
}
export function stop() {
  audio.stop();
  playingFlag = false;
  emit();
}
export function togglePlay() {
  if (audio.status.playing) stop();
  else play();
}
export function setMode(mode: 'pattern' | 'song') {
  state.mode = mode;
  audio.post({ type: 'mode', mode, patternId: state.patternId });
  emit();
}
export function selectPattern(id: string) {
  state.patternId = id;
  audio.post({ type: 'pattern', patternId: id });
  emit();
}
export function selectChannel(id: string) {
  state.channelId = id;
  emit();
}

function remoteTransport(m: { action: string; mode?: 'pattern' | 'song'; pattern?: string; bar?: number }) {
  if (m.pattern) {
    const pat = findPattern(state.project, m.pattern);
    if (pat) selectPattern(pat.id);
  }
  if (m.action === 'stop') return stop();
  const mode = m.mode ?? state.mode;
  state.mode = mode;
  playingFlag = true;
  const tick = m.bar ? (m.bar - 1) * ticksPerBar(state.project) : undefined;
  audio.play(mode, state.patternId, tick);
  if (!audio.running) toast('O Claude pediu para tocar: clique em qualquer lugar para liberar o áudio.', 'mcp');
  emit();
}

function remotePreview(m: { channel: string; notes: { note: string | number; start: number | string; length?: number; velocity?: number }[] }) {
  const ch = findChannel(state.project, m.channel);
  if (!ch) return;
  const bpm = state.project.bpm;
  for (const n of m.notes) {
    let key = 60;
    try {
      key = parseNote(n.note);
    } catch {
      continue;
    }
    const startBeats = typeof n.start === 'number' ? n.start : Number(n.start) || 0;
    setTimeout(() => audio.liveOn(ch.id, key, n.velocity ?? 0.8, Math.round((n.length ?? 0.5) * PPQ)), (startBeats * 60000) / bpm);
  }
}

// Áudio só liga após gesto do usuário (política do navegador).
const unlock = () => {
  if (!audio.running) audio.start().then(emit);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);
