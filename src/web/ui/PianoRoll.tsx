import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, previewEdit, onLive, selectChannel, act } from '../state';
import { audio } from '../audio';
import { PPQ, STEP, noteName, patternLength, ticksPerBar, uid, type Note } from '../../core/model';
import { set } from '../../core/ops';
import { SCALES, inScale } from '../../core/theory';
import * as A from '../../core/actions';
import { Win, useCanvas } from './widgets';

const KEYW = 54;
const VELH = 64;
const BLACK = new Set([1, 3, 6, 8, 10]);

const SNAPS: [string, number][] = [
  ['Compasso', 384],
  ['Tempo (1/4)', 96],
  ['1/8', 48],
  ['Step (1/16)', 24],
  ['1/32', 12],
  ['1/4 tercina', 64],
  ['1/8 tercina', 32],
  ['1/16 tercina', 16],
  ['Livre', 1],
];

type Drag =
  | { kind: 'move'; ids: Set<string>; x0: number; y0: number; orig: Note[]; dKey: number; dPos: number }
  | { kind: 'resize'; ids: Set<string>; x0: number; orig: Note[] }
  | { kind: 'select'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'erase' }
  | { kind: 'vel'; orig: Note[] };

export function PianoRoll() {
  const s = useApp();
  const p = s.project;
  const pat = p.patterns.find((x) => x.id === s.patternId);
  const ch = p.channels.find((c) => c.id === s.channelId);
  const notes: Note[] = (pat && ch && pat.notes[ch.id]) || [];
  const view = useRef({ scrollX: 0, topKey: 84, zx: 0.45, rowH: 14 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [ghost, setGhost] = useState(true);
  const lastLen = useRef(STEP * 2);
  const drag = useRef<Drag | null>(null);
  const playTick = useRef(-1);
  const audition = useRef<number | null>(null);

  const snap = s.snap;
  const bar = ticksPerBar(p);
  const plen = pat ? patternLength(p, pat) : bar;

  const { ref, paint, size } = useCanvas(
    (ctx, w, h) => {
      const v = view.current;
      const gridH = h - VELH;
      ctx.fillStyle = '#1d2226';
      ctx.fillRect(0, 0, w, h);
      const rows = Math.ceil(gridH / v.rowH) + 1;
      const tx = (t: number) => KEYW + (t - v.scrollX) * v.zx;
      // linhas de teclas
      for (let r = 0; r < rows; r++) {
        const key = v.topKey - r;
        const y = r * v.rowH;
        const black = BLACK.has(((key % 12) + 12) % 12);
        const out = s.scale !== 'chromatic' && !inScale(key, s.scaleRoot, s.scale);
        ctx.fillStyle = out ? '#171b1e' : black ? '#22282c' : '#2a3135';
        ctx.fillRect(KEYW, y, w - KEYW, v.rowH);
        if (key % 12 === 0) {
          ctx.fillStyle = '#3a4248';
          ctx.fillRect(KEYW, y + v.rowH - 1, w - KEYW, 1);
        }
      }
      // fora do pattern
      const endX = tx(plen);
      if (endX < w) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(Math.max(KEYW, endX), 0, w - endX, gridH);
      }
      // grade vertical
      const t0 = Math.max(0, Math.floor(v.scrollX / STEP) * STEP);
      for (let t = t0; tx(t) < w; t += snap >= STEP ? STEP : snap) {
        const x = Math.round(tx(t)) + 0.5;
        if (x < KEYW) continue;
        ctx.strokeStyle = t % bar === 0 ? '#5a656c' : t % PPQ === 0 ? '#3c464c' : '#2f373c';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, gridH);
        ctx.stroke();
      }
      // ghost notes de outros canais
      if (ghost && pat)
        for (const [cid, list] of Object.entries(pat.notes)) {
          if (cid === ch?.id) continue;
          ctx.fillStyle = 'rgba(200,200,200,0.12)';
          for (const n of list) {
            const y = (v.topKey - n.key) * v.rowH;
            if (y < -v.rowH || y > gridH) continue;
            ctx.fillRect(tx(n.pos), y + 2, Math.max(2, n.len * v.zx - 1), v.rowH - 4);
          }
        }
      // notas
      const color = ch?.color ?? '#e4a23a';
      for (const n of notes) {
        const x = tx(n.pos);
        const y = (v.topKey - n.key) * v.rowH;
        const nw = Math.max(3, n.len * v.zx - 1);
        if (x + nw < KEYW || x > w || y < -v.rowH || y > gridH) continue;
        ctx.globalAlpha = 0.45 + 0.55 * n.vel;
        ctx.fillStyle = color;
        ctx.fillRect(x, y + 1, nw, v.rowH - 2);
        ctx.globalAlpha = 1;
        if (sel.has(n.id)) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.5, y + 1.5, nw - 1, v.rowH - 3);
          ctx.lineWidth = 1;
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x + nw - 3, y + 1, 3, v.rowH - 2);
        }
        if (nw > 26 && v.rowH >= 12) {
          ctx.fillStyle = '#111';
          ctx.font = '9px sans-serif';
          ctx.fillText(noteName(n.key), x + 3, y + v.rowH - 4);
        }
      }
      // seleção por retângulo
      const d = drag.current;
      if (d?.kind === 'select') {
        ctx.strokeStyle = '#9fd3ff';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
        ctx.setLineDash([]);
      }
      // teclado
      for (let r = 0; r < rows; r++) {
        const key = v.topKey - r;
        const y = r * v.rowH;
        const black = BLACK.has(((key % 12) + 12) % 12);
        ctx.fillStyle = audition.current === key ? '#f0a43a' : black ? '#1a1a1a' : '#e8e8e8';
        ctx.fillRect(0, y, KEYW - (black ? 16 : 0), v.rowH - 1);
        if (key % 12 === 0) {
          ctx.fillStyle = '#555';
          ctx.font = '9px sans-serif';
          ctx.fillText(noteName(key), KEYW - 24, y + v.rowH - 3);
        }
      }
      // velocity
      ctx.fillStyle = '#15191c';
      ctx.fillRect(0, gridH, w, VELH);
      ctx.fillStyle = '#3a4248';
      ctx.fillRect(0, gridH, w, 1);
      ctx.fillStyle = '#888';
      ctx.font = '9px sans-serif';
      ctx.fillText('velocity', 6, gridH + 14);
      for (const n of notes) {
        const x = tx(n.pos);
        if (x < KEYW || x > w) continue;
        const vh = n.vel * (VELH - 10);
        ctx.fillStyle = sel.has(n.id) ? '#fff' : color;
        ctx.fillRect(x, h - vh - 2, 3, vh);
        ctx.fillRect(x - 2, h - vh - 4, 7, 3);
      }
      // playhead
      if (playTick.current >= 0) {
        const x = tx(playTick.current);
        if (x >= KEYW) {
          ctx.fillStyle = '#7fd6ff';
          ctx.fillRect(x, 0, 1.5, h);
        }
      }
    },
    [p, s.patternId, s.channelId, sel, ghost, snap, s.scale, s.scaleRoot],
  );

  useEffect(
    () =>
      onLive((st) => {
        const t = st.playing && st.mode === 'pattern' && st.patternId === state.patternId ? st.tick : -1;
        if (t !== playTick.current) {
          playTick.current = t;
          paint();
        }
      }),
    [],
  );

  // centraliza nas notas ao trocar de canal
  useEffect(() => {
    if (notes.length) {
      const hi = Math.max(...notes.map((n) => n.key));
      view.current.topKey = Math.min(127, hi + 6);
    }
    setSel(new Set());
    paint();
  }, [s.channelId, s.patternId]);

  const keyAt = (y: number) => Math.round(view.current.topKey - (y - view.current.rowH / 2) / view.current.rowH);
  const tickAt = (x: number) => view.current.scrollX + (x - KEYW) / view.current.zx;
  const snapT = (t: number) => (snap > 1 ? Math.floor(t / snap) * snap : Math.round(t));
  const local = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const hit = (x: number, y: number) => {
    const v = view.current;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const nx = KEYW + (n.pos - v.scrollX) * v.zx;
      const ny = (v.topKey - n.key) * v.rowH;
      const nw = Math.max(3, n.len * v.zx);
      if (x >= nx && x <= nx + nw && y >= ny && y < ny + v.rowH) return { n, edge: x > nx + nw - 6 };
    }
    return null;
  };
  const commit = (next: Note[]) => {
    if (!pat || !ch) return;
    edit([set(['patterns', pat.id, 'notes', ch.id], next)]);
  };
  const preview = (next: Note[]) => {
    if (!pat || !ch) return;
    previewEdit([set(['patterns', pat.id, 'notes', ch.id], next)]);
  };

  const onDown = (e: PointerEvent) => {
    if (!pat || !ch) return;
    const [x, y] = local(e);
    const gridH = size.current.h - VELH;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (x < KEYW && y < gridH) {
      const k = keyAt(y);
      audition.current = k;
      audio.liveOn(ch.id, k, 0.8);
      paint();
      return;
    }
    if (y >= gridH) {
      drag.current = { kind: 'vel', orig: notes };
      setVel(x, y);
      return;
    }
    const h = hit(x, y);
    if (e.button === 2) {
      drag.current = { kind: 'erase' };
      if (h) commit(notes.filter((n) => n.id !== h.n.id));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      drag.current = { kind: 'select', x0: x, y0: y, x1: x, y1: y };
      return;
    }
    if (h) {
      let ids = sel.has(h.n.id) ? sel : new Set([h.n.id]);
      if (e.shiftKey) {
        ids = new Set(sel);
        ids.add(h.n.id);
      }
      setSel(ids);
      if (h.edge) drag.current = { kind: 'resize', ids, x0: x, orig: notes };
      else {
        drag.current = { kind: 'move', ids, x0: x, y0: y, orig: notes, dKey: 0, dPos: 0 };
        audio.liveOn(ch.id, h.n.key, h.n.vel, h.n.len);
      }
      lastLen.current = h.n.len;
      return;
    }
    // nova nota
    const key = keyAt(y);
    const pos = Math.max(0, snapT(tickAt(x)));
    const n: Note = { id: uid('n'), key, pos, len: lastLen.current, vel: 0.78 };
    const next = [...notes, n];
    preview(next);
    audio.liveOn(ch.id, key, 0.78, n.len);
    const ids = new Set([n.id]);
    setSel(ids);
    drag.current = { kind: 'move', ids, x0: x, y0: y, orig: next, dKey: 0, dPos: 0 };
  };

  const setVel = (x: number, y: number) => {
    const h = size.current.h;
    const vel = Math.max(0.02, Math.min(1, (h - y - 2) / (VELH - 10)));
    const v = view.current;
    const cur = (state.project.patterns.find((q) => q.id === pat!.id)?.notes[ch!.id] ?? []) as Note[];
    const next = cur.map((n) => {
      const nx = KEYW + (n.pos - v.scrollX) * v.zx;
      return Math.abs(nx - x) < 5 && (sel.size === 0 || sel.has(n.id) || true) ? { ...n, vel } : n;
    });
    preview(next);
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || !pat || !ch) {
      const [x, y] = local(e);
      const h = hit(x, y);
      (e.currentTarget as HTMLElement).style.cursor = h ? (h.edge ? 'ew-resize' : 'move') : x < KEYW ? 'pointer' : 'crosshair';
      return;
    }
    const [x, y] = local(e);
    const v = view.current;
    if (d.kind === 'move') {
      const dKey = Math.round(-(y - d.y0) / v.rowH);
      const rawDt = (x - d.x0) / v.zx;
      const dPos = snap > 1 ? Math.round(rawDt / snap) * snap : Math.round(rawDt);
      if (dKey === d.dKey && dPos === d.dPos) return;
      if (dKey !== d.dKey) {
        const first = d.orig.find((n) => d.ids.has(n.id));
        if (first) audio.liveOn(ch.id, first.key + dKey, first.vel, Math.min(first.len, 48));
      }
      d.dKey = dKey;
      d.dPos = dPos;
      preview(d.orig.map((n) => (d.ids.has(n.id) ? { ...n, key: Math.max(0, Math.min(127, n.key + dKey)), pos: Math.max(0, n.pos + dPos) } : n)));
    } else if (d.kind === 'resize') {
      const dt = (x - d.x0) / v.zx;
      const next = d.orig.map((n) => {
        if (!d.ids.has(n.id)) return n;
        let end = n.pos + n.len + dt;
        if (snap > 1) end = Math.round(end / snap) * snap;
        const len = Math.max(snap > 1 ? snap : 1, Math.round(end - n.pos));
        lastLen.current = len;
        return { ...n, len };
      });
      preview(next);
    } else if (d.kind === 'select') {
      d.x1 = x;
      d.y1 = y;
      paint();
    } else if (d.kind === 'erase') {
      const h = hit(x, y);
      if (h) {
        const cur = (state.project.patterns.find((q) => q.id === pat.id)?.notes[ch.id] ?? []) as Note[];
        commit(cur.filter((n) => n.id !== h.n.id));
      }
    } else if (d.kind === 'vel') setVel(x, y);
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (audition.current !== null && ch) {
      audio.liveOff(ch.id, audition.current);
      audition.current = null;
      paint();
    }
    if (!d || !pat || !ch) return;
    if (d.kind === 'select') {
      const v = view.current;
      const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      const ids = new Set(
        notes
          .filter((n) => {
            const nx = KEYW + (n.pos - v.scrollX) * v.zx;
            const ny = (v.topKey - n.key) * v.rowH;
            return nx + n.len * v.zx >= xa && nx <= xb && ny + v.rowH >= ya && ny <= yb;
          })
          .map((n) => n.id),
      );
      setSel(ids);
      paint();
      return;
    }
    if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'vel') {
      const cur = state.project.patterns.find((q) => q.id === pat.id)?.notes[ch.id] ?? [];
      commit(cur);
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const v = view.current;
    if (e.ctrlKey) {
      const [x] = [e.offsetX];
      const t = tickAt(x);
      v.zx = Math.max(0.05, Math.min(4, v.zx * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      v.scrollX = Math.max(0, t - (x - KEYW) / v.zx);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      v.scrollX = Math.max(0, v.scrollX + (e.deltaX || e.deltaY) / v.zx);
    } else if (e.altKey) {
      v.rowH = Math.max(6, Math.min(28, v.rowH + (e.deltaY < 0 ? 1 : -1)));
    } else {
      v.topKey = Math.max(12, Math.min(127, v.topKey - Math.sign(e.deltaY) * 3));
    }
    paint();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state.windows.piano.open || !pat || !ch) return;
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      const w = state.windows;
      const top = Math.max(...Object.values(w).filter((x) => x.open).map((x) => x.z));
      if (w.piano.z !== top) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.size) commit(notes.filter((n) => !sel.has(n.id)));
        setSel(new Set());
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSel(new Set(notes.map((n) => n.id)));
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.size) {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        commit(notes.map((n) => (sel.has(n.id) ? { ...n, key: Math.max(0, Math.min(127, n.key + d)) } : n)));
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel.size) {
        e.preventDefault();
        const d = (e.key === 'ArrowRight' ? 1 : -1) * (snap > 1 ? snap : STEP);
        commit(notes.map((n) => (sel.has(n.id) ? { ...n, pos: Math.max(0, n.pos + d) } : n)));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && sel.size) {
        e.preventDefault();
        const chosen = notes.filter((n) => sel.has(n.id));
        const span = Math.max(...chosen.map((n) => n.pos + n.len)) - Math.min(...chosen.map((n) => n.pos));
        const step = Math.ceil(span / (snap > 1 ? snap : STEP)) * (snap > 1 ? snap : STEP);
        const copies = chosen.map((n) => ({ ...n, id: uid('n'), pos: n.pos + step }));
        commit([...notes, ...copies]);
        setSel(new Set(copies.map((n) => n.id)));
      } else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [notes, sel, pat?.id, ch?.id, snap]);

  return (
    <Win
      id="piano"
      title={`Piano roll · ${ch?.name ?? '(sem canal)'} · ${pat?.name ?? ''}`}
      minW={420}
      minH={240}
      tools={
        <span class="pr-tools">
          <select value={s.channelId ?? ''} onChange={(e) => selectChannel((e.target as HTMLSelectElement).value)} title="Canal">
            {p.channels.map((c) => (
              <option value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={snap}
            title="Snap"
            onChange={(e) => {
              state.snap = Number((e.target as HTMLSelectElement).value);
              paint();
            }}
          >
            {SNAPS.map(([l, v]) => (
              <option value={v}>{l}</option>
            ))}
          </select>
          <select value={s.scaleRoot} title="Tônica" onChange={(e) => ((state.scaleRoot = (e.target as HTMLSelectElement).value), paint())}>
            {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((k) => (
              <option>{k}</option>
            ))}
          </select>
          <select value={s.scale} title="Escala (destaca as notas)" onChange={(e) => ((state.scale = (e.target as HTMLSelectElement).value), paint())}>
            {Object.keys(SCALES).map((k) => (
              <option value={k}>{k}</option>
            ))}
          </select>
          <button class={ghost ? 'on' : ''} title="Mostrar notas dos outros canais" onClick={() => setGhost(!ghost)}>
            ghost
          </button>
          <button title="Quantizar (selecionadas ou todas) na grade atual" onClick={() => pat && ch && act(A.transformNotes, { pattern: pat.id, channel: ch.id, quantize: Math.max(1, snap) / PPQ })}>
            Q
          </button>
          <button title="Humanizar timing e velocity" onClick={() => pat && ch && act(A.transformNotes, { pattern: pat.id, channel: ch.id, humanizeTiming: 0.03, humanizeVelocity: 0.1, seed: Date.now() % 100000 })}>
            humano
          </button>
        </span>
      }
    >
      <canvas
        ref={ref}
        class="pr-canvas"
        onPointerDown={onDown as any}
        onPointerMove={onMove as any}
        onPointerUp={onUp}
        onWheel={onWheel as any}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div class="pr-help">clique: nota · arrastar: mover · borda: duração · direito: apagar · Ctrl+arrastar: selecionar · Ctrl+D: duplicar · setas: mover/transpor · roda: rolar · Shift+roda: horizontal · Ctrl+roda: zoom · Alt+roda: altura</div>
    </Win>
  );
}
