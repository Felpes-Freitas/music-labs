// Teclado na base da janela do canal: mostra as teclas que estão soando, toca com
// o mouse (arrastar faz glissando) e o botão direito define a nota raiz.

import { useEffect, useRef } from 'preact/hooks';
import type { Channel } from '../../core/model';
import { noteName } from '../../core/model';
import { set } from '../../core/ops';
import { audio } from '../audio';
import { edit, onLive, setHint } from '../state';
import { usePref } from '../prefs';
import { Icon } from './icons';

const BLACK = new Set([1, 3, 6, 8, 10]);

interface KeyRect {
  key: number;
  x: number;
  w: number;
  h: number;
  black: boolean;
}

/** Geometria de um teclado de lo a hi (lo e hi brancas) numa largura w. */
export function keyboardLayout(lo: number, hi: number, w: number, h: number): KeyRect[] {
  const whites: number[] = [];
  for (let k = lo; k <= hi; k++) if (!BLACK.has(k % 12)) whites.push(k);
  const ww = w / whites.length;
  const rects: KeyRect[] = [];
  whites.forEach((k, i) => rects.push({ key: k, x: i * ww, w: ww, h, black: false }));
  for (let k = lo; k <= hi; k++) {
    if (!BLACK.has(k % 12)) continue;
    const left = rects.find((r) => r.key === k - 1);
    if (!left) continue;
    const bw = ww * 0.62;
    rects.push({ key: k, x: left.x + ww - bw / 2, w: bw, h: h * 0.62, black: true });
  }
  return rects;
}

export function keyAt(rects: KeyRect[], x: number, y: number): number | null {
  for (const r of rects) if (r.black && x >= r.x && x < r.x + r.w && y < r.h) return r.key;
  for (const r of rects) if (!r.black && x >= r.x && x < r.x + r.w) return r.key;
  return null;
}

export function drawKeyboard(ctx: CanvasRenderingContext2D, rects: KeyRect[], lit: Set<number>, root: number | null, held: number | null) {
  for (const black of [false, true])
    for (const r of rects) {
      if (r.black !== black) continue;
      const on = lit.has(r.key) || held === r.key;
      if (!black) {
        const g = ctx.createLinearGradient(0, 0, 0, r.h);
        g.addColorStop(0, on ? '#ffd08a' : '#f4f6f7');
        g.addColorStop(1, on ? '#f2a93b' : '#d3d8db');
        ctx.fillStyle = g;
        ctx.fillRect(r.x + 0.5, 0, r.w - 1, r.h);
        ctx.fillStyle = '#7d878c';
        ctx.fillRect(r.x + r.w - 0.5, 0, 1, r.h);
      } else {
        const g = ctx.createLinearGradient(0, 0, 0, r.h);
        g.addColorStop(0, on ? '#ffb347' : '#2b3034');
        g.addColorStop(1, on ? '#c97f15' : '#0e1012');
        ctx.fillStyle = g;
        ctx.fillRect(r.x, 0, r.w, r.h);
      }
      if (r.key === root) {
        ctx.fillStyle = black ? '#7fd6f2' : '#1f8fb8';
        ctx.beginPath();
        ctx.arc(r.x + r.w / 2, r.h - 7, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!black && r.key % 12 === 0 && r.w >= 9) {
        ctx.fillStyle = on ? '#5a3300' : '#7d878c';
        ctx.font = '8px sans-serif';
        ctx.fillText(noteName(r.key), r.x + 1.5, r.h - 14);
      }
    }
}

export function ChannelPiano(p: { ch: Channel }) {
  const [open, setOpen] = usePref('piano', true);
  const ref = useRef<HTMLCanvasElement>(null);
  const lit = useRef(new Set<number>());
  const held = useRef<number | null>(null);
  const rectsRef = useRef<KeyRect[]>([]);
  const root = 60 - p.ch.pitch;

  const paint = () => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    if (!r.width) return;
    if (c.width !== Math.round(r.width * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d1012';
    ctx.fillRect(0, 0, r.width, r.height);
    // de C1 a C8, ou menos se a janela for estreita (teclas de pelo menos 9 px)
    const octaves = Math.max(2, Math.min(7, Math.floor(r.width / (7 * 10))));
    const lo = 60 - 12 * Math.floor(octaves / 2) - (octaves % 2 ? 12 : 0);
    rectsRef.current = keyboardLayout(lo, lo + 12 * octaves, r.width, r.height);
    drawKeyboard(ctx, rectsRef.current, lit.current, root, held.current);
  };

  useEffect(() => {
    if (!open) return;
    paint();
    const ro = new ResizeObserver(paint);
    if (ref.current) ro.observe(ref.current);
    let last = '';
    const off = onLive((st) => {
      const sig = st.lit.join(',');
      if (sig === last) return;
      last = sig;
      lit.current = new Set(st.lit);
      paint();
    });
    return () => {
      ro.disconnect();
      off();
    };
  }, [open, root]);

  const local = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return keyAt(rectsRef.current, e.clientX - r.left, e.clientY - r.top);
  };
  const onDown = (e: PointerEvent) => {
    const k = local(e);
    if (k === null) return;
    if (e.button === 2) {
      edit([set(['channels', p.ch.id, 'pitch'], 60 - k)]);
      setHint(`Nota raiz: ${noteName(k)} (tocar ${noteName(k)} dá a altura original)`);
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    held.current = k;
    audio.liveOn(p.ch.id, k, 0.85);
    paint();
  };
  const onMove = (e: PointerEvent) => {
    if (held.current === null) {
      const k = local(e);
      if (k !== null) setHint(`${noteName(k)} · clique: tocar · arrastar: glissando · botão direito: definir como nota raiz`);
      return;
    }
    const k = local(e);
    if (k !== null && k !== held.current) {
      audio.liveOff(p.ch.id, held.current);
      held.current = k;
      audio.liveOn(p.ch.id, k, 0.85);
      paint();
    }
  };
  const onUp = () => {
    if (held.current !== null) audio.liveOff(p.ch.id, held.current);
    held.current = null;
    paint();
  };

  return (
    <div class={`chpiano ${open ? '' : 'closed'}`}>
      <button class="fold" data-hint={open ? 'Recolher o teclado' : 'Mostrar o teclado'} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'chevron'} size={10} />
        <span>Teclado</span>
        <span class="dim">raiz {noteName(root)}</span>
      </button>
      {open && (
        <canvas
          ref={ref}
          class="chpiano-keys"
          onPointerDown={onDown as any}
          onPointerMove={onMove as any}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}
    </div>
  );
}
