import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, previewEdit, onLive, selectPattern, openWindow, setMode, act } from '../state';
import { audio } from '../audio';
import { PPQ, patternLength, songLength, ticksPerBar, uid, type Clip } from '../../core/model';
import { set, ins, rem } from '../../core/ops';
import * as A from '../../core/actions';
import { Win, IconBtn, useCanvas } from './widgets';

const HEADW = 120;
const RULER = 22;

type Drag =
  | { kind: 'move'; id: string; x0: number; y0: number; orig: Clip; dup: boolean }
  | { kind: 'resize'; id: string; x0: number; orig: Clip }
  | { kind: 'erase' }
  | { kind: 'seek' }
  | { kind: 'loop'; t0: number };

export function Playlist() {
  const s = useApp();
  const p = s.project;
  const view = useRef({ scrollX: 0, scrollY: 0, zx: 0.12, rowH: 34 });
  const [snapBeats, setSnapBeats] = useState(true);
  const [tool, setTool] = useState<'draw' | 'erase' | 'slice' | 'mute'>('draw');
  const drag = useRef<Drag | null>(null);
  const playTick = useRef(-1);
  const bar = ticksPerBar(p);
  const snap = snapBeats ? PPQ : bar;

  const { ref, paint, paintOverlay, size } = useCanvas(
    (ctx, w, h) => {
      const v = view.current;
      const tx = (t: number) => HEADW + (t - v.scrollX) * v.zx;
      ctx.fillStyle = '#1b2023';
      ctx.fillRect(0, 0, w, h);
      // linhas de track
      const first = Math.floor(v.scrollY / v.rowH);
      for (let i = first; i < p.tracks.length; i++) {
        const y = RULER + i * v.rowH - v.scrollY;
        if (y > h) break;
        ctx.fillStyle = i % 2 ? '#20262a' : '#232a2e';
        ctx.fillRect(HEADW, y, w - HEADW, v.rowH);
      }
      // grade
      const t0 = Math.floor(v.scrollX / PPQ) * PPQ;
      for (let t = t0; tx(t) < w; t += PPQ) {
        const x = Math.round(tx(t)) + 0.5;
        if (x < HEADW) continue;
        const isBar = t % bar === 0;
        if (!isBar && v.zx * PPQ < 6) continue;
        ctx.strokeStyle = isBar ? '#3d474d' : '#2a3135';
        ctx.beginPath();
        ctx.moveTo(x, RULER);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      // loop
      if (p.loop) {
        ctx.fillStyle = 'rgba(127,214,255,0.08)';
        ctx.fillRect(tx(p.loop.start), RULER, (p.loop.end - p.loop.start) * v.zx, h);
      }
      // clips
      for (const c of p.clips) {
        const pat = p.patterns.find((x) => x.id === c.patternId);
        const x = tx(c.pos);
        const y = RULER + c.track * v.rowH - v.scrollY;
        const cw = c.len * v.zx;
        if (x + cw < HEADW || x > w || y + v.rowH < RULER || y > h) continue;
        const col = pat?.color ?? '#888';
        ctx.globalAlpha = c.muted || p.tracks[c.track]?.mute ? 0.35 : 1;
        ctx.fillStyle = col;
        ctx.fillRect(x, y + 1, cw - 1, 13);
        ctx.fillStyle = shade(col);
        ctx.fillRect(x, y + 14, cw - 1, v.rowH - 15);
        // mini notas (com repetição dentro do clip)
        if (pat) {
          const plen = patternLength(p, pat);
          const all = Object.values(pat.notes).flat();
          if (all.length) {
            let lo = 127, hi = 0;
            for (const n of all) {
              lo = Math.min(lo, n.key);
              hi = Math.max(hi, n.key);
            }
            const span = Math.max(1, hi - lo);
            const inner = v.rowH - 19;
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            for (let rep = Math.floor(c.offset / plen) * plen - c.offset; rep < c.len; rep += plen)
              for (const n of all) {
                const nt = rep + n.pos;
                if (nt < 0 || nt >= c.len) continue;
                const nx = x + nt * v.zx;
                const ny = y + 16 + ((hi - n.key) / span) * inner;
                ctx.fillRect(nx, ny, Math.max(1, Math.min(n.len, c.len - nt) * v.zx - 0.5), 1.5);
              }
          }
        }
        ctx.fillStyle = '#111';
        ctx.font = '10px sans-serif';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cw - 2, v.rowH);
        ctx.clip();
        ctx.fillText(pat?.name ?? '?', x + 3, y + 11);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      // cabeçalho das tracks
      for (let i = first; i < p.tracks.length; i++) {
        const y = RULER + i * v.rowH - v.scrollY;
        if (y > h) break;
        const t = p.tracks[i];
        ctx.fillStyle = '#2b3236';
        ctx.fillRect(0, y, HEADW, v.rowH - 1);
        ctx.fillStyle = t.mute ? '#444' : '#7cdc6a';
        ctx.beginPath();
        ctx.arc(10, y + v.rowH / 2, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = t.mute ? '#777' : '#ddd';
        ctx.font = '11px sans-serif';
        ctx.fillText(t.name.slice(0, 15), 20, y + v.rowH / 2 + 4);
      }
      // régua
      ctx.fillStyle = '#2d3539';
      ctx.fillRect(0, 0, w, RULER);
      ctx.fillStyle = '#aab';
      ctx.font = '10px sans-serif';
      const every = v.zx * bar < 28 ? 4 : 1;
      for (let b = Math.floor(v.scrollX / bar); tx(b * bar) < w; b++) {
        const x = tx(b * bar);
        if (x < HEADW || b % every) continue;
        ctx.fillRect(x, 12, 1, RULER - 12);
        ctx.fillText(String(b + 1), x + 3, 12);
      }
      if (p.loop) {
        ctx.fillStyle = '#7fd6ff';
        ctx.fillRect(Math.max(HEADW, tx(p.loop.start)), RULER - 4, (p.loop.end - p.loop.start) * v.zx, 4);
      }
      ctx.fillStyle = '#2d3539';
      ctx.fillRect(0, 0, HEADW, RULER);
      ctx.fillStyle = '#889';
      ctx.fillText('Tracks', 8, 15);
    },
    [s.version],
    (ctx, w, h) => {
      if (playTick.current < 0) return;
      const v = view.current;
      const x = HEADW + (playTick.current - v.scrollX) * v.zx;
      if (x >= HEADW && x < w) {
        ctx.fillStyle = '#9fe0ff';
        ctx.fillRect(x, 0, 1.5, h);
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 8);
        ctx.fill();
      }
    },
  );

  useEffect(
    () =>
      onLive((st) => {
        const t = st.playing && st.mode === 'song' ? st.tick : -1;
        if (t !== playTick.current) {
          playTick.current = t;
          // segue a reprodução (só repinta tudo quando a tela precisa rolar)
          const v = view.current;
          const w = size.current.w;
          let scrolled = false;
          if (t >= 0 && state.followPlay) {
            const x = HEADW + (t - v.scrollX) * v.zx;
            if (x > w - 40 || x < HEADW) {
              v.scrollX = Math.max(0, t - 20 / v.zx);
              scrolled = true;
            }
          }
          if (scrolled) paint();
          else paintOverlay();
        }
      }),
    [],
  );

  const local = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const tickAt = (x: number) => view.current.scrollX + (x - HEADW) / view.current.zx;
  const trackAt = (y: number) => Math.floor((y - RULER + view.current.scrollY) / view.current.rowH);
  const hit = (x: number, y: number) => {
    const v = view.current;
    for (let i = p.clips.length - 1; i >= 0; i--) {
      const c = p.clips[i];
      const cx = HEADW + (c.pos - v.scrollX) * v.zx;
      const cy = RULER + c.track * v.rowH - v.scrollY;
      const cw = c.len * v.zx;
      if (x >= cx && x <= cx + cw && y >= cy && y < cy + v.rowH) return { c, edge: x > cx + cw - 6 };
    }
    return null;
  };
  const clipOps = (c: Clip): ReturnType<typeof set>[] => [set(['clips', c.id], c)];

  const onDown = (e: PointerEvent) => {
    const [x, y] = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (y < RULER) {
      if (x < HEADW) return;
      if (e.shiftKey || e.button === 2) {
        const t0 = Math.round(tickAt(x) / bar) * bar;
        drag.current = { kind: 'loop', t0 };
        return;
      }
      drag.current = { kind: 'seek' };
      seek(x);
      return;
    }
    if (x < HEADW) {
      const t = trackAt(y);
      const tr = p.tracks[t];
      if (!tr) return;
      if (e.button === 2 || e.detail === 2) {
        const n = prompt('Nome da track:', tr.name);
        if (n) edit([set(['tracks', tr.id, 'name'], n)]);
      } else edit([set(['tracks', tr.id, 'mute'], !tr.mute)]);
      return;
    }
    const h = hit(x, y);
    if (e.button === 2 || tool === 'erase') {
      drag.current = { kind: 'erase' };
      if (h) edit([rem(['clips', h.c.id])]);
      return;
    }
    if (tool === 'mute') {
      if (h) edit([set(['clips', h.c.id, 'muted'], !h.c.muted || undefined)]);
      return;
    }
    if (tool === 'slice') {
      if (!h) return;
      const at = Math.round(tickAt(x) / snap) * snap;
      const c = h.c;
      if (at <= c.pos || at >= c.pos + c.len) return;
      const pat = p.patterns.find((q) => q.id === c.patternId);
      const plen = pat ? patternLength(p, pat) : c.len;
      const second = { ...c, id: uid('k'), pos: at, len: c.pos + c.len - at, offset: (c.offset + at - c.pos) % plen };
      edit([set(['clips', c.id, 'len'], at - c.pos), ins(['clips'], second)]);
      return;
    }
    if (h) {
      selectPattern(h.c.patternId);
      if (e.detail === 2) {
        openWindow('rack');
        return;
      }
      if (h.edge) drag.current = { kind: 'resize', id: h.c.id, x0: x, orig: { ...h.c } };
      else drag.current = { kind: 'move', id: h.c.id, x0: x, y0: y, orig: { ...h.c }, dup: e.shiftKey };
      if (e.shiftKey) {
        // Shift+arrastar duplica o clip
        const copy = { ...h.c, id: uid('k') };
        edit([ins(['clips'], copy)]);
        drag.current = { kind: 'move', id: copy.id, x0: x, y0: y, orig: copy, dup: true };
      }
      return;
    }
    // novo clip do pattern selecionado
    const pat = p.patterns.find((x) => x.id === s.patternId);
    const track = trackAt(y);
    if (!pat || track < 0 || track >= p.tracks.length) return;
    const pos = Math.max(0, Math.floor(tickAt(x) / snap) * snap);
    const c: Clip = { id: uid('k'), track, pos, len: patternLength(p, pat), patternId: pat.id, offset: 0 };
    edit([ins(['clips'], c)]);
    drag.current = { kind: 'move', id: c.id, x0: x, y0: y, orig: c, dup: false };
  };

  const seek = (x: number) => {
    const t = Math.max(0, Math.floor(tickAt(x) / PPQ) * PPQ);
    if (state.mode !== 'song') setMode('song');
    audio.seek(t);
    playTick.current = t;
    paintOverlay();
  };

  const onMove = (e: PointerEvent) => {
    const [x, y] = local(e);
    const d = drag.current;
    if (!d) {
      const h = y > RULER && x > HEADW ? hit(x, y) : null;
      (e.currentTarget as HTMLElement).style.cursor = h ? (h.edge ? 'ew-resize' : 'move') : y < RULER ? 'text' : 'crosshair';
      return;
    }
    const v = view.current;
    if (d.kind === 'move') {
      const dt = Math.round((x - d.x0) / v.zx / snap) * snap;
      const dtr = Math.round((y - d.y0) / v.rowH);
      const c = { ...d.orig, pos: Math.max(0, d.orig.pos + dt), track: Math.max(0, Math.min(p.tracks.length - 1, d.orig.track + dtr)) };
      previewEdit(clipOps(c));
    } else if (d.kind === 'resize') {
      const end = Math.round((d.orig.pos + d.orig.len + (x - d.x0) / v.zx) / snap) * snap;
      previewEdit(clipOps({ ...d.orig, len: Math.max(snap, end - d.orig.pos) }));
    } else if (d.kind === 'erase') {
      const h = hit(x, y);
      if (h) edit([rem(['clips', h.c.id])]);
    } else if (d.kind === 'seek') seek(x);
    else if (d.kind === 'loop') {
      const t1 = Math.round(tickAt(x) / bar) * bar;
      const [a, b] = [Math.min(d.t0, t1), Math.max(d.t0, t1)];
      previewEdit([set(['loop'], b > a ? { start: a, end: b } : null)]);
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'move' || d.kind === 'resize') {
      const c = state.project.clips.find((x) => x.id === d.id);
      if (c) edit(clipOps(c));
    } else if (d.kind === 'loop') edit([set(['loop'], state.project.loop ?? null)]);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const v = view.current;
    if (e.ctrlKey) {
      const t = tickAt(e.offsetX);
      v.zx = Math.max(0.01, Math.min(1.5, v.zx * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      v.scrollX = Math.max(0, t - (e.offsetX - HEADW) / v.zx);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) v.scrollX = Math.max(0, v.scrollX + (e.deltaX || e.deltaY) / v.zx);
    else if (e.altKey) v.rowH = Math.max(18, Math.min(80, v.rowH + (e.deltaY < 0 ? 2 : -2)));
    else v.scrollY = Math.max(0, Math.min(p.tracks.length * v.rowH - 60, v.scrollY + e.deltaY));
    paint();
  };

  const len = songLength(p);
  return (
    <Win
      id="playlist"
      icon="playlist"
      title={
        <>
          Playlist <span class="dim">· arranjo · {Math.ceil(len / bar)} compassos</span>
        </>
      }
      minW={420}
      minH={200}
      tools={
        <span class="pl-tools nodrag">
          <span class="tgroup">
            <IconBtn icon="pencil" on={tool === 'draw'} hint="Lápis: clique pinta o pattern selecionado, arraste move, borda redimensiona (o pattern repete)" onClick={() => setTool('draw')} />
            <IconBtn icon="eraser" on={tool === 'erase'} hint="Borracha: apaga clips (o botão direito também apaga)" onClick={() => setTool('erase')} />
            <IconBtn icon="mute" on={tool === 'mute'} hint="Mute de clip" onClick={() => setTool('mute')} />
            <IconBtn icon="slice" on={tool === 'slice'} hint="Fatiar clip no ponto clicado" onClick={() => setTool('slice')} />
          </span>
          <span class="tgroup">
            <IconBtn icon="magnet" label={snapBeats ? 'tempo' : 'compasso'} hint="Snap da playlist: tempo ou compasso" onClick={() => setSnapBeats(!snapBeats)} />
            <IconBtn icon="follow" on={s.followPlay} hint="Seguir a reprodução" onClick={() => ((state.followPlay = !state.followPlay), paint())} />
            <IconBtn icon="plus" label="track" hint="Adicionar track" onClick={() => edit([ins(['tracks'], { id: uid('t'), name: `Track ${p.tracks.length + 1}`, color: '#888', mute: false })])} />
          </span>
        </span>
      }
    >
      <div class="pl-wrap">
        <div class="picker" data-hint="Patterns: clique escolhe o que o lápis pinta · duplo clique renomeia">
          {p.patterns.map((pt) => (
            <button
              class={`pk ${pt.id === s.patternId ? 'on' : ''}`}
              style={{ borderLeftColor: pt.color }}
              onClick={() => selectPattern(pt.id)}
              onDblClick={() => {
                const n = prompt('Nome do pattern:', pt.name);
                if (n) act(A.updatePattern, { pattern: pt.id, name: n });
              }}
            >
              {pt.name}
            </button>
          ))}
          <button class="pk pk-add" data-hint="Novo pattern" onClick={() => { const r = act(A.addPattern, {}); if (r) selectPattern(r.id); }}>
            + pattern
          </button>
        </div>
        <canvas
          ref={ref}
          class="pl-canvas"
          onPointerDown={onDown as any}
          onPointerMove={onMove as any}
          onPointerUp={onUp}
          onWheel={onWheel as any}
          onContextMenu={(e) => e.preventDefault()}
          data-hint="Régua: posicionar (Shift ou direito: loop) · Shift+arrastar clip: duplicar · duplo clique no clip: abrir no rack · Ctrl+roda: zoom · Alt+roda: altura"
        />
      </div>
    </Win>
  );
}

function shade(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * 0.45, g = ((n >> 8) & 255) * 0.45, b = (n & 255) * 0.45;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
