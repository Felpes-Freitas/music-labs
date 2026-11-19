// Painel do Prisma: visor de espectro interativo, envelopes arrastáveis e
// seções de parâmetros. Design próprio do Music Labs.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Channel, Params } from '../../core/model';
import { noteName } from '../../core/model';
import { INSTRUMENTS, PRESETS, type ParamDef } from '../../core/registry';
import { set } from '../../core/ops';
import * as A from '../../core/actions';
import { act, edit, previewEdit, setHint } from '../state';
import { usePref } from '../prefs';
import { Icon } from './icons';
import { Knob, fmt } from './widgets';
import { PrismaFilter } from './PrismaFilter';
import { ui, accent, themeRev } from '../theme';

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
      auto={{ path: ['channels', p.ch.id, 'params', p.k], label: `${p.ch.name} · ${d.label}` }}
      onInput={(x) => u.input(p.k, x)}
      onCommit={(x) => u.commit(p.k, x)}
    />
  );
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
    ctx.fillStyle = ui('#0f1416');
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
      ctx.fillStyle = ui('#0f1416');
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.color;
      ctx.stroke();
    }
  }, [a, d, s, r, p.color, themeRev]);

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

export function PrismaPanel(p: { ch: Channel }) {
  const ch = p.ch;
  const u = useParam(ch);
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
        <Voices ch={ch} />
        <button class={`pz-toggle ${mono ? 'on' : ''}`} data-hint="Mono / legato: uma nota por vez, deslizando entre elas com o glide" onClick={() => u.commit('mono', !mono)}>
          MONO
        </button>
        <PK ch={ch} k="glide" size={26} />
        <PK ch={ch} k="gain" size={26} />
      </div>
      <Fold id="spectrum" label="Espectro e filtro">
        <PrismaFilter ch={ch} />
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
