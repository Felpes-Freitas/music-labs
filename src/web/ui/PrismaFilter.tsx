// Filtro do Prisma: espectrograma ao vivo do canal + curva do filtro com 6 nós
// arrastáveis (x = frequência, y = ganho ou ressonância) e painel vertical com
// os controles do nó selecionado.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Channel } from '../../core/model';
import { noteName } from '../../core/model';
import { INSTRUMENTS, type ParamDef } from '../../core/registry';
import { FILTER_NODES, NODE_FREQ, NODE_LABEL, NODE_TYPES, curveDb, nodeDb, nodeKey, nodeUsesGain, readNodes, resolveNodes, type NodeField, type NodeType, type ResolvedNode } from '../../core/prisma';
import { BANDS, bandFreq } from '../../core/analyzer';
import { mtof } from '../../core/dsp';
import { set } from '../../core/ops';
import { edit, onLive, previewEdit, setHint } from '../state';
import { Knob, fmt } from './widgets';

export const NODE_COLORS = ['#f2a93b', '#7fd6f2', '#c49cff', '#6fdc8c', '#ff7b8a', '#e8d36a'];

const FMIN = 20, FMAX = 20000;
const DB_TOP = 24, DB_BOT = -48; // escala da curva
const AN_TOP = -6, AN_BOT = -100; // escala do analisador
const PAD_T = 8, PAD_B = 16;
const LN2_4 = Math.log(2) / 4;

const DEFS = INSTRUMENTS.prisma.params;
const defOf = (k: string) => DEFS.find((d) => d.key === k)!;

interface Geo {
  w: number;
  h: number;
}
const xOf = (f: number, g: Geo) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * g.w;
const fOf = (x: number, g: Geo) => FMIN * Math.pow(FMAX / FMIN, x / g.w);
const yOfDb = (db: number, g: Geo) => PAD_T + ((DB_TOP - db) / (DB_TOP - DB_BOT)) * (g.h - PAD_T - PAD_B);
const dbOfY = (y: number, g: Geo) => DB_TOP - ((y - PAD_T) / (g.h - PAD_T - PAD_B)) * (DB_TOP - DB_BOT);
const yAn = (db: number, g: Geo) => PAD_T + ((AN_TOP - db) / (AN_TOP - AN_BOT)) * (g.h - PAD_T - PAD_B);

/** Altura (dB) da alça do nó: ganho (pico/prateleira/linha) ou efeito da ressonância (cortes). */
function handleDb(n: ResolvedNode): number {
  if (nodeUsesGain(n.type)) return n.gain;
  if (n.type === 'lowpass' || n.type === 'highpass') return n.res * 26 - n.slope * LN2_4;
  if (n.type === 'bandpass') return n.res * 26;
  if (n.type === 'notch') return 20 * Math.log10(Math.max(1e-6, 1 - (0.98 - n.res * 0.3)));
  return 0;
}

/** Inverso: o que a posição vertical significa para o nó. */
function fromHandle(t: NodeType, db: number, slope: number): { field: NodeField; value: number } {
  if (nodeUsesGain(t)) return { field: 'gain', value: Math.max(-36, Math.min(24, Math.round(db * 10) / 10)) };
  let res = 0;
  if (t === 'lowpass' || t === 'highpass') res = (db + slope * LN2_4) / 26;
  else if (t === 'bandpass') res = db / 26;
  else if (t === 'notch') res = (0.98 - (1 - Math.pow(10, db / 20))) / 0.3;
  return { field: 'res', value: Math.max(0, Math.min(1, Math.round(res * 100) / 100)) };
}

const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);

