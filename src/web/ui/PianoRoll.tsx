import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, previewEdit, onLive, selectChannel, act, setHint } from '../state';
import { audio } from '../audio';
import { PPQ, STEP, noteName, patternLength, ticksPerBar, uid, type Note } from '../../core/model';
import { set } from '../../core/ops';
import { SCALES, inScale, pitchClass } from '../../core/theory';
import * as A from '../../core/actions';
import { Win, IconBtn, useCanvas } from './widgets';

const RULER = 24;
const KEYS = 66;
const SB = 11;
const BLACK = new Set([1, 3, 6, 8, 10]);

const SNAPS: [string, number][] = [
  ['Compasso', 384],
  ['1/2', 192],
  ['Tempo', 96],
  ['1/2 tempo', 48],
  ['Step', 24],
  ['1/2 step', 12],
  ['1/4 step', 6],
  ['Tercina 1/4', 64],
  ['Tercina 1/8', 32],
  ['Tercina 1/16', 16],
  ['Livre', 1],
];

const CHORDS: Record<string, number[]> = {
  nenhum: [0],
  maior: [0, 4, 7],
  menor: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  '9': [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '5 (power)': [0, 7, 12],
  oitava: [0, 12],
};

type Tool = 'draw' | 'paint' | 'erase' | 'mute' | 'slice' | 'select';
type Lane = 'vel' | 'pan';

type Drag =
  | { kind: 'move'; ids: Set<string>; x0: number; y0: number; orig: Note[]; dKey: number; dPos: number; created?: boolean }
  | { kind: 'resize'; ids: Set<string>; x0: number; orig: Note[] }
  | { kind: 'select'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: 'erase' }
  | { kind: 'mute'; value: boolean; done: Set<string> }
  | { kind: 'paint'; key: number; last: number }
  | { kind: 'lane' }
  | { kind: 'laneSize'; y0: number; h0: number }
  | { kind: 'hbar'; x0: number; s0: number }
  | { kind: 'vbar'; y0: number; s0: number }
  | { kind: 'ruler' }
  | { kind: 'keys'; key: number };

let clipboard: Note[] = [];

export function PianoRoll() {
  const s = useApp();
  const p = s.project;
  const pat = p.patterns.find((x) => x.id === s.patternId);
  const ch = p.channels.find((c) => c.id === s.channelId);
  const notes: Note[] = (pat && ch && pat.notes[ch.id]) || [];
  const view = useRef({ scrollX: 0, scrollY: 0, zx: 0.6, rowH: 15, laneH: 86 });
  const [sel, setSelState] = useState<Set<string>>(new Set());
  const selRef = useRef(sel);
  const setSel = (v: Set<string>) => {
    selRef.current = v;
    setSelState(v);
  };
  const [tool, setTool] = useState<Tool>('draw');
  const [lane, setLane] = useState<Lane>('vel');
  const [chord, setChord] = useState('nenhum');
  const [ghost, setGhost] = useState(true);
  const [lockScale, setLockScale] = useState(false);
  const lastLen = useRef(STEP * 2);
  const drag = useRef<Drag | null>(null);
  const playTick = useRef(-1);
  const pressed = useRef<number | null>(null);
  const hover = useRef<{ key: number; tick: number } | null>(null);

  const snap = s.snap;
  const bar = ticksPerBar(p);
  const plen = pat ? patternLength(p, pat) : bar;
  const color = ch?.color ?? '#5fb3d9';

  // geometria
  const geo = (w: number, h: number) => {
    const v = view.current;
    const gridR = w - SB;
    const laneTop = h - SB - v.laneH;
    const gridB = laneTop - 4;
    return { gridL: KEYS, gridR, gridT: RULER, gridB, laneTop, laneB: h - SB, w, h };
  };
  const contentW = () => Math.max(plen + bar * 4, ...notes.map((n) => n.pos + n.len + bar));
  const keyY = (key: number) => RULER + (127 - key) * view.current.rowH - view.current.scrollY;
  const tickX = (t: number) => KEYS + (t - view.current.scrollX) * view.current.zx;

  const { ref, paint, paintOverlay, size } = useCanvas(
    (ctx, w, h) => {
      const v = view.current;
      const g = geo(w, h);
      const rows = v.rowH;
      ctx.fillStyle = '#1a1f22';
      ctx.fillRect(0, 0, w, h);

      // ---------------- grade
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.gridL, g.gridT, g.gridR - g.gridL, g.gridB - g.gridT);
      ctx.clip();
      const kTop = Math.min(127, 127 - Math.floor(v.scrollY / rows));
      const kBot = Math.max(0, kTop - Math.ceil((g.gridB - g.gridT) / rows) - 1);
      for (let key = kTop; key >= kBot; key--) {
        const y = keyY(key);
        const pc = ((key % 12) + 12) % 12;
        const out = s.scale !== 'chromatic' && !inScale(key, s.scaleRoot, s.scale);
        const root = s.scale !== 'chromatic' && pc === pitchClass(s.scaleRoot);
        ctx.fillStyle = root ? '#2b3a3c' : out ? '#1b2023' : BLACK.has(pc) ? '#23292d' : '#2a3135';
        ctx.fillRect(g.gridL, y, g.gridR - g.gridL, rows);
        ctx.fillStyle = pc === 0 ? '#424d54' : '#20262a';
        ctx.fillRect(g.gridL, y + rows - 1, g.gridR - g.gridL, 1);
      }
      const minor = snap > 1 && snap < PPQ && snap * v.zx >= 5 ? snap : STEP * v.zx >= 5 ? STEP : PPQ;
      const t0 = Math.floor(v.scrollX / minor) * minor;
      for (let t = t0; tickX(t) < g.gridR; t += minor) {
        const x = Math.round(tickX(t)) + 0.5;
        ctx.strokeStyle = t % bar === 0 ? '#5d6970' : t % PPQ === 0 ? '#3d474e' : '#2c3439';
        ctx.lineWidth = t % bar === 0 ? 1.2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, g.gridT);
        ctx.lineTo(x, g.gridB);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      // fora do pattern
      const endX = tickX(plen);
      if (endX < g.gridR) {
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        ctx.fillRect(Math.max(g.gridL, endX), g.gridT, g.gridR - endX, g.gridB - g.gridT);
        ctx.fillStyle = '#e0a03a';
        ctx.fillRect(endX, g.gridT, 1.5, g.gridB - g.gridT);
      }
      // ghost notes
      if (ghost && pat)
        for (const [cid, list] of Object.entries(pat.notes)) {
          if (cid === ch?.id) continue;
          const gc = p.channels.find((c) => c.id === cid)?.color ?? '#999';
          ctx.strokeStyle = gc;
          ctx.globalAlpha = 0.35;
          for (const n of list) {
            const y = keyY(n.key);
            if (y < g.gridT - rows || y > g.gridB) continue;
            ctx.strokeRect(tickX(n.pos) + 0.5, y + 2.5, Math.max(2, n.len * v.zx - 1), rows - 5);
          }
          ctx.globalAlpha = 1;
        }
      // notas
      for (const n of notes) {
        const x = tickX(n.pos);
        const y = keyY(n.key);
        const nw = Math.max(3, n.len * v.zx - 1);
        if (x + nw < g.gridL || x > g.gridR || y < g.gridT - rows || y > g.gridB) continue;
        const selected = sel.has(n.id);
        ctx.fillStyle = n.mute ? '#4d5559' : selected ? '#ff8f8f' : shade(color, 0.55 + 0.45 * n.vel);
        roundRect(ctx, x, y + 1, nw, rows - 2, 2.5);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + 1, y + 2, nw - 2, 2);
        ctx.strokeStyle = selected ? '#fff' : 'rgba(0,0,0,0.55)';
        roundRect(ctx, x + 0.5, y + 1.5, nw - 1, rows - 3, 2.5);
        ctx.stroke();
        if (n.slide) {
          ctx.fillStyle = '#111';
          ctx.beginPath();
          ctx.moveTo(x + nw - 8, y + rows - 3);
          ctx.lineTo(x + nw - 2, y + rows / 2);
          ctx.lineTo(x + nw - 8, y + 3);
          ctx.fill();
        }
        if (nw > 24 && rows >= 11) {
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.font = `${Math.min(10, rows - 4)}px sans-serif`;
          ctx.fillText(noteName(n.key), x + 4, y + rows - 4);
        }
      }
      ctx.restore();

      // ---------------- teclado
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, g.gridT, KEYS, g.gridB - g.gridT);
      ctx.clip();
      ctx.fillStyle = '#d9dcde';
      ctx.fillRect(0, g.gridT, KEYS, g.gridB - g.gridT);
      // teclas brancas: cada oitava (12 linhas) dividida em 7
      for (let oct = Math.floor(kBot / 12) - 1; oct <= Math.floor(kTop / 12) + 1; oct++) {
        const c = oct * 12;
        const bottom = keyY(c) + rows;
        const wh = (12 * rows) / 7;
        for (let i = 0; i < 7; i++) {
          const y1 = bottom - (i + 1) * wh;
          const keyOf = c + [0, 2, 4, 5, 7, 9, 11][i];
          const isPressed = pressed.current === keyOf;
          ctx.fillStyle = isPressed ? '#f2a93b' : '#e9ecee';
          ctx.fillRect(0, y1, KEYS - 1, wh - 1);
          ctx.fillStyle = '#9aa1a5';
          ctx.fillRect(0, y1 + wh - 1, KEYS - 1, 1);
          if (i === 0 && rows >= 8) {
            ctx.fillStyle = '#5c6367';
            ctx.font = '9px sans-serif';
            ctx.fillText(noteName(c), KEYS - 26, bottom - 4);
          }
        }
      }
      for (let key = kTop; key >= kBot; key--) {
        if (!BLACK.has(((key % 12) + 12) % 12)) continue;
        const y = keyY(key);
        ctx.fillStyle = pressed.current === key ? '#f2a93b' : '#1b1e20';
        ctx.fillRect(0, y + 1, KEYS * 0.6, rows - 2);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(2, y + 2, KEYS * 0.6 - 5, 2);
      }
      ctx.fillStyle = '#0d1012';
      ctx.fillRect(KEYS - 1, g.gridT, 1, g.gridB - g.gridT);
      ctx.restore();

      // ---------------- régua
      ctx.fillStyle = '#2b3337';
      ctx.fillRect(0, 0, w, RULER);
      ctx.save();
      ctx.beginPath();
      ctx.rect(KEYS, 0, g.gridR - KEYS, RULER);
      ctx.clip();
      ctx.font = '10px sans-serif';
      const every = v.zx * bar < 30 ? 4 : v.zx * bar < 60 ? 2 : 1;
      for (let t = Math.floor(v.scrollX / PPQ) * PPQ; tickX(t) < g.gridR; t += PPQ) {
        const x = Math.round(tickX(t)) + 0.5;
        if (t % bar === 0) {
          const b = t / bar;
          ctx.fillStyle = '#9aa7ae';
          ctx.fillRect(x, 10, 1, RULER - 10);
          if (b % every === 0) {
            ctx.fillStyle = '#d8dde0';
            ctx.fillText(String(b + 1), x + 3, 11);
          }
        } else if (v.zx * PPQ > 14) {
          ctx.fillStyle = '#5e6a70';
          ctx.fillRect(x, RULER - 6, 1, 6);
          if (v.zx * PPQ > 50) {
            ctx.fillStyle = '#7b878d';
            ctx.fillText(`${t / bar + 1 | 0}.${((t % bar) / PPQ) + 1}`, x + 2, RULER - 8);
          }
        }
      }
      // fim do pattern e cabeça
      ctx.fillStyle = '#e0a03a';
      const ex = tickX(plen);
      ctx.beginPath();
      ctx.moveTo(ex, RULER);
      ctx.lineTo(ex - 6, RULER - 7);
      ctx.lineTo(ex, RULER - 7);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#1f2528';
      ctx.fillRect(0, 0, KEYS, RULER);
      ctx.fillStyle = color;
      ctx.fillRect(4, 6, 4, 12);
      ctx.fillStyle = '#d8dde0';
      ctx.font = '10px sans-serif';
      ctx.fillText((ch?.name ?? '—').slice(0, 9), 12, 16);

      // ---------------- faixa de eventos
      ctx.fillStyle = '#14181a';
      ctx.fillRect(0, g.laneTop - 4, w, g.laneB - g.laneTop + 4);
      ctx.fillStyle = '#3a454b';
      ctx.fillRect(0, g.laneTop - 4, w, 3);
      ctx.fillStyle = '#9aa7ae';
      ctx.font = '10px sans-serif';
      ctx.fillText(lane === 'vel' ? 'Velocity' : 'Pan', 8, g.laneTop + 14);
      ctx.fillStyle = '#6b777d';
      ctx.fillText('clique: trocar', 8, g.laneTop + 27);
      ctx.save();
      ctx.beginPath();
      ctx.rect(KEYS, g.laneTop, g.gridR - KEYS, g.laneB - g.laneTop);
      ctx.clip();
      const lh = g.laneB - g.laneTop - 8;
      if (lane === 'pan') {
        ctx.fillStyle = '#2c3439';
        ctx.fillRect(KEYS, g.laneTop + 4 + lh / 2, g.gridR - KEYS, 1);
      }
      for (const n of notes) {
        const x = tickX(n.pos);
        if (x < KEYS - 4 || x > g.gridR) continue;
        const selected = sel.has(n.id);
        ctx.fillStyle = selected ? '#ff8f8f' : n.mute ? '#4d5559' : color;
        if (lane === 'vel') {
          const vh = n.vel * lh;
          ctx.fillRect(x, g.laneB - 4 - vh, 2, vh);
          ctx.beginPath();
          ctx.arc(x + 1, g.laneB - 4 - vh, 3, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const mid = g.laneTop + 4 + lh / 2;
          const py = mid - (n.pan ?? 0) * (lh / 2);
          ctx.fillRect(x, Math.min(mid, py), 2, Math.abs(py - mid) || 1);
          ctx.beginPath();
          ctx.arc(x + 1, py, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // ---------------- barras de rolagem
      const cw = contentW() * v.zx;
      const viewW = g.gridR - KEYS;
      ctx.fillStyle = '#15191b';
      ctx.fillRect(KEYS, h - SB, viewW, SB);
      const hx = KEYS + (v.scrollX * v.zx / cw) * viewW;
      const hw = Math.max(24, (viewW / cw) * viewW);
      ctx.fillStyle = '#4b585f';
      roundRect(ctx, hx, h - SB + 2, Math.min(hw, viewW), SB - 4, 3);
      ctx.fill();
      const ch2 = 128 * rows;
      const viewH = g.gridB - g.gridT;
      ctx.fillStyle = '#15191b';
      ctx.fillRect(g.gridR, g.gridT, SB, viewH);
      const vy = g.gridT + (v.scrollY / ch2) * viewH;
      const vhh = Math.max(24, (viewH / ch2) * viewH);
      ctx.fillStyle = '#4b585f';
      roundRect(ctx, g.gridR + 2, vy, SB - 4, Math.min(vhh, viewH), 3);
      ctx.fill();
      ctx.fillStyle = '#1f2528';
      ctx.fillRect(0, h - SB, KEYS, SB);
      ctx.fillRect(g.gridR, 0, SB, RULER);
      ctx.fillRect(g.gridR, g.gridB, SB, h - g.gridB);
    },
    [s.version, s.patternId, s.channelId, sel, ghost, snap, s.scale, s.scaleRoot, tool, lane, chord],
    (ctx, w, h) => {
      // Camada de cima: prévia sob o mouse, retângulo de seleção e cursor de reprodução.
      const v = view.current;
      const g = geo(w, h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.gridL, g.gridT, g.gridR - g.gridL, g.gridB - g.gridT);
      ctx.clip();
      if (hover.current && !drag.current && (tool === 'draw' || tool === 'paint')) {
        const hv = hover.current;
        const keys = (CHORDS[chord] ?? [0]).map((iv) => hv.key + iv);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.setLineDash([3, 3]);
        for (const k of keys) ctx.strokeRect(tickX(hv.tick) + 0.5, keyY(k) + 1.5, Math.max(3, lastLen.current * v.zx - 1), v.rowH - 3);
        ctx.setLineDash([]);
      }
      const d = drag.current;
      if (d?.kind === 'select') {
        ctx.fillStyle = 'rgba(120,190,255,0.12)';
        ctx.strokeStyle = '#8cc8ff';
        const rx = Math.min(d.x0, d.x1), ry = Math.min(d.y0, d.y1);
        ctx.fillRect(rx, ry, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
        ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      }
      ctx.restore();
      if (playTick.current >= 0) {
        const x = tickX(playTick.current);
        if (x >= KEYS && x < g.gridR) {
          ctx.fillStyle = '#9fe0ff';
          ctx.fillRect(x, g.gridT, 1.5, g.gridB - g.gridT);
          ctx.beginPath();
          ctx.moveTo(x - 5, RULER - 8);
          ctx.lineTo(x + 5, RULER - 8);
          ctx.lineTo(x, RULER);
          ctx.fill();
        }
      }
    },
  );

  const clampView = () => {
    const v = view.current;
    const { w, h } = size.current;
    const g = geo(w, h);
    v.scrollY = Math.max(0, Math.min(128 * v.rowH - (g.gridB - g.gridT), v.scrollY));
    v.scrollX = Math.max(0, Math.min(contentW() - (g.gridR - KEYS) / v.zx, v.scrollX));
    if (v.scrollX < 0) v.scrollX = 0;
  };

  useEffect(
    () =>
      onLive((st) => {
        const t = st.playing && st.mode === 'pattern' && st.patternId === state.patternId ? st.tick : -1;
        if (t !== playTick.current) {
          playTick.current = t;
          let scrolled = false;
          if (t >= 0 && state.followPlay) {
            const v = view.current;
            const w = size.current.w - SB;
            const x = KEYS + (t - v.scrollX) * v.zx;
            if (x > w - 20 || x < KEYS) {
              v.scrollX = Math.max(0, t - 10 / v.zx);
              scrolled = true;
            }
          }
          if (scrolled) paint();
          else paintOverlay();
        }
      }),
    [],
  );

  // centraliza nas notas (ou em C5) ao trocar de canal/pattern
  useEffect(() => {
    const v = view.current;
    const { h } = size.current;
    const mid = notes.length ? (Math.max(...notes.map((n) => n.key)) + Math.min(...notes.map((n) => n.key))) / 2 : 66;
    v.scrollY = (127 - mid) * v.rowH - Math.max(100, (h - RULER - v.laneH) / 2);
    v.scrollX = 0;
    clampView();
    setSel(new Set());
    paint();
  }, [s.channelId, s.patternId, s.windows.piano.open]);

  // ---------------------------------------------------------------- edição

  const curNotes = (): Note[] => (pat && ch ? (state.project.patterns.find((q) => q.id === pat.id)?.notes[ch.id] ?? []) : []);
  const commit = (next: Note[]) => pat && ch && edit([set(['patterns', pat.id, 'notes', ch.id], next)]);
  const preview = (next: Note[]) => pat && ch && previewEdit([set(['patterns', pat.id, 'notes', ch.id], next)]);

  const local = (e: PointerEvent | WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const keyAt = (y: number) => 127 - Math.floor((y - RULER + view.current.scrollY) / view.current.rowH);
  const tickAt = (x: number) => view.current.scrollX + (x - KEYS) / view.current.zx;
  const snapFloor = (t: number) => (snap > 1 ? Math.floor(t / snap) * snap : Math.round(t));
  const snapRound = (t: number) => (snap > 1 ? Math.round(t / snap) * snap : Math.round(t));
  const fitScale = (k: number) => {
    if (!lockScale || s.scale === 'chromatic') return k;
    for (let d = 0; d < 7; d++) {
      if (inScale(k - d, s.scaleRoot, s.scale)) return k - d;
      if (inScale(k + d, s.scaleRoot, s.scale)) return k + d;
    }
    return k;
  };
  const hit = (x: number, y: number, list = notes) => {
    const v = view.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const nx = tickX(n.pos);
      const ny = keyY(n.key);
      const nw = Math.max(4, n.len * v.zx);
      if (x >= nx && x <= nx + nw && y >= ny && y < ny + v.rowH) return { n, edge: x > nx + nw - Math.min(7, nw / 3) };
    }
    return null;
  };
  const audition = (key: number, vel = 0.8, len = 48) => ch && audio.liveOn(ch.id, key, vel, len);

  const onDown = (e: PointerEvent) => {
    if (!pat || !ch) return;
    const [x, y] = local(e);
    const { w, h } = size.current;
    const g = geo(w, h);
    const v = view.current;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    // scrollbars
    if (y >= h - SB && x >= KEYS && x < g.gridR) return void (drag.current = { kind: 'hbar', x0: x, s0: v.scrollX });
    if (x >= g.gridR && y >= g.gridT && y < g.gridB) return void (drag.current = { kind: 'vbar', y0: y, s0: v.scrollY });
    // separador da faixa de eventos
    if (y >= g.laneTop - 5 && y < g.laneTop) return void (drag.current = { kind: 'laneSize', y0: y, h0: v.laneH });
    // régua
    if (y < RULER && x >= KEYS) {
      drag.current = { kind: 'ruler' };
      seekTo(x);
      return;
    }
    // teclado
    if (x < KEYS && y >= g.gridT && y < g.gridB) {
      const k = keyFromKeyboard(x, y);
      pressed.current = k;
      audio.liveOn(ch.id, k, 0.85);
      drag.current = { kind: 'keys', key: k };
      paint();
      return;
    }
    // faixa de eventos
    if (y >= g.laneTop) {
      if (x < KEYS) {
        setLane(lane === 'vel' ? 'pan' : 'vel');
        return;
      }
      drag.current = { kind: 'lane' };
      laneSet(x, y);
      return;
    }
    if (y < g.gridT || x < KEYS) return;

    const hn = hit(x, y);
    const right = e.button === 2;
    const t: Tool = right ? 'erase' : e.ctrlKey && tool === 'draw' ? 'select' : tool;
    if (t === 'erase') {
      drag.current = { kind: 'erase' };
      if (hn) commit(notes.filter((n) => n.id !== hn.n.id));
      return;
    }
    if (t === 'mute') {
      if (!hn) return;
      const value = !hn.n.mute;
      drag.current = { kind: 'mute', value, done: new Set([hn.n.id]) };
      preview(notes.map((n) => (n.id === hn.n.id ? { ...n, mute: value || undefined } : n)));
      return;
    }
    if (t === 'slice') {
      if (!hn) return;
      const at = snapRound(tickAt(x));
      const n = hn.n;
      if (at <= n.pos || at >= n.pos + n.len) return;
      commit(notes.flatMap((q) => (q.id === n.id ? [{ ...q, len: at - q.pos }, { ...q, id: uid('n'), pos: at, len: q.pos + q.len - at }] : [q])));
      return;
    }
    if (t === 'select' && !hn) {
      drag.current = { kind: 'select', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey };
      return;
    }
    if (hn) {
      let ids = sel.has(hn.n.id) ? sel : new Set([hn.n.id]);
      if (e.shiftKey) {
        ids = new Set(sel);
        ids.has(hn.n.id) ? ids.delete(hn.n.id) : ids.add(hn.n.id);
      }
      setSel(ids);
      lastLen.current = hn.n.len;
      if (hn.edge && t !== 'select') drag.current = { kind: 'resize', ids, x0: x, orig: notes };
      else {
        drag.current = { kind: 'move', ids, x0: x, y0: y, orig: notes, dKey: 0, dPos: 0 };
        audition(hn.n.key, hn.n.vel, Math.min(hn.n.len, 96));
      }
      return;
    }
    // criar nota(s)
    const key = fitScale(keyAt(y));
    const pos = Math.max(0, snapFloor(tickAt(x)));
    const created = (CHORDS[chord] ?? [0]).map((iv) => ({ id: uid('n'), key: Math.min(127, key + iv), pos, len: lastLen.current, vel: 0.78 }) as Note);
    const next = [...notes, ...created];
    preview(next);
    created.forEach((n) => audition(n.key, 0.78, Math.min(n.len, 96)));
    const ids = new Set(created.map((n) => n.id));
    setSel(ids);
    drag.current = t === 'paint' ? { kind: 'paint', key, last: pos } : { kind: 'move', ids, x0: x, y0: y, orig: next, dKey: 0, dPos: 0, created: true };
  };

  const keyFromKeyboard = (x: number, y: number) => {
    const k = keyAt(y);
    if (x < KEYS * 0.6) return k;
    // na parte branca, uma tecla preta "pertence" à branca vizinha
    if (BLACK.has(((k % 12) + 12) % 12)) {
      const v = view.current;
      const within = (y - keyY(k)) / v.rowH;
      return within < 0.5 ? k + 1 : k - 1;
    }
    return k;
  };

  const seekTo = (x: number) => {
    const t = Math.max(0, Math.min(plen - 1, snapFloor(tickAt(x))));
    audio.seek(t);
    playTick.current = audio.status.playing ? t : -1;
    paint();
  };

  const laneSet = (x: number, y: number) => {
    const { w, h } = size.current;
    const g = geo(w, h);
    const lh = g.laneB - g.laneTop - 8;
    const cur = curNotes();
    const near = (n: Note) => Math.abs(tickX(n.pos) - x) < Math.max(4, (snap * view.current.zx) / 2) && (sel.size === 0 || sel.has(n.id));
    if (lane === 'vel') {
      const vel = Math.max(0.02, Math.min(1, (g.laneB - 4 - y) / lh));
      preview(cur.map((n) => (near(n) ? { ...n, vel } : n)));
    } else {
      const mid = g.laneTop + 4 + lh / 2;
      const pan = Math.max(-1, Math.min(1, (mid - y) / (lh / 2)));
      preview(cur.map((n) => (near(n) ? { ...n, pan: Math.abs(pan) < 0.04 ? undefined : pan } : n)));
    }
  };

  const onMove = (e: PointerEvent) => {
    const [x, y] = local(e);
    const d = drag.current;
    const v = view.current;
    const el = e.currentTarget as HTMLElement;
    if (!d) {
      const { w, h } = size.current;
      const g = geo(w, h);
      if (y > g.gridT && y < g.gridB && x > KEYS && x < g.gridR) {
        const hn = hit(x, y);
        el.style.cursor = hn ? (hn.edge && (tool === 'draw' || tool === 'paint') ? 'ew-resize' : tool === 'erase' ? 'not-allowed' : tool === 'slice' ? 'col-resize' : 'move') : tool === 'select' ? 'crosshair' : 'copy';
        const hv = hn ? null : { key: fitScale(keyAt(y)), tick: Math.max(0, snapFloor(tickAt(x))) };
        if (hv?.key !== hover.current?.key || hv?.tick !== hover.current?.tick) {
          hover.current = hv;
          if (hv) setHint(`${noteName(hv.key)} · compasso ${Math.floor(hv.tick / bar) + 1}, step ${Math.floor((hv.tick % bar) / STEP) + 1}`);
          paintOverlay();
        }
      } else {
        el.style.cursor = y >= g.laneTop - 5 && y < g.laneTop ? 'ns-resize' : x < KEYS ? 'pointer' : 'default';
        if (hover.current) {
          hover.current = null;
          paintOverlay();
        }
      }
      return;
    }
    if (!pat || !ch) return;
    switch (d.kind) {
      case 'move': {
        let dKey = Math.round(-(y - d.y0) / v.rowH);
        const rawDt = (x - d.x0) / v.zx;
        const dPos = snap > 1 ? Math.round(rawDt / snap) * snap : Math.round(rawDt);
        if (lockScale) {
          const first = d.orig.find((n) => d.ids.has(n.id));
          if (first) dKey = fitScale(first.key + dKey) - first.key;
        }
        if (dKey === d.dKey && dPos === d.dPos) return;
        if (dKey !== d.dKey) {
          const first = d.orig.find((n) => d.ids.has(n.id));
          if (first) audition(first.key + dKey, first.vel, Math.min(first.len, 48));
        }
        d.dKey = dKey;
        d.dPos = dPos;
        preview(d.orig.map((n) => (d.ids.has(n.id) ? { ...n, key: Math.max(0, Math.min(127, n.key + dKey)), pos: Math.max(0, n.pos + dPos) } : n)));
        break;
      }
      case 'resize': {
        const dt = (x - d.x0) / v.zx;
        preview(
          d.orig.map((n) => {
            if (!d.ids.has(n.id)) return n;
            const end = snapRound(n.pos + n.len + dt);
            const len = Math.max(snap > 1 ? Math.min(snap, n.len) : 1, Math.round(end - n.pos));
            lastLen.current = len;
            return { ...n, len };
          }),
        );
        break;
      }
      case 'select':
        d.x1 = x;
        d.y1 = y;
        paintOverlay();
        break;
      case 'erase': {
        const hn = hit(x, y, curNotes());
        if (hn) commit(curNotes().filter((n) => n.id !== hn.n.id));
        break;
      }
      case 'mute': {
        const hn = hit(x, y, curNotes());
        if (hn && !d.done.has(hn.n.id)) {
          d.done.add(hn.n.id);
          preview(curNotes().map((n) => (n.id === hn.n.id ? { ...n, mute: d.value || undefined } : n)));
        }
        break;
      }
      case 'paint': {
        const t = Math.max(0, snapFloor(tickAt(x)));
        const stepLen = lastLen.current;
        if (t >= d.last + stepLen || t <= d.last - stepLen) {
          const pos = d.last + Math.sign(t - d.last) * stepLen;
          const cur = curNotes();
          const add = (CHORDS[chord] ?? [0]).map((iv) => ({ id: uid('n'), key: Math.min(127, d.key + iv), pos, len: stepLen, vel: 0.78 }) as Note);
          if (!cur.some((n) => n.pos === pos && n.key === d.key)) {
            preview([...cur, ...add]);
            audition(d.key, 0.78, Math.min(stepLen, 48));
          }
          d.last = pos;
        }
        break;
      }
      case 'lane':
        laneSet(x, y);
        break;
      case 'laneSize':
        v.laneH = Math.max(36, Math.min(size.current.h * 0.6, d.h0 - (y - d.y0)));
        paint();
        break;
      case 'hbar': {
        const viewW = size.current.w - SB - KEYS;
        v.scrollX = d.s0 + ((x - d.x0) / viewW) * contentW();
        clampView();
        paint();
        break;
      }
      case 'vbar': {
        const g = geo(size.current.w, size.current.h);
        v.scrollY = d.s0 + ((y - d.y0) / (g.gridB - g.gridT)) * 128 * v.rowH;
        clampView();
        paint();
        break;
      }
      case 'ruler':
        seekTo(x);
        break;
      case 'keys': {
        const k = keyFromKeyboard(x, y);
        if (k !== d.key) {
          audio.liveOff(ch.id, d.key);
          audio.liveOn(ch.id, k, 0.85);
          d.key = k;
          pressed.current = k;
          paint();
        }
        break;
      }
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !pat || !ch) return;
    if (d.kind === 'keys') {
      audio.liveOff(ch.id, d.key);
      pressed.current = null;
      paint();
      return;
    }
    if (d.kind === 'select') {
      const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      const ids = new Set(d.add ? sel : []);
      for (const n of notes) {
        const nx = tickX(n.pos), ny = keyY(n.key);
        if (nx + n.len * view.current.zx >= xa && nx <= xb && ny + view.current.rowH >= ya && ny <= yb) ids.add(n.id);
      }
      setSel(ids);
      paint();
      return;
    }
    if (['move', 'resize', 'lane', 'mute', 'paint'].includes(d.kind)) commit(curNotes());
    if (d.kind === 'move' && d.created) setSel(new Set());
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const v = view.current;
    const [x, y] = local(e);
    if (e.ctrlKey) {
      const t = tickAt(x);
      v.zx = Math.max(0.04, Math.min(6, v.zx * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
      v.scrollX = t - (x - KEYS) / v.zx;
    } else if (e.altKey) {
      const k = keyAt(y);
      v.rowH = Math.max(6, Math.min(32, v.rowH + (e.deltaY < 0 ? 1 : -1)));
      v.scrollY = (127 - k) * v.rowH - (y - RULER);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) v.scrollX += (e.deltaX || e.deltaY) / v.zx;
    else v.scrollY += e.deltaY * 0.6;
    clampView();
    paint();
  };

  // atalhos de teclado (quando o piano roll é a janela da frente)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state.windows.piano.open || !pat || !ch) return;
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      const w = state.windows;
      const top = Math.max(...Object.values(w).filter((x) => x.open).map((x) => x.z));
      if (w.piano.z !== top) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const sel = selRef.current;
      const notes = curNotes();
      const chosen = notes.filter((n) => sel.has(n.id));
      const grid = snap > 1 ? snap : STEP;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.size) commit(notes.filter((n) => !sel.has(n.id)));
        setSel(new Set());
      } else if (ctrl && k === 'a') setSel(new Set(notes.map((n) => n.id)));
      else if (ctrl && k === 'c') clipboard = chosen.map((n) => ({ ...n }));
      else if (ctrl && k === 'x') {
        clipboard = chosen.map((n) => ({ ...n }));
        commit(notes.filter((n) => !sel.has(n.id)));
        setSel(new Set());
      } else if (ctrl && k === 'v' && clipboard.length) {
        const start = Math.min(...clipboard.map((n) => n.pos));
        const at = chosen.length ? Math.max(...chosen.map((n) => n.pos + n.len)) : Math.max(0, snapFloor(view.current.scrollX + 1));
        const pasted = clipboard.map((n) => ({ ...n, id: uid('n'), pos: Math.ceil((at + n.pos - start) / grid) * grid }));
        commit([...notes, ...pasted]);
        setSel(new Set(pasted.map((n) => n.id)));
      } else if (ctrl && k === 'd' && chosen.length) {
        const lo = Math.min(...chosen.map((n) => n.pos));
        const span = Math.ceil((Math.max(...chosen.map((n) => n.pos + n.len)) - lo) / grid) * grid;
        const copies = chosen.map((n) => ({ ...n, id: uid('n'), pos: n.pos + span }));
        commit([...notes, ...copies]);
        setSel(new Set(copies.map((n) => n.id)));
      } else if (ctrl && k === 'q') act(A.transformNotes, { pattern: pat.id, channel: ch.id, quantize: grid / PPQ });
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.size) {
        const dk = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        commit(notes.map((n) => (sel.has(n.id) ? { ...n, key: Math.max(0, Math.min(127, n.key + dk)) } : n)));
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel.size) {
        const dt = (e.key === 'ArrowRight' ? 1 : -1) * grid;
        commit(notes.map((n) => (sel.has(n.id) ? { ...n, pos: Math.max(0, n.pos + dt) } : n)));
      } else if (e.key === 'Escape') setSel(new Set());
      else if (!ctrl && !e.altKey && ['p', 'b', 'd', 't', 'c', 'e'].includes(k)) setTool(({ p: 'draw', b: 'paint', d: 'erase', t: 'mute', c: 'slice', e: 'select' } as Record<string, Tool>)[k]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [notes, sel, pat?.id, ch?.id, snap]);

  const toolBtn = (t: Tool, icon: string, label: string, key: string) => <IconBtn icon={icon} on={tool === t} hint={`${label} (${key})`} onClick={() => setTool(t)} />;

  return (
    <Win
      id="piano"
      icon="piano"
      title={
        <>
          Piano roll <span class="dim">· {ch?.name ?? 'sem canal'} · {pat?.name ?? ''}</span>
        </>
      }
      minW={480}
      minH={260}
      tools={
        <span class="pr-tools nodrag">
          <span class="tgroup">
            {toolBtn('draw', 'pencil', 'Lápis: cria, move e redimensiona notas; direito apaga; Ctrl+arrastar seleciona', 'P')}
            {toolBtn('paint', 'brush', 'Pincel: arraste para pintar notas em sequência', 'B')}
            {toolBtn('erase', 'eraser', 'Borracha: clique ou arraste sobre notas', 'D')}
            {toolBtn('mute', 'mute', 'Mute: silencia notas sem apagar', 'T')}
            {toolBtn('slice', 'slice', 'Fatiar: corta uma nota no ponto clicado', 'C')}
            {toolBtn('select', 'select', 'Seleção por retângulo (Shift soma)', 'E')}
          </span>
          <span class="tgroup" data-hint="Grade de snap (magnetismo)">
            <svg class="ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 3v5a4 4 0 008 0V3M4 5.5h2.5M9.5 5.5H12" /></svg>
            <select value={snap} onChange={(e) => ((state.snap = Number((e.target as HTMLSelectElement).value)), paint())}>
              {SNAPS.map(([l, v]) => (
                <option value={v}>{l}</option>
              ))}
            </select>
          </span>
          <span class="tgroup" data-hint="Carimbo de acorde: cada clique cria o acorde inteiro">
            <svg class="ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 12h8M4 8.5h8M4 5h8" /></svg>
            <select value={chord} onChange={(e) => setChord((e.target as HTMLSelectElement).value)}>
              {Object.keys(CHORDS).map((k) => (
                <option value={k}>{k === 'nenhum' ? 'nota' : k}</option>
              ))}
            </select>
          </span>
          <span class="tgroup" data-hint="Escala: destaca as notas da escala (e trava, se ligado)">
            <select value={s.scaleRoot} onChange={(e) => ((state.scaleRoot = (e.target as HTMLSelectElement).value), paint())}>
              {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((k) => (
                <option>{k}</option>
              ))}
            </select>
            <select value={s.scale} onChange={(e) => ((state.scale = (e.target as HTMLSelectElement).value), paint())}>
              {Object.keys(SCALES).map((k) => (
                <option value={k}>{SCALE_LABEL[k] ?? k}</option>
              ))}
            </select>
            <IconBtn icon="scale" on={lockScale} hint="Travar notas na escala" onClick={() => setLockScale(!lockScale)} />
          </span>
          <span class="tgroup">
            <IconBtn icon="ghost" on={ghost} hint="Ghost notes: mostrar as notas dos outros canais" onClick={() => setGhost(!ghost)} />
            <IconBtn icon="follow" on={s.followPlay} hint="Seguir a reprodução" onClick={() => ((state.followPlay = !state.followPlay), paint())} />
            <button class="txtbtn" data-hint="Humanizar timing e velocity" onClick={() => pat && ch && act(A.transformNotes, { pattern: pat.id, channel: ch.id, humanizeTiming: 0.03, humanizeVelocity: 0.1, seed: Date.now() % 100000 })}>
              Humanizar
            </button>
          </span>
          <select class="chsel" value={s.channelId ?? ''} data-hint="Canal editado" onChange={(e) => selectChannel((e.target as HTMLSelectElement).value)}>
            {p.channels.map((c) => (
              <option value={c.id}>{c.name}</option>
            ))}
          </select>
        </span>
      }
    >
      <canvas
        ref={ref}
        class="pr-canvas"
        onPointerDown={onDown as any}
        onPointerMove={onMove as any}
        onPointerUp={onUp}
        onPointerLeave={() => {
          if (hover.current) {
            hover.current = null;
            paintOverlay();
          }
        }}
        onWheel={onWheel as any}
        onContextMenu={(e) => e.preventDefault()}
        data-hint="Roda: rolar · Shift+roda: horizontal · Ctrl+roda: zoom · Alt+roda: altura · Ctrl+C/V/X/D · setas movem/transpõem · Ctrl+Q quantiza"
      />
    </Win>
  );
}

const SCALE_LABEL: Record<string, string> = {
  chromatic: 'cromática',
  major: 'maior',
  minor: 'menor',
  harmonicMinor: 'menor harmônica',
  melodicMinor: 'menor melódica',
  dorian: 'dórico',
  phrygian: 'frígio',
  lydian: 'lídio',
  mixolydian: 'mixolídio',
  locrian: 'lócrio',
  pentatonicMajor: 'pentatônica maior',
  pentatonicMinor: 'pentatônica menor',
  blues: 'blues',
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(1, w), Math.max(1, h), Math.min(r, w / 2, h / 2));
}

/** Escurece/clareia uma cor hex (f < 1 escurece). */
export function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

