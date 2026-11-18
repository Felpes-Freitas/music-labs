// Painel do Prisma: visor de espectro interativo, envelopes arrastáveis e
// seções de parâmetros. Design próprio do Music Labs.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Channel, Params } from '../../core/model';
import { noteName } from '../../core/model';
import { INSTRUMENTS, PRESETS, type ParamDef } from '../../core/registry';
import { MAX_HARM, cutoffOct, filterGain, prismaSpectrum, type SpectrumState } from '../../core/prisma';
import { mtof } from '../../core/dsp';
import { set } from '../../core/ops';
import * as A from '../../core/actions';
import { act, edit, previewEdit, setHint } from '../state';
import { usePref } from '../prefs';
import { Icon } from './icons';
import { Knob, fmt } from './widgets';

const DEFS = INSTRUMENTS.prisma.params;
const def = (k: string) => DEFS.find((d) => d.key === k)!;
const val = (p: Params, k: string) => {
  const v = p[k];
  return v === undefined ? def(k).def : v;
};

function formatFor(d: ParamDef) {
  return (x: number) => {
    if (d.unit === 'Hz') return x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 1 : 2)} kHz` : `${x.toFixed(x < 10 ? 2 : 0)} Hz`;
    if (d.unit === 's') return x < 1 ? `${Math.round(x * 1000)} ms` : `${x.toFixed(2)} s`;
    if (d.step && d.step >= 1) return `${Math.round(x)}${d.unit ? ' ' + d.unit : ''}`;
    if (!d.unit && d.min === 0 && d.max === 1) return `${Math.round(x * 100)}%`;
    return `${fmt(x)}${d.unit ? ' ' + d.unit : ''}`;
  };
}

function useParam(ch: Channel) {
  const path = (k: string) => ['channels', ch.id, 'params', k];
  return {
    input: (k: string, v: unknown) => previewEdit([set(path(k), v)]),
    commit: (k: string, v: unknown) => edit([set(path(k), v)]),
    many: (vals: Record<string, unknown>, final: boolean) => (final ? edit : previewEdit)(Object.entries(vals).map(([k, v]) => set(path(k), v))),
  };
}

/** Rótulos curtos para caber embaixo dos knobs (a dica completa fica na barra). */
const SHORT: Record<string, string> = {
  slope: 'Curva',
  keytrack: 'Tecla',
  velCutoff: 'Velocity',
  fenv: 'Quantidade',
  fa: 'Ataque',
  fd: 'Decay',
  fs: 'Sustain',
  fr: 'Release',
  pluckTime: 'Tempo',
  pluckBright: 'Agudos',
  phaserRate: 'Veloc.',
  phaserSpacing: 'Espaço',
  phaserWidth: 'Estreito',
  oct: '+1 oit.',
  sub: '−1 oit.',
  vibRate: 'Vib. vel.',
  vibDelay: 'Vib. atraso',
  lfoFilter: 'LFO corte',
  lfoRate: 'LFO vel.',
  velSens: 'Velocity',
  harmonics: 'Harmôn.',
  res: 'Resson.',
  uniPhase: 'Fase',
  uniVary: 'Variação',
};

function PK(p: { ch: Channel; k: string; size?: number; color?: string }) {
  const d = def(p.k);
  const u = useParam(p.ch);
  const v = Number(val(p.ch.params, p.k));
  return (
    <Knob
      size={p.size ?? 32}
      value={v}
      min={d.min!}
      max={d.max!}
      def={Number(d.def)}
      log={d.curve === 'log' && d.min! > 0}
      step={d.step}
      bipolar={d.min! < 0 && d.max! > 0}
      color={p.color}
      label={SHORT[p.k] ?? d.label}
      format={formatFor(d)}
      title={`${d.label}: ${formatFor(d)(v)}`}
      onInput={(x) => u.input(p.k, x)}
      onCommit={(x) => u.commit(p.k, x)}
    />
  );
}

// ---------------------------------------------------------------- visor de espectro

const FMIN = 20, FMAX = 20000;
const fx = (f: number, w: number) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w;
const xf = (x: number, w: number) => FMIN * Math.pow(FMAX / FMIN, x / w);

function Spectrum(p: { ch: Channel; refKey: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const params = p.ch.params;
  const anim = Number(val(params, 'phaser')) > 0 || Number(val(params, 'lfoFilter')) > 0;
  useEffect(() => {
    let raf = 0;
    let t0 = performance.now();
    const attack = new Float32Array(MAX_HARM + 1);
    const sustain = new Float32Array(MAX_HARM + 1);
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const r = c.getBoundingClientRect();
      if (c.width !== Math.round(r.width * dpr)) {
        c.width = Math.round(r.width * dpr);
        c.height = Math.round(r.height * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = r.width, h = r.height;
      const pm = p.ch.params;
      const now = (performance.now() - t0) / 1000;
      const phase = (now * Number(val(pm, 'phaserRate'))) % 1;
      const lfo = Math.sin(2 * Math.PI * now * Number(val(pm, 'lfoRate')));
      const f0 = mtof(p.refKey);
      const sAtk: SpectrumState = { t: 0, fenv: 1, vel: 0.8, lfo: anim ? lfo : 0, phaser: phase };
      const sSus: SpectrumState = { t: 1.2, fenv: Number(val(pm, 'fs')), vel: 0.8, lfo: anim ? lfo : 0, phaser: phase };
      const H = prismaSpectrum(pm, f0, 44100, sAtk, attack);
      prismaSpectrum(pm, f0, 44100, sSus, sustain);
      // fundo e grade
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#11171a');
      g.addColorStop(1, '#0b0f11');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.font = '9px sans-serif';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.round(fx(f, w)) + 0.5;
        ctx.strokeStyle = '#1d282d';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillStyle = '#4a5a62';
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, h - 3);
      }
      const dbY = (a: number) => {
        const db = 20 * Math.log10(Math.max(a, 1e-6));
        return h - 12 - Math.max(0, Math.min(1, (db + 60) / 66)) * (h - 20);
      };
      // harmônicos: ataque (barras) e sustentação (traço)
      for (let k = 1; k <= H; k++) {
        const x = fx(k * f0, w);
        if (x > w) break;
        const ya = dbY(attack[k]);
        const ys = dbY(sustain[k]);
        ctx.fillStyle = 'rgba(242,169,59,0.85)';
        ctx.fillRect(x - 1, ya, 2.2, h - 12 - ya);
        ctx.fillStyle = '#7fd6f2';
        ctx.fillRect(x - 3, ys - 1, 6, 2);
      }
      // curva do filtro (sustentação)
      const co = cutoffOct(pm, f0, sSus);
      ctx.strokeStyle = 'rgba(160,230,255,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const y = dbY(filterGain(pm, xf(x, w), co) * 0.45);
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      // marcador do corte
      const cx = fx(Math.pow(2, co), w);
      ctx.fillStyle = '#f2a93b';
      ctx.beginPath();
      ctx.arc(cx, dbY(0.45 * filterGain(pm, Math.pow(2, co), co)), 4, 0, Math.PI * 2);
      ctx.fill();
      // legenda
      ctx.fillStyle = 'rgba(242,169,59,0.9)';
      ctx.fillRect(8, 8, 8, 8);
      ctx.fillStyle = '#c9d1d5';
      ctx.fillText('ataque', 20, 15);
      ctx.fillStyle = '#7fd6f2';
      ctx.fillRect(66, 11, 8, 2);
      ctx.fillStyle = '#c9d1d5';
      ctx.fillText('sustentação', 78, 15);
      ctx.fillStyle = 'rgba(160,230,255,0.9)';
      ctx.fillRect(146, 11, 10, 2);
      ctx.fillStyle = '#c9d1d5';
      ctx.fillText(`filtro · nota ${noteName(p.refKey)} · ${H} harmônicos`, 160, 15);
      if (anim) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [p.ch.params, p.refKey, anim]);

  const u = useParam(p.ch);
  const onDown = (e: PointerEvent) => {
    const c = e.currentTarget as HTMLCanvasElement;
    c.setPointerCapture(e.pointerId);
    const r = c.getBoundingClientRect();
    let last: Record<string, number> = {};
    const at = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
      const y = Math.max(0, Math.min(r.height, ev.clientY - r.top));
      const cutoff = Math.round(xf(x, r.width));
      const res = Math.round((1 - y / r.height) * 100) / 100;
      last = { cutoff: Math.max(20, Math.min(20000, cutoff)), res: Math.max(0, Math.min(1, res)) };
      setHint(`Corte ${last.cutoff >= 1000 ? (last.cutoff / 1000).toFixed(2) + ' kHz' : last.cutoff + ' Hz'} · ressonância ${Math.round(last.res * 100)}%`);
      u.many(last, false);
    };
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      u.many(last, true);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
  };
  return <canvas ref={ref} class="pz-spectrum" onPointerDown={onDown as any} data-hint="Espectro da nota: barras = ataque, traços = sustentação, linha = filtro. Arraste: horizontal muda o corte, vertical muda a ressonância." />;
}

// ---------------------------------------------------------------- envelope arrastável

function EnvGraph(p: { ch: Channel; keys: [string, string, string, string]; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [a, d, s, r] = p.keys.map((k) => Number(val(p.ch.params, k)));
  const u = useParam(p.ch);
  // escala visual: raiz quadrada do tempo, cada segmento com largura máxima
  const SEG = 0.27;
  const tx = (t: number, max: number) => Math.sqrt(t / max) * SEG;
  const geom = (w: number, h: number) => {
    const ax = tx(a, 6) * w;
    const dx = ax + tx(d, 8) * w;
    const sx = dx + 0.16 * w;
    const rx = sx + tx(r, 10) * w;
    const top = 8, bot = h - 6;
    const sy = bot - s * (bot - top);
    return { ax, dx, sx, rx, top, bot, sy };
  };
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rc = c.getBoundingClientRect();
    c.width = Math.round(rc.width * dpr);
    c.height = Math.round(rc.height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rc.width, h = rc.height;
    const g = geom(w, h);
    ctx.fillStyle = '#0f1416';
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    ctx.moveTo(0, g.bot);
    ctx.lineTo(g.ax, g.top);
    ctx.lineTo(g.dx, g.sy);
    ctx.lineTo(g.sx, g.sy);
    ctx.lineTo(g.rx, g.bot);
    const grad = ctx.createLinearGradient(0, g.top, 0, g.bot);
    grad.addColorStop(0, p.color + '66');
    grad.addColorStop(1, p.color + '08');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineWidth = 1;
    for (const [x, y] of [[g.ax, g.top], [g.dx, g.sy], [g.rx, g.bot]] as [number, number][]) {
      ctx.fillStyle = '#0f1416';
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.color;
      ctx.stroke();
    }
  }, [a, d, s, r, p.color]);

  const onDown = (e: PointerEvent) => {
    const c = e.currentTarget as HTMLCanvasElement;
    const rc = c.getBoundingClientRect();
    const g = geom(rc.width, rc.height);
    const x0 = e.clientX - rc.left, y0 = e.clientY - rc.top;
    const pts = [
      { n: 'a', x: g.ax, y: g.top },
      { n: 'd', x: g.dx, y: g.sy },
      { n: 'r', x: g.rx, y: g.bot },
    ];
    pts.sort((p1, p2) => Math.hypot(p1.x - x0, p1.y - y0) - Math.hypot(p2.x - x0, p2.y - y0));
    const which = pts[0].n;
    c.setPointerCapture(e.pointerId);
    const [ka, kd, ks, kr] = p.keys;
    let last: Record<string, number> = {};
    const fromX = (dx: number, max: number, minV: number) => Math.max(minV, Math.min(max, (Math.max(0, dx) / (SEG * rc.width)) ** 2 * max));
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - rc.left, y = ev.clientY - rc.top;
      if (which === 'a') last = { [ka]: Math.round(fromX(x, 6, 0.001) * 1000) / 1000 };
      else if (which === 'd')
        last = {
          [kd]: Math.round(fromX(x - g.ax, 8, 0.005) * 1000) / 1000,
          [ks]: Math.round(Math.max(0, Math.min(1, (g.bot - y) / (g.bot - g.top))) * 100) / 100,
        };
      else last = { [kr]: Math.round(fromX(x - g.sx, 10, 0.005) * 1000) / 1000 };
      setHint(Object.entries(last).map(([k, v]) => `${def(k).label}: ${formatFor(def(k))(v)}`).join(' · '));
      u.many(last, false);
    };
    const up = () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      if (Object.keys(last).length) u.many(last, true);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
  };
  return <canvas ref={ref} class="pz-env" onPointerDown={onDown as any} data-hint="Arraste os pontos: ataque, decay/sustain e release" />;
}

/** Cabeçalho que recolhe/mostra um gráfico (a escolha fica salva). */
function Fold(p: { id: string; label: string; children: any; def?: boolean }) {
  const [open, setOpen] = usePref(`fold.${p.id}`, p.def ?? true);
  return (
    <div class={`pz-fold ${open ? '' : 'closed'}`}>
      <button class="fold" data-hint={open ? `Recolher: ${p.label}` : `Mostrar: ${p.label}`} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'chevron'} size={10} />
        <span>{p.label}</span>
      </button>
      {open && p.children}
    </div>
  );
}

function Voices(p: { ch: Channel }) {
  const u = useParam(p.ch);
  const n = Math.round(Number(val(p.ch.params, 'unison')));
  return (
    <div class="pz-voices" data-hint="Vozes (unison): cópias do som tocando juntas, levemente desafinadas e abertas no estéreo, para um som mais cheio">
      <span>Vozes</span>
      {Array.from({ length: 9 }, (_, i) => (
        <button class={n === i + 1 ? 'on' : n > i + 1 ? 'in' : ''} onClick={() => u.commit('unison', i + 1)}>
          {i + 1}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- painel

const FTYPES: [string, string][] = [
  ['lowpass', 'Passa-baixa'],
  ['bandpass', 'Passa-banda'],
  ['highpass', 'Passa-alta'],
  ['notch', 'Notch'],
  ['off', 'Desligado'],
];

function FilterIcon(p: { type: string }) {
  const paths: Record<string, string> = {
    lowpass: 'M1 5h7c3 0 4 2 5 6',
    bandpass: 'M1 11c3-1 4-6 6.5-6S11 10 15 11',
    highpass: 'M1 11c1-4 2-6 5-6h9',
    notch: 'M1 5h5c1 0 1.5 6 2 6s1-6 2-6h5',
    off: 'M1 8h14',
  };
  return (
    <svg width="18" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d={paths[p.type]} />
    </svg>
  );
}

export function PrismaPanel(p: { ch: Channel }) {
  const ch = p.ch;
  const [refKey, setRefKey] = useState(60);
  const u = useParam(ch);
  const ftype = String(val(ch.params, 'ftype'));
  const mono = val(ch.params, 'mono') === true;
  const prismaPresets = Object.entries(PRESETS).filter(([, v]) => v.type === 'prisma');
  return (
    <div class="prisma">
      <div class="pz-head">
        <div class="pz-logo">
          <svg width="22" height="22" viewBox="0 0 24 24">
            <path d="M12 2 L22 20 H2 Z" fill="none" stroke="#f2a93b" stroke-width="1.8" />
            <path d="M12 2 L12 20" stroke="#7fd6f2" stroke-width="1.2" />
            <path d="M14 11 L23 8 M15 13 L23 13 M15.5 15 L23 18" stroke="#c49cff" stroke-width="1.2" />
          </svg>
          <b>PRISMA</b>
          <span class="dim">sintetizador aditivo espectral</span>
        </div>
        <select
          value=""
          data-hint="Carregar um preset do Prisma"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) act(A.updateChannel, { channel: ch.id, preset: v });
          }}
        >
          <option value="">preset…</option>
          {prismaPresets.map(([k, v]) => (
            <option value={k} title={v.description}>
              {k.replace(/^Prisma /, '')}
            </option>
          ))}
        </select>
        <label class="pz-ref" data-hint="Nota usada no visor de espectro">
          visor em
          <select value={refKey} onChange={(e) => setRefKey(Number((e.target as HTMLSelectElement).value))}>
            {[36, 48, 60, 72, 84].map((k) => (
              <option value={k}>{noteName(k)}</option>
            ))}
          </select>
        </label>
        <Voices ch={ch} />
        <button class={`pz-toggle ${mono ? 'on' : ''}`} data-hint="Mono / legato: uma nota por vez, deslizando entre elas com o glide" onClick={() => u.commit('mono', !mono)}>
          MONO
        </button>
        <PK ch={ch} k="glide" size={26} />
        <PK ch={ch} k="gain" size={26} />
      </div>
      <Fold id="spectrum" label="Espectro">
        <Spectrum ch={ch} refKey={refKey} />
      </Fold>
      <div class="pz-grid">
        <section class="pz-card">
          <h4>Timbre</h4>
          <div class="pz-row">
            <PK ch={ch} k="tilt" />
            <PK ch={ch} k="even" />
            <PK ch={ch} k="sine" />
            <PK ch={ch} k="harmonics" />
          </div>
        </section>
        <section class="pz-card wide">
          <h4>Filtro harmônico</h4>
          <div class="pz-seg" data-hint="Tipo do filtro harmônico">
            {FTYPES.map(([t, label]) => (
              <button class={ftype === t ? 'on' : ''} data-hint={label} onClick={() => u.commit('ftype', t)}>
                <FilterIcon type={t} />
              </button>
            ))}
          </div>
          <div class="pz-row">
            <PK ch={ch} k="cutoff" size={40} color="#7fd6f2" />
            <PK ch={ch} k="res" size={40} color="#7fd6f2" />
            <PK ch={ch} k="slope" />
            <PK ch={ch} k="keytrack" />
            <PK ch={ch} k="velCutoff" />
          </div>
        </section>
        <section class="pz-card">
          <h4>Envelope do filtro</h4>
          <Fold id="envFilter" label="gráfico">
            <EnvGraph ch={ch} keys={['fa', 'fd', 'fs', 'fr']} color="#7fd6f2" />
          </Fold>
          <div class="pz-row">
            <PK ch={ch} k="fenv" color="#7fd6f2" />
            <PK ch={ch} k="fa" size={26} />
            <PK ch={ch} k="fd" size={26} />
            <PK ch={ch} k="fs" size={26} />
            <PK ch={ch} k="fr" size={26} />
          </div>
        </section>
        <section class="pz-card">
          <h4>Volume</h4>
          <Fold id="envAmp" label="gráfico">
            <EnvGraph ch={ch} keys={['a', 'd', 's', 'r']} color="#f2a93b" />
          </Fold>
          <div class="pz-row">
            <PK ch={ch} k="a" size={26} />
            <PK ch={ch} k="d" size={26} />
            <PK ch={ch} k="s" size={26} />
            <PK ch={ch} k="r" size={26} />
            <PK ch={ch} k="velSens" size={26} />
          </div>
        </section>
        <section class="pz-card">
          <h4>Pluck</h4>
          <div class="pz-row">
            <PK ch={ch} k="pluck" color="#c49cff" />
            <PK ch={ch} k="pluckTime" />
            <PK ch={ch} k="pluckBright" />
          </div>
        </section>
        <section class="pz-card">
          <h4>Phaser harmônico</h4>
          <div class="pz-row">
            <PK ch={ch} k="phaser" color="#c49cff" />
            <PK ch={ch} k="phaserRate" />
            <PK ch={ch} k="phaserSpacing" />
            <PK ch={ch} k="phaserWidth" />
          </div>
        </section>
        <section class="pz-card">
          <h4>Unison e camadas</h4>
          <div class="pz-row">
            <PK ch={ch} k="detune" color="#6fdc8c" />
            <PK ch={ch} k="spread" />
            <PK ch={ch} k="uniPhase" />
            <PK ch={ch} k="uniVary" />
            <PK ch={ch} k="oct" />
            <PK ch={ch} k="sub" />
          </div>
        </section>
        <section class="pz-card">
          <h4>Modulação</h4>
          <div class="pz-row">
            <PK ch={ch} k="vibrato" />
            <PK ch={ch} k="vibRate" />
            <PK ch={ch} k="vibDelay" />
            <PK ch={ch} k="lfoFilter" color="#7fd6f2" />
            <PK ch={ch} k="lfoRate" />
          </div>
        </section>
        <section class="pz-card">
          <h4>Saída</h4>
          <div class="pz-row">
            <PK ch={ch} k="ensemble" color="#6fdc8c" />
          </div>
        </section>
      </div>
    </div>
  );
}