function FilterGraph(p: { ch: Channel; sel: number; setSel: (i: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chRef = useRef(p.ch);
  chRef.current = p.ch;
  const selRef = useRef(p.sel);
  selRef.current = p.sel;
  const spec = useRef(new Float32Array(BANDS).fill(-120));
  const refKey = useRef(60);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ i: number; type: NodeType; key: number; slope: number; edits: Record<string, number> } | null>(null);

  const nodesFor = () => {
    const f0 = mtof(refKey.current);
    return { f0, nodes: resolveNodes(chRef.current.params, f0, { t: 0, fenv: 0, vel: 0.75, lfo: 0, phaser: 0 }) };
  };

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const off = onLive((st) => {
      const s = spec.current;
      const src = st.spectrum;
      for (let b = 0; b < BANDS; b++) s[b] = Math.max(src ? src[b] : -120, s[b] - 1.2);
      if (st.lit.length) refKey.current = Math.max(...st.lit);
    });
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 30) return;
      last = t;
      const c = ref.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const r = c.getBoundingClientRect();
      if (!r.width) return;
      if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
        c.width = Math.round(r.width * dpr);
        c.height = Math.round(r.height * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g: Geo = { w: r.width, h: r.height };
      paint(ctx, g);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, []);

  const paint = (ctx: CanvasRenderingContext2D, g: Geo) => {
    const { w, h } = g;
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#10161a');
    bg.addColorStop(1, '#090c0e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    // grade de frequência e de dB
    ctx.font = '9px sans-serif';
    for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xOf(f, g)) + 0.5;
      ctx.fillStyle = '#18222a';
      ctx.fillRect(x, PAD_T, 1, h - PAD_T - PAD_B);
      ctx.fillStyle = '#4f6068';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, h - 4);
    }
    for (const db of [12, 0, -12, -24, -36]) {
      const y = Math.round(yOfDb(db, g)) + 0.5;
      ctx.fillStyle = db === 0 ? '#2f4048' : '#161f25';
      ctx.fillRect(0, y, w, 1);
      ctx.fillStyle = '#4f6068';
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 2);
    }
    // espectrograma ao vivo do som do canal
    const s = spec.current;
    ctx.beginPath();
    ctx.moveTo(0, h - PAD_B);
    for (let b = 0; b < BANDS; b++) ctx.lineTo(xOf(bandFreq(b), g), Math.min(h - PAD_B, yAn(s[b], g)));
    ctx.lineTo(w, h - PAD_B);
    ctx.closePath();
    const ag = ctx.createLinearGradient(0, PAD_T, 0, h);
    ag.addColorStop(0, 'rgba(79,195,232,0.38)');
    ag.addColorStop(1, 'rgba(79,195,232,0.05)');
    ctx.fillStyle = ag;
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,220,245,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let b = 0; b < BANDS; b++) {
      const x = xOf(bandFreq(b), g), y = Math.min(h - PAD_B, yAn(s[b], g));
      b ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    // harmônicos da nota de referência (onde o filtro atua)
    const { f0, nodes } = nodesFor();
    for (let k = 1; k * f0 < FMAX; k++) {
      const x = xOf(k * f0, g);
      ctx.fillStyle = `rgba(242,169,59,${k === 1 ? 0.9 : Math.max(0.12, 0.5 / Math.sqrt(k))})`;
      ctx.fillRect(x, h - PAD_B - (k === 1 ? 9 : 5), 1, k === 1 ? 9 : 5);
    }
    // curva do nó selecionado (tracejada)
    const selNode = nodes.find((n) => n.i === selRef.current);
    if (selNode && selNode.type !== 'point') {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = NODE_COLORS[selNode.i - 1];
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const y = yOfDb(Math.max(DB_BOT - 6, nodeDb(selNode, Math.log2(fOf(x, g)))), g);
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // curva total
    const y0 = yOfDb(0, g);
    ctx.beginPath();
    let firstY = 0;
    for (let x = 0; x <= w; x += 2) {
      const y = yOfDb(Math.max(DB_BOT - 6, Math.min(DB_TOP + 6, curveDb(nodes, Math.log2(fOf(x, g))))), g);
      if (!x) {
        ctx.moveTo(x, y);
        firstY = y;
      } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.lineTo(w, y0);
    ctx.lineTo(0, y0);
    ctx.lineTo(0, firstY);
    ctx.fillStyle = 'rgba(255,179,71,0.08)';
    ctx.fill();
    // nós
    for (const n of nodes) {
      const x = xOf(Math.pow(2, n.oc), g);
      const y = yOfDb(Math.max(DB_BOT, Math.min(DB_TOP, handleDb(n))), g);
      const sel = n.i === selRef.current;
      const rad = sel ? 9 : 7.5;
      const col = NODE_COLORS[n.i - 1];
      // anel de intensidade (0 a 200%)
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, rad + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * Math.min(2, n.amt));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = '#10161a';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText(String(n.i), x - 2.5, y + 3);
    }
    // legenda e leitura sob o mouse
    ctx.font = '9.5px sans-serif';
    ctx.fillStyle = '#8fa3ad';
    const label = `nota ${noteName(refKey.current)} · ${nodes.length} ${nodes.length === 1 ? 'nó ativo' : 'nós ativos'}`;
    ctx.fillText(label, w - ctx.measureText(label).width - 6, 12);
    if (hover.current && !drag.current) {
      const f = fOf(hover.current.x, g);
      ctx.fillStyle = '#c9d1d5';
      ctx.fillText(`${fmtHz(f)} · ${curveDb(nodes, Math.log2(f)).toFixed(1)} dB`, 26, 12);
    }
  };

  const geo = (): Geo => {
    const r = ref.current!.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };
  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const hit = (x: number, y: number) => {
    const g = geo();
    const { nodes } = nodesFor();
    let best: ResolvedNode | null = null, bd = 13;
    for (const n of nodes) {
      const d = Math.hypot(xOf(Math.pow(2, n.oc), g) - x, yOfDb(Math.max(DB_BOT, Math.min(DB_TOP, handleDb(n))), g) - y);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  };
  const path = (k: string) => ['channels', p.ch.id, 'params', k];
  const kt = () => Math.log2(mtof(refKey.current) / 261.63);

  const onDown = (e: PointerEvent) => {
    const [x, y] = local(e);
    const n = hit(x, y);
    if (!n) return;
    if (e.button === 2) {
      edit([set(path(nodeKey(n.i, 'type')), 'off')]);
      setHint(`Nó ${n.i} desligado`);
      return;
    }
    p.setSel(n.i);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { i: n.i, type: n.type, key: n.key, slope: n.slope, edits: {} };
  };
  const onMove = (e: PointerEvent) => {
    const [x, y] = local(e);
    hover.current = { x, y };
    const d = drag.current;
    if (!d) {
      const n = hit(x, y);
      setHint(n ? `Nó ${n.i}: ${NODE_LABEL[n.type]} · arraste para mover · roda: intensidade (${Math.round(n.amt * 100)}%) · botão direito: desligar` : 'Duplo clique: novo nó aqui · arraste os nós: horizontal = frequência, vertical = ganho ou ressonância');
      (e.currentTarget as HTMLElement).style.cursor = n ? 'grab' : 'crosshair';
      return;
    }
    const g = geo();
    const fine = e.shiftKey;
    const lf = Math.log2(Math.max(FMIN, Math.min(FMAX, fOf(Math.max(0, Math.min(g.w, x)), g))));
    const freq = Math.max(20, Math.min(20000, Math.round(Math.pow(2, lf - d.key * kt()))));
    const v = fromHandle(d.type, dbOfY(Math.max(PAD_T, Math.min(g.h - PAD_B, y)), g), d.slope);
    d.edits = { [nodeKey(d.i, 'freq')]: freq, [nodeKey(d.i, v.field)]: v.value };
    if (fine) delete d.edits[nodeKey(d.i, 'freq')];
    previewEdit(Object.entries(d.edits).map(([k, val]) => set(path(k), val)));
    setHint(`Nó ${d.i}: ${fmtHz(freq)} · ${v.field === 'gain' ? `ganho ${v.value} dB` : `ressonância ${Math.round(v.value * 100)}%`}${fine ? ' (Shift: só vertical)' : ''}`);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && Object.keys(d.edits).length) edit(Object.entries(d.edits).map(([k, val]) => set(path(k), val)));
  };
  const onDbl = (e: MouseEvent) => {
    const [x, y] = local(e);
    if (hit(x, y)) return;
    const free = readNodes(p.ch.params).find((n) => n.type === 'off');
    if (!free) {
      setHint('Os 6 nós já estão em uso: desligue um (botão direito) para criar outro.');
      return;
    }
    const g = geo();
    const freq = Math.round(Math.pow(2, Math.log2(fOf(x, g)) - free.key * kt()));
    const gain = Math.max(-36, Math.min(24, Math.round(dbOfY(y, g))));
    edit([set(path(nodeKey(free.i, 'type')), 'peak'), set(path(nodeKey(free.i, 'freq')), freq), set(path(nodeKey(free.i, 'gain')), gain), set(path(nodeKey(free.i, 'res')), 0.4), set(path(nodeKey(free.i, 'amt')), 1)]);
    p.setSel(free.i);
  };
  const onWheel = (e: WheelEvent) => {
    const [x, y] = local(e);
    const n = hit(x, y) ?? (e.shiftKey ? null : null);
    if (!n) return;
    e.preventDefault();
    p.setSel(n.i);
    if (e.shiftKey) {
      const res = Math.max(0, Math.min(1, Math.round((n.res - Math.sign(e.deltaY) * 0.05) * 100) / 100));
      edit([set(path(nodeKey(n.i, 'res')), res)]);
      setHint(`Nó ${n.i}: ${n.type === 'peak' ? 'largura' : 'ressonância'} ${Math.round(res * 100)}%`);
    } else {
      const amt = Math.max(0, Math.min(2, Math.round((n.amt - Math.sign(e.deltaY) * 0.05) * 100) / 100));
      edit([set(path(nodeKey(n.i, 'amt')), amt)]);
      setHint(`Nó ${n.i}: intensidade ${Math.round(amt * 100)}%`);
    }
  };

  return (
    <canvas
      ref={ref}
      class="pz-graph"
      onPointerDown={onDown as any}
      onPointerMove={onMove as any}
      onPointerUp={onUp}
      onPointerLeave={() => (hover.current = null)}
      onDblClick={onDbl as any}
      onWheel={onWheel as any}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

// ---------------------------------------------------------------- painel do nó

const FIELD_LABEL: Partial<Record<NodeField, string>> = { freq: 'Corte', res: 'Resson.', slope: 'Curva', gain: 'Ganho', key: 'Tecla', vel: 'Velocity', amt: 'Intensid.' };

function fmtFor(d: ParamDef) {
  return (x: number) => {
    if (d.unit === 'Hz') return fmtHz(x);
    if (d.unit === 'dB') return `${x > 0 ? '+' : ''}${x.toFixed(1)} dB`;
    if (d.key.endsWith('amt')) return `${Math.round(x * 100)}%`;
    if (!d.unit && d.min === 0 && d.max === 1) return `${Math.round(x * 100)}%`;
    return `${fmt(x)}${d.unit ? ' ' + d.unit : ''}`;
  };
}

function NodePanel(p: { ch: Channel; sel: number; setSel: (i: number) => void }) {
  const nodes = readNodes(p.ch.params);
  const n = nodes[p.sel - 1];
  const path = (k: string) => ['channels', p.ch.id, 'params', k];
  const fields: NodeField[] =
    n.type === 'off'
      ? []
      : ['freq', 'res', ...(n.type === 'peak' || n.type === 'notch' || n.type === 'point' ? [] : (['slope'] as NodeField[])), ...(nodeUsesGain(n.type) ? (['gain'] as NodeField[]) : []), 'key', 'vel', 'amt'];
  const activate = (i: number) => {
    edit([set(path(nodeKey(i, 'type')), 'peak'), set(path(nodeKey(i, 'freq')), NODE_FREQ[i - 1]), set(path(nodeKey(i, 'gain')), 6), set(path(nodeKey(i, 'res')), 0.4)]);
    p.setSel(i);
  };
  return (
    <div class="pz-nodes">
      <div class="pz-chips">
        {nodes.map((x) => (
          <button
            class={`chip ${x.type === 'off' ? 'off' : ''} ${x.i === p.sel ? 'sel' : ''}`}
            style={{ '--c': NODE_COLORS[x.i - 1] } as any}
            data-hint={x.type === 'off' ? `Nó ${x.i} desligado · clique para ativar` : `Nó ${x.i}: ${NODE_LABEL[x.type]}`}
            onClick={() => (x.type === 'off' && x.i === p.sel ? activate(x.i) : p.setSel(x.i))}
          >
            {x.i}
          </button>
        ))}
      </div>
      <select value={n.type} data-hint="Tipo do nó" onChange={(e) => edit([set(path(nodeKey(n.i, 'type')), (e.target as HTMLSelectElement).value)])}>
        {NODE_TYPES.map((t) => (
          <option value={t}>{NODE_LABEL[t]}</option>
        ))}
      </select>
      {n.type === 'off' ? (
        <button class="pz-activate" onClick={() => activate(n.i)}>
          Ativar nó {n.i}
        </button>
      ) : (
        <div class="pz-nodeknobs">
          {fields.map((f) => {
            const key = nodeKey(n.i, f);
            const d = defOf(key);
            const v = Number(p.ch.params[key] ?? (n as any)[f]);
            return (
              <Knob
                size={28}
                value={v}
                min={d.min!}
                max={d.max!}
                def={Number(d.def)}
                log={d.curve === 'log' && d.min! > 0}
                bipolar={d.min! < 0 && d.max! > 0}
                color={NODE_COLORS[n.i - 1]}
                label={f === 'res' && n.type === 'peak' ? 'Largura' : FIELD_LABEL[f]}
                format={fmtFor(d)}
                title={`${d.label}: ${fmtFor(d)(v)}`}
                onInput={(x) => previewEdit([set(path(key), x)])}
                onCommit={(x) => edit([set(path(key), x)])}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PrismaFilter(p: { ch: Channel }) {
  const [sel, setSel] = useState(1);
  return (
    <div class="pz-filter">
      <FilterGraph ch={p.ch} sel={sel} setSel={setSel} />
      <NodePanel ch={p.ch} sel={sel} setSel={setSel} />
    </div>
  );
}

export { FILTER_NODES };
