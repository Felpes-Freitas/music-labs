// Estado da interface: cópia local do projeto sincronizada com o servidor,
// seleção atual, janelas e status ao vivo da engine.

import { useEffect, useReducer } from 'preact/hooks';
import type { Project } from '../core/model';
import { emptyProject, findPattern, findChannel, parseNote, PPQ, ticksPerBar, songLength, uid } from '../core/model';
import { applyOps, set, type Op } from '../core/ops';
import type { ActionResult } from '../core/actions';
import * as A from '../core/actions';
import { encodeWav } from '../core/wav';
import type { EngineStatus } from '../core/engine';
import { getPref } from './prefs';
import { renderChain } from '../core/effects';
import type { EffectType, Params } from '../core/model';
import { startMidiRec, finishMidiRec, recNote, midiRecording, midiOnStatus } from './midirec';
import { setPref } from './prefs';
import { audio } from './audio';

export type WindowId = 'rack' | 'piano' | 'playlist' | 'mixer' | 'browser' | 'channel' | 'amp' | 'tune' | 'stitch';

export interface WinState {
  /** Geometria anterior quando a janela está maximizada. */
  max?: { x: number; y: number; w: number; h: number };
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
  const H = Math.max(480, window.innerHeight - 80); // barra de título + ferramentas
  const rackH = Math.min(340, Math.round(H * 0.42));
  return {
    browser: { open: true, x: 0, y: 0, w: 240, h: 0, z: 1 },
    rack: { open: true, x: 8, y: 8, w: Math.min(720, W * 0.55), h: rackH, z: 3 },
    // A playlist começa maximizada e no fundo; as outras janelas flutuam sobre ela.
    playlist: { open: true, x: 0, y: 0, w: W, h: H, z: 0, max: { x: 8, y: rackH + 16, w: W - 16, h: H - rackH - 24 } } as WinState,
    piano: { open: false, x: 40, y: 40, w: W - 80, h: H - 80, z: 4 },
    mixer: { open: false, x: 30, y: Math.max(8, H - 470), w: Math.min(W - 60, 1200), h: 450, z: 5 },
    channel: { open: false, x: Math.min(W - 480, Math.min(720, W * 0.55) + 16), y: 8, w: 470, h: 440, z: 6 },
    amp: { open: false, x: 40, y: Math.max(8, H - 520), w: Math.min(W - 80, 1040), h: Math.min(H - 16, 500), z: 7 },
    tune: { open: false, x: 30, y: 30, w: Math.min(W - 60, 1100), h: Math.min(H - 60, 560), z: 8 },
    stitch: { open: false, x: 50, y: 50, w: Math.min(W - 100, 1100), h: Math.min(H - 100, 520), z: 9 },
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
  hint: '' as string,
  /** Tela de carregamento (samples do projeto); null quando pronto. */
  loading: null as null | { done: number; total: number; label: string; pending: number },
  /** O navegador bloqueou o som: falta um clique para ligar. */
  needsClick: false,
  /** Incrementa a cada mudança no projeto: os canvas usam isso para repintar. */
  version: 0,
  /** Muda quando a biblioteca de samples é (re)varrida. */
  libraryVersion: 0,
  followPlay: true,
  windows: defaultLayout(),
  /** Área selecionada na playlist (ticks): o play começa nela e o loop fica nela. */
  sel: null as null | { start: number; end: number },
  loopOn: getPref('tr.loop', false),
  metronome: getPref('tr.metronome', false),
  countIn: getPref('tr.countIn', true),
  /** Contagem das ferramentas (Afinador, Stitcher), que não usam a música: tempos que faltam. */
  countdown: 0,
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
audio.getProject = () => state.project;
audio.onStatus = (s) => {
  for (const l of liveListeners) l(s);
  midiOnStatus(s);
  if (!s.playing && playingFlag) {
    playingFlag = false;
    emit();
  }
  if (!s.playing) reloadIfIdle();
};
let playingFlag = false;

// ---------------------------------------------------------------- versão da interface

/** Script principal desta página (o nome muda a cada build). */
const myBuild = ([...document.querySelectorAll('script[type=module]')] as HTMLScriptElement[]).map((x) => /assets\/index-[^"']+\.js/.exec(x.src)?.[0]).find(Boolean) ?? '';
let reloadPending = false;
/** O servidor tem uma interface mais nova (foi atualizado): recarrega — mas nunca no meio de uma gravação. */
function checkBuild() {
  if (!myBuild) return; // modo de desenvolvimento (vite)
  fetch('/api/build')
    .then((r) => r.json())
    .then((d) => {
      if (!d.build || d.build === myBuild) return;
      reloadPending = true;
      reloadIfIdle();
    })
    .catch(() => {});
}
function reloadIfIdle() {
  if (!reloadPending) return;
  if (audio.status.playing || audio.recording || audio.capturing) return; // tenta de novo ao parar
  toast('Versão nova do Music Labs: recarregando…');
  setTimeout(() => location.reload(), 600);
  reloadPending = false;
}
setInterval(checkBuild, 15000);

// ---------------------------------------------------------------- servidor

const clientId = Math.random().toString(36).slice(2);
let ws: WebSocket | null = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?client=${clientId}`);
  ws.onopen = () => {
    state.connected = true;
    emit();
    checkBuild();
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
        state.version++;
        fixSelection();
        prepareAudio();
        emit();
        break;
      case 'ops':
        try {
          state.project = applyOps(state.project, m.ops);
          audio.applyOps(m.ops, state.project);
        } catch (err) {
          console.warn('ops fora de sincronia, recarregando', err);
          fetch('/api/project').then((r) => r.json()).then((d) => {
            state.project = d.project;
            state.version++;
            audio.setProject(state.project);
            emit();
          });
        }
        state.rev = m.rev;
        state.dirty = true;
        state.version++;
        fixSelection();
        emit();
        break;
      case 'toast':
        toast(m.text, m.from);
        break;
      case 'library':
        state.libraryVersion++;
        emit();
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
  state.version++;
  fixSelection();
  audio.applyOps(ops, state.project);
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
  state.version++;
  audio.applyOps(ops, state.project);
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
/** Playlist maximizada funciona como fundo: clicar nela não a traz para a frente. */
const isBackground = (id: WindowId) => id === 'playlist' && !!state.windows.playlist.max;

export function openWindow(id: WindowId, toggle = false) {
  const w = state.windows[id];
  if (toggle && w.open && (w.z === zTop || isBackground(id))) w.open = false;
  else {
    w.open = true;
    if (!isBackground(id)) w.z = ++zTop;
  }
  emit();
}
export function focusWindow(id: WindowId, force = false) {
  if (isBackground(id) && !force) return;
  // a playlist maximizada volta para o fundo quando outra janela ganha o foco
  if (id !== 'playlist' && isBackground('playlist') && state.windows.playlist.z !== 0) state.windows.playlist.z = 0;
  if (state.windows[id].z !== zTop) {
    state.windows[id].z = ++zTop;
    emit();
  }
}
/** Tab: traz para a frente a próxima janela aberta (Shift+Tab: a anterior). */
export function cycleWindows(back = false) {
  const order: WindowId[] = ['playlist', 'rack', 'piano', 'mixer', 'channel', 'amp', 'tune', 'stitch'];
  const open = order.filter((id) => state.windows[id].open);
  if (!open.length) return;
  const top = open.reduce((a, b) => (state.windows[b].z > state.windows[a].z ? b : a));
  const i = open.indexOf(top);
  const next = open[(i + (back ? open.length - 1 : 1)) % open.length];
  focusWindow(next, true);
  setHint(`Janela: ${{ playlist: 'Playlist', rack: 'Rack de canais', piano: 'Piano roll', mixer: 'Mixer', channel: 'Canal' }[next as 'rack']}`);
}
/**
 * Encaixa as janelas na área de trabalho real: as maximizadas ocupam tudo e as
 * outras são puxadas para dentro (e encolhidas) se ficarem fora. Chamado quando
 * a área muda de tamanho (janela do app, navegador lateral aberto/fechado).
 */
export function fitWindows(W: number, H: number) {
  if (!W || !H) return;
  for (const w of Object.values(state.windows)) {
    if (w.h === 0) continue; // navegador lateral não é janela flutuante
    if (w.max) Object.assign(w, { x: 0, y: 0, w: W, h: H });
    else {
      w.w = Math.min(w.w, W);
      w.h = Math.min(w.h, H);
      w.x = Math.max(0, Math.min(w.x, W - w.w));
      w.y = Math.max(0, Math.min(w.y, H - w.h));
    }
  }
  emit();
}
export function closeWindow(id: WindowId) {
  state.windows[id].open = false;
  emit();
}

// ---------------------------------------------------------------- transporte

export function play(mode = state.mode) {
  state.mode = mode;
  playingFlag = true;
  // com uma área selecionada, a música começa no início dela
  audio.play(mode, state.patternId, mode === 'song' && state.sel ? state.sel.start : undefined);
  emit();
}

// ---------------------------------------------------------------- área selecionada, loop, metrônomo, contagem

export function setSelection(sel: { start: number; end: number } | null) {
  state.sel = sel && sel.end > sel.start ? sel : null;
  audio.transport({ region: state.sel ? [state.sel.start, state.sel.end] : null });
  emit();
}
export function toggleLoop() {
  state.loopOn = !state.loopOn;
  setPref('tr.loop', state.loopOn);
  audio.transport({ loopOn: state.loopOn });
  emit();
}
export function toggleMetronome() {
  state.metronome = !state.metronome;
  setPref('tr.metronome', state.metronome);
  audio.transport({ metronome: state.metronome });
  emit();
}
export function toggleCountIn() {
  state.countIn = !state.countIn;
  setPref('tr.countIn', state.countIn);
  emit();
}
audio.transport({ loopOn: state.loopOn, metronome: state.metronome });
audio.recLatencyMs = getPref<number | null>('rec.latencyMs', null);

/** Contagem de 4 tempos (se ligada) antes de gravar nas ferramentas que não tocam a música. */
export async function countInIfOn() {
  if (!state.countIn) return;
  await audio.countInClicks(4, state.project.bpm, (n) => {
    state.countdown = n;
    emit();
  });
}
audio.onLive = recNote;

/** Gravar notas e automações (o REC geral): toca a música a partir da seleção/posição. */
function toggleMidiRecord() {
  if (midiRecording()) return stop();
  const p = state.project;
  const start = state.sel ? state.sel.start : audio.status.mode === 'song' ? Math.max(0, Math.floor(audio.status.tick)) : 0;
  // loop só com uma área selecionada; sem área, grava sem fim (não volta no fim da música)
  const region: [number, number] | null = state.loopOn && state.sel ? [state.sel.start, state.sel.end] : null;
  audio.transport({ endless: true });
  startMidiRec(start, region);
  state.mode = 'song';
  playingFlag = true;
  audio.play('song', state.patternId, start, state.countIn ? 4 : 0);
  const ch = p.channels.find((c) => c.id === state.channelId);
  toast(`Gravando notas${ch ? ` (${ch.name})` : ''} e automações${state.countIn ? ' · contagem de 4 tempos' : ''} — Espaço ou ■ para parar`);
  emit();
}
/** Parar: a primeira vez para a música; parado, corta também as caudas (reverb, eco, notas soltas). */
export function stop() {
  if (midiRecording()) {
    const tps = (state.project.bpm * PPQ) / 60;
    finishMidiRec(audio.status.tick + ((performance.now() - audio.statusAt) / 1000) * tps);
  } else if (!audio.status.playing && !audio.recording) {
    audio.post({ type: 'panic' });
    return;
  }
  audio.stop();
  audio.transport({ endless: false });
  audio.status = { ...audio.status, playing: false, countIn: 0 }; // a interface reage já, sem esperar a engine
  playingFlag = false;
  if (audio.recording) finishRecording();
  emit();
}
export function togglePlay() {
  if (audio.status.playing || audio.recording || midiRecording()) stop();
  else play();
}

/** Gravação pelo amp: entrada crua + cadeia para reaplicar em alta qualidade. */
export interface AmpTake {
  chain: { type: EffectType; enabled: boolean; mix: number; params: Params }[];
  inGainDb: number;
  outGainDb: number;
  pick: 'stereo' | 'left' | 'right';
  smart: { marginDb: number; holdSec: number; thresholdDb: number; deviceId?: string } | null;
}
let ampTake: AmpTake | null = null;
let recDone: ((clipIds: string[]) => void) | null = null;

/** Configuração da gravação inteligente (a mesma do amp). */
export function smartConfig() {
  const a = getPref<{ smart?: boolean; thresholdDb?: number; marginDb?: number; holdSec?: number }>('amp', {});
  return { marginDb: a.marginDb ?? 10, holdSec: a.holdSec ?? 1.5, thresholdDb: a.thresholdDb ?? -45 };
}

/** Gravar: toca a música em modo song a partir da posição atual e captura a entrada. */
export async function toggleRecord(fromAmp: AmpTake | null = null, extra: { smart?: boolean; onDone?: (clipIds: string[]) => void; audio?: boolean } = {}) {
  if (audio.recording || midiRecording()) return stop();
  // o REC geral grava notas e automações; áudio (voz, guitarra) fica com o amp e as ferramentas
  if (!fromAmp && !extra.audio && !extra.smart) return toggleMidiRecord();
  const countBeats = state.countIn ? 4 : 0;
  // como no REC geral: começa na área selecionada (ou onde a agulha está)
  const start = state.sel ? state.sel.start : audio.status.mode === 'song' ? Math.max(0, Math.floor(audio.status.tick)) : 0;
  try {
    const track = A.freeTrack(state.project, start, 1e12);
    if (fromAmp) {
      const stream = audio.ampStream;
      if (!stream) throw new Error('o amp está desligado');
      recBaseTrack = track;
      liveTakes.clear();
      // com loop, cada volta vira um take que entra na playlist assim que fecha (e toca na próxima volta)
      const p = state.project;
      // loop só com uma área selecionada; sem área, a gravação segue sem fim (não volta no fim da música)
      const loop: [number, number] | null = state.loopOn && state.sel ? [state.sel.start, state.sel.end] : null;
      void p;
      audio.transport({ endless: true });
      await audio.startRecording(start, track, { stream, channels: fromAmp.pick, gainDb: fromAmp.inGainDb, smart: fromAmp.smart ?? undefined, countInSec: (countBeats * 60) / state.project.bpm, loop, onTakeClosed: placeLiveTake });
    } else {
      const deviceId = getPref<string>('rec.device', '') || undefined;
      await audio.startRecording(start, track, { deviceId, channels: getPref('rec.channels', 'stereo'), smart: extra.smart ? { ...smartConfig(), deviceId } : undefined });
    }
    ampTake = fromAmp;
    recDone = extra.onDone ?? null;
  } catch (e) {
    toast(`Não consegui acessar a entrada de áudio: ${(e as Error).message}`);
    return;
  }
  state.mode = 'song';
  playingFlag = true;
  audio.play('song', state.patternId, start, countBeats);
  toast(fromAmp?.smart || extra.smart ? 'Gravação inteligente: toque quando quiser, cada trecho vira um clipe (■ para parar)' : 'Gravando… (Espaço ou ■ para parar)');
  emit();
}

/** A playlist registra aqui como desenhar a onda de um take que ainda não tem arquivo. */
export let livePeaks: (path: string, L: Float32Array, sr: number) => void = () => {};
export const setLivePeaksHandler = (fn: typeof livePeaks) => void (livePeaks = fn);

/** Takes já colocados na playlist durante a gravação (prévia "live:"), por índice do take. */
const liveTakes = new Map<number, string>();
let recBaseTrack = 0;

/** Primeira track, a partir de `from`, sem nada no trecho [pos, pos+len). */
function freeTrackFrom(from: number, pos: number, len: number) {
  const p = state.project;
  for (let t = from; ; t++) if (!p.clips.some((c) => c.track === t && c.pos < pos + len && c.pos + c.len > pos)) return t;
}

/**
 * Um take acabou de fechar (fim de uma volta do loop, ou pausa na gravação
 * inteligente): entra já na playlist numa versão rápida, para tocar na próxima volta.
 */
function placeLiveTake(k: number) {
  const a = audio.takeAudio(k);
  if (!a || a.L.length < a.sr * 0.08) return;
  const amp = ampTake;
  const [L, R] = amp ? renderChain(a.sr, amp.chain, a.L, a.R, { bpm: state.project.bpm, outGainDb: amp.outGainDb, tailSec: 0, hq: false }) : [a.L, a.R];
  const path = `live:${uid('take')}`;
  audio.postLiveSample(path, a.sr, [L, R]);
  livePeaks(path, L, a.sr);
  const tps = (state.project.bpm * PPQ) / 60;
  const len = Math.max(1, Math.round((L.length / a.sr) * tps));
  const track = freeTrackFrom(recBaseTrack, Math.round(a.tick), len);
  const r = act(A.addAudioClip, { sample: path, bar: 1, beat: a.tick / PPQ, track: track + 1, lengthSec: L.length / a.sr });
  if (r) liveTakes.set(k, (r as { clip: string }).clip);
}

async function finishRecording() {
  const r = audio.stopRecording();
  const amp = ampTake;
  ampTake = null;
  const done = recDone;
  recDone = null;
  const live = new Map(liveTakes);
  liveTakes.clear();
  const ids: string[] = [];
  emit();
  if (!r) return;
  const takes = r.takes.filter((t) => t.L.length >= r.sr * 0.08);
  if (!takes.length) {
    if (amp?.smart) toast('Nada foi tocado: nenhum clipe criado');
    return;
  }
  if (amp) toast(`Aplicando os efeitos em alta qualidade (${takes.length} ${takes.length > 1 ? 'takes' : 'take'})…`);
  let placed = 0;
  const tps = (state.project.bpm * PPQ) / 60;
  for (const t of takes) {
    try {
      // o retorno usou a cadeia leve; aqui ela roda de novo, sobreamostrada
      let [L, R] = amp ? renderChain(r.sr, amp.chain, t.L, t.R, { bpm: state.project.bpm, outGainDb: amp.outGainDb, tailSec: 2.5 }) : [t.L, t.R];
      const clipId = live.get(t.k);
      const clip = clipId ? state.project.clips.find((c) => c.id === clipId) : undefined;
      const pos = clip ? clip.pos : Math.round(t.tick);
      const rawLen = Math.max(1, Math.round((t.L.length / r.sr) * tps));
      const track = clip ? clip.track : freeTrackFrom(recBaseTrack, pos, rawLen);
      // a cauda dos efeitos vai até o próximo clipe da mesma track (com um fade curto)
      const next = state.project.clips.filter((c) => c.track === track && c.id !== clipId && c.pos >= pos + rawLen - 1).sort((x, y) => x.pos - y.pos)[0];
      const max = next ? Math.max(t.L.length, Math.floor(((next.pos - pos) / tps) * r.sr)) : L.length;
      if (L.length > max) {
        L = L.slice(0, max);
        R = R.slice(0, max);
        const fade = Math.min(max, Math.round(0.03 * r.sr));
        for (let i = 0; i < fade; i++) {
          const g = i / fade;
          L[max - 1 - i] *= g;
          R[max - 1 - i] *= g;
        }
      }
      const wav = encodeWav(L, R, r.sr, 24);
      const res = await fetch(`/api/recording?name=${encodeURIComponent(state.project.name)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Blob([wav as BlobPart], { type: 'audio/wav' }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      const lenTicks = Math.max(1, Math.round((L.length / r.sr) * tps));
      if (clip) {
        // a prévia vira o arquivo em alta qualidade, no mesmo lugar
        edit([set(['clips', clip.id, 'sample'], d.path), set(['clips', clip.id, 'len'], lenTicks)]);
        ids.push(clip.id);
        placed++;
      } else {
        const result = act(A.addAudioClip, { sample: d.path, bar: 1, beat: pos / PPQ, track: track + 1, lengthSec: L.length / r.sr });
        if (result) {
          placed++;
          ids.push((result as { clip: string }).clip);
        }
      }
    } catch (e) {
      toast(`Erro ao salvar a gravação: ${(e as Error).message}`);
    }
  }
  if (ids.length) done?.(ids);
  if (placed) toast(placed > 1 ? `${placed} takes gravados e colocados na playlist` : `Gravação colocada na playlist (${(takes[0].L.length / r.sr).toFixed(1)} s)`);
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
/**
 * Prepara a engine, carrega os samples do projeto atrás da tela de
 * carregamento e liga o som no fim. Se o navegador exigir um clique para
 * tocar, a tela pede esse clique uma vez.
 */
let preparing: Promise<void> | null = null;
let firstLoad = true;
async function prepareAudio() {
  if (preparing) await preparing;
  preparing = (async () => {
    await audio.init();
    audio.setProject(state.project);
    // undo/redo e projetos sem samples novos não mostram a tela
    if (audio.pending || firstLoad) {
      audio.progress.done = audio.progress.total = 0;
      state.loading = { done: 0, total: 0, label: '', pending: audio.pending };
      emit();
      await audio.idle();
    }
    firstLoad = false;
    const ok = await audio.resume();
    state.loading = null;
    state.needsClick = !ok;
    emit();
  })();
  await preparing;
  preparing = null;
}
audio.onProgress = () => {
  if (!state.loading) return;
  state.loading = { ...audio.progress, pending: audio.pending };
  emit();
};

const unlock = () => {
  if (audio.running) return;
  audio.resume().then((ok) => {
    if (ok && state.needsClick) {
      state.needsClick = false;
      emit();
    }
  });
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// Barra de dicas: assinatura própria, para passar o mouse não redesenhar o app.
const hintListeners = new Set<() => void>();
export function setHint(h: string) {
  if (h === state.hint) return;
  state.hint = h;
  for (const l of hintListeners) l();
}
export function useHint() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const l = () => force(undefined);
    hintListeners.add(l);
    return () => void hintListeners.delete(l);
  }, []);
  return state.hint;
}
window.addEventListener('pointerover', (e) => {
  const el = (e.target as HTMLElement)?.closest?.('[data-hint], [title]') as HTMLElement | null;
  setHint(el?.getAttribute('data-hint') ?? el?.getAttribute('title') ?? '');
});
