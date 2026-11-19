import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { state, focusWindow, closeWindow, emit, act, type WindowId } from '../state';
import * as A from '../../core/actions';
import { onTheme, prefs as looks } from '../theme';
import { recAuto, recTouched, hasAutomation } from '../midirec';
import { Icon } from './icons';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export interface KnobProps {
  value: number;
  min: number;
  max: number;
  def?: number;
  log?: boolean;
  step?: number;
  size?: number;
  label?: string;
  color?: string;
  bipolar?: boolean;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
  title?: string;
  /** Permite criar um clipe de automação pelo botão direito. */
  auto?: { path: (string | number)[]; label: string };
}

/** Knob: arraste vertical (Shift = fino), duplo clique volta ao padrão, roda do mouse ajusta. */
export function Knob(p: KnobProps) {
  const size = p.size ?? 30;
  const toNorm = (v: number) => (p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
  const fromNorm = (n: number) => {
    let v = p.log ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
    if (p.step) v = Math.round(v / p.step) * p.step;
    return clamp(v, p.min, p.max);
  };
  const [drag, setDrag] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const shown = drag ?? p.value;
  const norm = clamp(toNorm(shown), 0, 1);
  const a0 = -135, a1 = 135;
  const ang = a0 + norm * (a1 - a0);
  const r = size / 2 - 3;
  const cx = size / 2, cy = size / 2;
  const arc = (from: number, to: number) => {
    const p0 = polar(cx, cy, r, from), p1 = polar(cx, cy, r, to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    return `M${p0[0]},${p0[1]} A${r},${r} 0 ${large} ${to > from ? 1 : 0} ${p1[0]},${p1[1]}`;
  };
  const start = p.bipolar ? 0 : a0;
  // gravação de automação: todo movimento do knob (arrastar, roda, duplo clique, botão do meio)
  const autoKey = p.auto ? p.auto.path.join('/') : '';
  const rec = (v: number) => p.auto && recAuto({ path: p.auto.path, min: p.min, max: p.max, log: p.log, label: p.auto.label }, v, p.value);
  const commit = (v: number) => {
    rec(v);
    p.onCommit(v);
  };
  const recording = !!p.auto && recTouched(autoKey);
  const automated = !!p.auto && hasAutomation(autoKey);
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 1) {
      // botão do meio: volta ao valor padrão
      if (p.def !== undefined) commit(p.def);
      return;
    }
    if (e.button !== 0) return;
    const el = e.currentTarget as Element;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const n0 = norm;
    let last = p.value;
    const move = (ev: PointerEvent) => {
      const sens = ev.shiftKey ? 1000 : 160;
      const v = fromNorm(clamp(n0 + (y0 - ev.clientY) / sens, 0, 1));
      last = v;
      setDrag(v);
      p.onInput(v);
      rec(v);
    };
    const up = () => {
      el.removeEventListener('pointermove', move as any);
      el.removeEventListener('pointerup', up);
      setDrag(null);
      p.onCommit(last);
    };
    el.addEventListener('pointermove', move as any);
    el.addEventListener('pointerup', up);
  };
  const tip = `${p.label ? p.label + ': ' : ''}${p.format ? p.format(shown) : fmt(shown)} · arraste · duplo clique ou botão do meio: padrão`;
  return (
    <div
      class={`knob ${recording ? 'auto-rec' : ''} ${automated ? 'has-auto' : ''}`}
      data-hint={p.title ? `${p.title}${p.auto ? ' · botão direito: automação' : ''}` : `${tip}${p.auto ? ' · botão direito: automação' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        if (p.auto) setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {menu && p.auto && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[['Criar clipe de automação', () => act(A.addAutomation, { param: '', target: { path: p.auto!.path, min: p.min, max: p.max, log: p.log, label: p.auto!.label } })]]}
        />
      )}
      <svg
        width={size}
        height={size}
        onPointerDown={onDown as any}
        onDblClick={() => p.def !== undefined && commit(p.def)}
        onWheel={(e) => {
          e.preventDefault();
          commit(fromNorm(clamp(norm - Math.sign(e.deltaY) * 0.02, 0, 1)));
        }}
      >
        <circle cx={cx} cy={cy} r={r} class="knob-bg" />
        <path d={arc(a0, a1)} class="knob-track" />
        {Math.abs(ang - start) > 0.5 && <path d={arc(Math.min(start, ang), Math.max(start, ang))} class="knob-val" style={p.color ? { stroke: p.color } : undefined} />}
        <line x1={cx} y1={cy} x2={polar(cx, cy, r - 3, ang)[0]} y2={polar(cx, cy, r - 3, ang)[1]} class="knob-ptr" />
      </svg>
      {p.label && <div class="knob-label">{drag !== null ? (p.format ? p.format(shown) : fmt(shown)) : recording ? '● AUTO' : p.label}</div>}
    </div>
  );
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

export function fmt(v: number) {
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 1 : 2) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export const dbFmt = (g: number) => (g <= 0.0001 ? '-∞ dB' : `${(20 * Math.log10(g)).toFixed(1)} dB`);
export const panFmt = (v: number) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `${Math.round(-v * 100)}% E` : `${Math.round(v * 100)}% D`);

/** Janela flutuante: arrastar pelo título, duplo clique maximiza, canto redimensiona. */
export function Win(p: { id: WindowId; title: ComponentChildren; icon?: string; children: ComponentChildren; tools?: ComponentChildren; bar?: ComponentChildren; minW?: number; minH?: number }) {
  const w = state.windows[p.id];
  if (!w.open) return null;
  const max = (w as any).max as { x: number; y: number; w: number; h: number } | undefined;
  const toggleMax = () => {
    const ws = document.querySelector('.workspace') as HTMLElement | null;
    if (max) {
      Object.assign(w, max);
      delete (w as any).max;
      focusWindow(p.id, true);
    } else if (ws) {
      (w as any).max = { x: w.x, y: w.y, w: w.w, h: w.h };
      Object.assign(w, { x: 0, y: 0, w: ws.clientWidth, h: ws.clientHeight });
    }
    emit();
  };
  const startDrag = (e: PointerEvent, kind: 'move' | 'size', anywhere = false) => {
    if (!anywhere && (e.target as Element).closest('button, input, select, .knob, .nodrag')) return;
    e.preventDefault();
    focusWindow(p.id);
    const x0 = e.clientX, y0 = e.clientY;
    const s = { ...w };
    const move = (ev: PointerEvent) => {
      if (kind === 'move') {
        w.x = Math.max(-s.w + 80, s.x + ev.clientX - x0);
        w.y = Math.max(0, s.y + ev.clientY - y0);
      } else {
        w.w = Math.max(p.minW ?? 260, s.w + ev.clientX - x0);
        w.h = Math.max(p.minH ?? 140, s.h + ev.clientY - y0);
      }
      emit();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const top = Math.max(...Object.values(state.windows).filter((x) => x.open).map((x) => x.z));
  return (
    <div class={`win win-${p.id} ${w.z === top ? 'focused' : ''}`} style={{ left: `${w.x}px`, top: `${w.y}px`, width: `${w.w}px`, height: `${w.h}px`, zIndex: w.z }} onPointerDown={() => focusWindow(p.id)}
      onPointerDownCapture={(e) => {
        // Alt + arrastar: move a janela de qualquer ponto (Alt + botão direito redimensiona)
        if (!looks.altDrag || !e.altKey || (e.button !== 0 && e.button !== 2)) return;
        e.stopPropagation();
        startDrag(e as any, e.button === 2 ? 'size' : 'move', true);
      }}
      onContextMenuCapture={(e) => {
        if (looks.altDrag && e.altKey) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}>
      <div class="win-title" onPointerDown={(e) => startDrag(e as any, 'move')} onDblClick={(e) => !(e.target as Element).closest('button, input, select, .knob') && toggleMax()}>
        {p.icon && <Icon name={p.icon} size={13} class="win-icon" />}
        <span class="win-name">{p.title}</span>
        <div class="win-tools">{p.tools}</div>
        <button class="win-btn" data-hint="Maximizar / restaurar (duplo clique no título)" onClick={toggleMax}>
          <Icon name="max" size={11} />
        </button>
        <button class="win-btn win-close" data-hint="Fechar janela" onClick={() => closeWindow(p.id)}>
          <Icon name="close" size={11} />
        </button>
      </div>
      {p.bar && <div class="win-bar nodrag">{p.bar}</div>}
      <div class="win-body">{p.children}</div>
      <div class="win-resize" onPointerDown={(e) => startDrag(e as any, 'size')} />
    </div>
  );
}

/** Botão de ícone com dica na barra de dicas. */
export function IconBtn(p: { icon: string; hint: string; on?: boolean; onClick: (e: MouseEvent) => void; class?: string; size?: number; label?: string; disabled?: boolean }) {
  return (
    <button class={`ibtn ${p.on ? 'on' : ''} ${p.class ?? ''}`} data-hint={p.hint} onClick={p.onClick as any} disabled={p.disabled}>
      <Icon name={p.icon} size={p.size ?? 14} />
      {p.label && <span>{p.label}</span>}
    </button>
  );
}

/**
 * Canvas em duas camadas: o conteúdo (draw) fica em cache e a sobreposição
 * (overlay: cursor de reprodução, prévia sob o mouse, retângulo de seleção) é
 * redesenhada sozinha, sem repintar todas as notas. paint() refaz tudo e roda
 * no mesmo quadro da mudança (useLayoutEffect).
 */
export function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  deps: unknown[],
  overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const drawRef = useRef(draw);
  const overlayRef = useRef(overlay);
  drawRef.current = draw;
  overlayRef.current = overlay;
  const cache = useRef<HTMLCanvasElement | null>(null);

  const ensure = () => {
    const c = ref.current;
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size.current;
    if (!w || !h) return null;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    if (!cache.current) cache.current = document.createElement('canvas');
    if (cache.current.width !== W || cache.current.height !== H) {
      cache.current.width = W;
      cache.current.height = H;
    }
    return { c, dpr, w, h };
  };
  const compose = (c: HTMLCanvasElement, dpr: number, w: number, h: number) => {
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(cache.current!, 0, 0);
    if (overlayRef.current) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayRef.current(ctx, w, h);
    }
  };
  const paint = () => {
    const g = ensure();
    if (!g) return;
    const cctx = cache.current!.getContext('2d')!;
    cctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    drawRef.current(cctx, g.w, g.h);
    compose(g.c, g.dpr, g.w, g.h);
  };
  const paintOverlay = () => {
    const g = ensure();
    if (!g) return;
    compose(g.c, g.dpr, g.w, g.h);
  };
  // Observa o canvas sempre que ele (re)aparece: janelas fechadas desmontam o canvas.
  const ro = useRef<ResizeObserver | null>(null);
  const observed = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (c === observed.current) return;
    ro.current?.disconnect();
    observed.current = c;
    if (!c) return;
    ro.current = new ResizeObserver(() => {
      const r = c.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
      paint();
    });
    ro.current.observe(c);
  });
  useEffect(() => () => ro.current?.disconnect(), []);
  useLayoutEffect(paint, deps);
  useEffect(() => onTheme(paint), []);
  return { ref, paint, paintOverlay, size };
}

export function Toggle(p: { on: boolean; onClick: () => void; children: ComponentChildren; title?: string; class?: string }) {
  return (
    <button class={`tog ${p.on ? 'on' : ''} ${p.class ?? ''}`} title={p.title} onClick={p.onClick}>
      {p.children}
    </button>
  );
}

export function ContextMenu(p: { x: number; y: number; items: [string, () => void][]; onClose: () => void }) {
  useEffect(() => {
    const close = () => p.onClose();
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true }), 0);
    return () => window.removeEventListener('pointerdown', close);
  }, []);
  return (
    <div class="ctx" style={{ left: `${p.x}px`, top: `${p.y}px` }} onPointerDown={(e) => e.stopPropagation()}>
      {p.items.map(([label, fn]) => (
        <button
          onClick={() => {
            fn();
            p.onClose();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export interface MenuItem {
  label: string;
  run?: () => void;
  sub?: MenuItem[];
  sep?: boolean;
  hint?: string;
  swatch?: string;
}

/** Menu de contexto com submenus (abrem ao passar o mouse). */
export function MenuTree(p: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => p.onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true }), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key);
    };
  }, []);
  return <MenuLevel x={p.x} y={p.y} items={p.items} onClose={p.onClose} />;
}

function MenuLevel(p: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const [open, setOpen] = useState<{ i: number; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: p.x, y: p.y });
  // não deixa o menu sair da tela
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(p.x, window.innerWidth - r.width - 6), y: Math.max(6, Math.min(p.y, window.innerHeight - r.height - 6)) });
  }, [p.x, p.y, p.items.length]);
  return (
    <>
      <div ref={ref} class="ctx menutree" style={{ left: `${pos.x}px`, top: `${pos.y}px` }} onPointerDown={(e) => e.stopPropagation()}>
        {p.items.map((it, i) =>
          it.sep ? (
            <div class="menu-sep" />
          ) : (
            <button
              class={`${it.sub ? 'has-sub' : ''} ${open?.i === i ? 'open' : ''}`}
              data-hint={it.hint}
              onPointerEnter={(e) => {
                if (!it.sub) return setOpen(null);
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setOpen({ i, x: r.right - 2, y: r.top - 4 });
              }}
              onClick={() => {
                if (it.sub) return;
                it.run?.();
                p.onClose();
              }}
            >
              {it.swatch && <span class="menu-swatch" style={{ background: it.swatch }} />}
              <span class="mt-label">{it.label}</span>
              {it.sub && <Icon name="chevron" size={10} />}
            </button>
          ),
        )}
      </div>
      {open && p.items[open.i]?.sub && <MenuLevel x={open.x} y={open.y} items={p.items[open.i].sub!} onClose={p.onClose} />}
    </>
  );
}
