// Central de Automações: escolhe uma função (riser, fade, seno, seno que respira,
// gate, bombeamento, escada, aleatório...) e ajusta pelos knobs; o gráfico mostra o
// resultado no tamanho do clipe. Clicar no gráfico edita os pontos à mão (vira uma
// automação personalizada; "Voltar à função" desfaz). Só edita o clipe aberto.

import { useRef, useState } from 'preact/hooks';
import type { AutoPoint, Clip } from '../../core/model';
import { PPQ, ticksPerBar } from '../../core/model';
import { set } from '../../core/ops';
import { GEN_DEFAULTS, GEN_PRESETS, renderGen, regen, type AutoGen, type Wave } from '../../core/autogen';
import { useApp, state, edit, previewEdit, toast } from '../state';
import { Win, Knob, useCanvas } from './widgets';
import { fmtAuto } from './Playlist';
import { ui, accent } from '../theme';

const NICE = [1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
/** Período em tempos → texto ("1/4 t", "2 t"). */
const fmtBeats = (v: number) => (v >= 1 ? `${+v.toFixed(2)} t` : Math.abs(1 / v - Math.round(1 / v)) < 0.01 ? `1/${Math.round(1 / v)} t` : `${+v.toFixed(3)} t`);
const snapNice = (v: number) => NICE.reduce((b, x) => (Math.abs(Math.log(x / v)) < Math.abs(Math.log(b / v)) ? x : b), NICE[0]);

const WAVES: [Wave, string][] = [
  ['sine', 'Seno'],
  ['tri', 'Triângulo'],
  ['square', 'Quadrada'],
  ['saw', 'Serra ↑'],
  ['sawdown', 'Serra ↓'],
];

export function AutoCenterWindow() {
  const s = useApp();
  const clip = s.autoClip ? s.project.clips.find((c) => c.id === s.autoClip && c.kind === 'auto') : undefined;
  return (
    <Win id="autos" title={clip?.target ? `Central de Automações · ${clip.target.label}` : 'Central de Automações'} icon="autos" minW={720} minH={400}>
      {clip ? (
        <Center clip={clip} />
      ) : (
        <div class="ac-empty">
          Nenhuma automação aberta. Botão direito num knob (ou no BPM) → <b>Criar automação</b>, ou duplo clique num clipe de automação na playlist.
        </div>
      )}
    </Win>
  );
}

function Center({ clip }: { clip: Clip }) {
  const s = useApp();
  const p = s.project;
  const tg = clip.target!;
  const gen: AutoGen | undefined = clip.gen;
  const custom = !gen || !!gen.custom;
  const g = { ...GEN_DEFAULTS, ...(gen ?? { kind: 'ramp' as const }) };
  /** Última função antes de editar à mão (para voltar a ela). */
  const lastGen = useRef<AutoGen | null>(null);
  const [sync, setSync] = useState(true);

  /** Muda a função (live = só prévia, enquanto arrasta um knob). */
  const apply = (next: AutoGen, live = false) => {
    const pts = renderGen(next, clip.len);
    const ops = [set(['clips', clip.id, 'gen'], next), set(['clips', clip.id, 'points'], pts)];
    if (live) previewEdit(ops);
    else edit(ops, 'Automação');
  };
  const patch = (k: keyof AutoGen, v: number | string | boolean, live: boolean) => apply({ ...(gen ?? { kind: 'ramp', lo: 0, hi: 1 }), custom: false, [k]: v } as AutoGen, live);

  const knob = (k: keyof typeof GEN_DEFAULTS, label: string, opt: { min?: number; max?: number; log?: boolean; fmt?: (v: number) => string; step?: number; period?: boolean; bipolar?: boolean } = {}) => {
    const v = g[k] as number;
    const fix = (x: number) => (opt.period && sync ? snapNice(x) : x);
    return (
      <div class="ac-knob">
        <Knob
          value={v}
          min={opt.min ?? 0}
          max={opt.max ?? 1}
          log={opt.log}
          step={opt.step}
          bipolar={opt.bipolar}
          size={34}
          format={opt.fmt ?? ((x) => fmtAuto(tg, x))}
          onInput={(x) => patch(k, fix(x), true)}
          onCommit={(x) => patch(k, fix(x), false)}
        />
        <span>{label}</span>
        <small>{(opt.fmt ?? ((x: number) => fmtAuto(tg, x)))(v)}</small>
      </div>
    );
  };
  const period = (k: 'period' | 'periodEnd' | 'breathePeriod', label: string) => knob(k, label, { min: 1 / 16, max: k === 'breathePeriod' ? 64 : 16, log: true, fmt: fmtBeats, period: true });
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const curve = (x: number) => (Math.abs(x) < 0.02 ? 'reta' : x > 0 ? `exp ${x.toFixed(2)}` : `log ${(-x).toFixed(2)}`);

  const kind = g.kind;
  const controls =
    kind === 'ramp' ? (
      <>
        {knob('lo', 'Início')}
        {knob('hi', 'Fim')}
        {knob('curve', 'Curva', { min: -1, max: 1, fmt: curve, bipolar: true })}
        <label class="ac-check">
          <input type="checkbox" checked={g.s} onChange={(e) => patch('s', (e.target as HTMLInputElement).checked, false)} /> Curva em S
        </label>
      </>
    ) : kind === 'lfo' ? (
      <>
        <div class="ac-waves">
          {WAVES.map(([w, l]) => (
            <button class={g.wave === w ? 'on' : ''} onClick={() => patch('wave', w, false)}>
              {l}
            </button>
          ))}
        </div>
        {knob('lo', 'Mínimo')}
        {knob('hi', 'Máximo')}
        {period('period', 'Período (início)')}
        {period('periodEnd', 'Período (fim)')}
        {knob('breathe', 'Respiração', { min: 0, max: 2, fmt: (x) => (x < 0.01 ? 'não' : `${x.toFixed(2)} oit.`) })}
        {period('breathePeriod', 'Ciclo da respiração')}
        {knob('depth', 'Intensidade (início)', { fmt: pct })}
        {knob('depthEnd', 'Intensidade (fim)', { fmt: pct })}
        {knob('phase', 'Fase', { fmt: (x) => `${Math.round(x * 360)}°` })}
      </>
    ) : kind === 'pump' ? (
      <>
        {knob('lo', 'Fundo')}
        {knob('hi', 'Topo')}
        {period('period', 'Período')}
        {knob('release', 'Volta', { min: 0.05, max: 1, fmt: pct })}
        {knob('curve', 'Curva da volta', { min: -1, max: 1, fmt: curve, bipolar: true })}
      </>
    ) : kind === 'steps' ? (
      <>
        {knob('lo', 'Início')}
        {knob('hi', 'Fim')}
        {knob('count', 'Degraus', { min: 2, max: 64, step: 1, fmt: (x) => String(Math.round(x)) })}
        {knob('curve', 'Curva', { min: -1, max: 1, fmt: curve, bipolar: true })}
      </>
    ) : (
      <>
        {knob('lo', 'Mínimo')}
        {knob('hi', 'Máximo')}
        {period('period', 'Período')}
        {knob('smooth', 'Deslize', { fmt: pct })}
        <button class="ac-dice" onClick={() => patch('seed', Math.floor(Math.random() * 1e6), false)} data-hint="Outra sequência aleatória">
          Sortear
        </button>
      </>
    );

  const bar = ticksPerBar(p);
  const num = (label: string, value: number, onSet: (v: number) => void, hint: string) => (
    <label class="ac-num" data-hint={hint}>
      {label}
      <input
        type="number"
        step="0.25"
        min="0"
        value={+value.toFixed(3)}
        onChange={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) onSet(v);
        }}
      />
    </label>
  );

  return (
    <div class="ac">
      <div class="ac-side">
        <div class="ac-side-head">Funções</div>
        {GEN_PRESETS.map((pr) => (
          <button
            class={`ac-preset ${!custom && gen?.preset === pr.id ? 'on' : ''}`}
            data-hint={pr.hint}
            onClick={() => {
              // a faixa escolhida fica (só a forma muda), menos nas que definem a própria faixa
              const keep = gen && !custom && gen.kind === pr.gen.kind && pr.gen.kind !== 'ramp' ? { lo: gen.lo, hi: gen.hi } : {};
              apply({ ...pr.gen, ...keep, preset: pr.id });
            }}
          >
            <PresetIcon gen={pr.gen} />
            {pr.label}
          </button>
        ))}
      </div>
      <div class="ac-main">
        <Graph clip={clip} custom={custom} onCustom={() => gen && !gen.custom && (lastGen.current = gen)} />
        <div class="ac-ctrls">
          {custom ? (
            <div class="ac-custom">
              <b>Automação personalizada</b> — os pontos valem (gravada ou editada à mão). Clique no gráfico para pôr um ponto, arraste para mover, botão direito apaga.
              {(lastGen.current || gen?.custom) && (
                <button
                  onClick={() => {
                    const back = lastGen.current ?? { ...gen!, custom: false };
                    apply({ ...back, custom: false });
                    toast('Voltou à função');
                  }}
                >
                  Voltar à função
                </button>
              )}
            </div>
          ) : (
            controls
          )}
        </div>
        <div class="ac-foot">
          {num('Início (compasso)', clip.pos / bar + 1, (v) => edit([set(['clips', clip.id, 'pos'], Math.max(0, Math.round((v - 1) * bar)))]), 'Onde a automação começa na playlist')}
          {num('Duração (compassos)', clip.len / bar, (v) => {
            const len = Math.max(PPQ / 4, Math.round(v * bar));
            edit([set(['clips', clip.id], regen({ ...clip, len }))]);
          }, 'Tamanho do clipe (a função se ajusta)')}
          <label class="ac-check" data-hint="Períodos travados em valores do tempo da música (1/16, 1/8, 1/4… tempos)">
            <input type="checkbox" checked={sync} onChange={(e) => setSync((e.target as HTMLInputElement).checked)} /> Períodos no tempo
          </label>
          <span class="ac-info">{(clip.points ?? []).length} pontos · faixa {fmtAuto(tg, 0)} a {fmtAuto(tg, 1)}</span>
        </div>
      </div>
    </div>
  );
}

/** Miniatura da forma da função (na lista de funções). */
function PresetIcon({ gen }: { gen: AutoGen }) {
  // miniatura: ~3 ciclos no começo (a forma importa, não o período real)
  const f = gen.kind === 'lfo' ? 1.4 / (gen.period ?? 1) : 1;
  const down = gen.lo > gen.hi; // fade out desce
  const pts = renderGen({ ...gen, lo: down ? 1 : 0, hi: down ? 0 : 1, ...(gen.kind === 'lfo' ? { period: (gen.period ?? 1) * f, periodEnd: Math.max((gen.periodEnd ?? 1) * f, 0.35), breathe: Math.min(1, gen.breathe ?? 0), breathePeriod: 4 } : {}) }, PPQ * 4);
  const d = pts.map((pt, i) => `${i ? 'L' : 'M'}${((pt.t / (PPQ * 4)) * 28).toFixed(1)},${(13 - pt.v * 12).toFixed(1)}`).join(' ');
  return (
    <svg class="ac-ico" width="30" height="14" viewBox="0 0 30 14">
      <path d={d} fill="none" stroke="currentColor" stroke-width="1.3" />
    </svg>
  );
}

/** Gráfico da automação no tamanho do clipe; clique/arraste edita os pontos. */
function Graph({ clip, custom, onCustom }: { clip: Clip; custom: boolean; onCustom: () => void }) {
  const p = state.project;
  const tg = clip.target!;
  const PAD = { l: 52, r: 12, t: 10, b: 20 };
  const drag = useRef<{ idx: number; pts: AutoPoint[] } | null>(null);
  const [hover, setHover] = useState<string>('');
  const geo = (w: number, h: number) => ({ x0: PAD.l, x1: w - PAD.r, y0: PAD.t, y1: h - PAD.b });
  const { ref, size } = useCanvas(
    (ctx, w, h) => {
      const G = geo(w, h);
      const pts = clip.points ?? [];
      const X = (t: number) => G.x0 + (t / clip.len) * (G.x1 - G.x0);
      const Y = (v: number) => G.y1 - v * (G.y1 - G.y0);
      ctx.fillStyle = ui('#171c1f');
      ctx.fillRect(0, 0, w, h);
      // grade: tempos e compassos
      const bar = ticksPerBar(p);
      const step = (G.x1 - G.x0) / (clip.len / PPQ) < 8 ? bar : PPQ;
      ctx.font = '10px sans-serif';
      for (let t = 0; t <= clip.len; t += step) {
        const x = Math.round(X(t)) + 0.5;
        const isBar = (clip.pos + t) % bar === 0;
        ctx.fillStyle = isBar ? ui('#344047') : ui('#232b30');
        ctx.fillRect(x, G.y0, 1, G.y1 - G.y0);
        if (isBar) {
          ctx.fillStyle = ui('#8a979e');
          ctx.fillText(String(Math.round((clip.pos + t) / bar) + 1), x + 2, h - 6);
        }
      }
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        ctx.fillStyle = ui('#232b30');
        ctx.fillRect(G.x0, Math.round(Y(v)) + 0.5, G.x1 - G.x0, 1);
        ctx.fillStyle = ui('#8a979e');
        ctx.fillText(fmtAuto(tg, v), 4, Y(v) + 4);
      }
      if (!pts.length) return;
      // área e linha
      const col = '#b58cf0';
      ctx.beginPath();
      ctx.moveTo(X(0), Y(pts[0].v));
      for (const pt of pts) ctx.lineTo(X(pt.t), Y(pt.v));
      ctx.lineTo(X(clip.len), Y(pts[pts.length - 1].v));
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(X(clip.len), G.y1);
      ctx.lineTo(X(0), G.y1);
      ctx.closePath();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      // pontos (todos, se forem poucos ou se for personalizada)
      if (custom || pts.length <= 120) {
        ctx.fillStyle = custom ? accent() : ui('#efe4ff');
        for (const pt of pts) {
          ctx.beginPath();
          ctx.arc(X(pt.t), Y(pt.v), custom ? 3.5 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
    [clip, custom],
  );

  const toTV = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const G = geo(size.current.w, size.current.h);
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = Math.max(0, Math.min(clip.len, Math.round(((x - G.x0) / (G.x1 - G.x0)) * clip.len)));
    const v = Math.max(0, Math.min(1, (G.y1 - y) / (G.y1 - G.y0)));
    return { t, v, x, y, G };
  };
  const nearest = (pts: AutoPoint[], x: number, y: number, G: ReturnType<typeof geo>) => {
    let best = -1, bd = 8;
    pts.forEach((pt, i) => {
      const d = Math.hypot(G.x0 + (pt.t / clip.len) * (G.x1 - G.x0) - x, G.y1 - pt.v * (G.y1 - G.y0) - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  /** Primeira edição à mão: a função vira automação personalizada. */
  const customOps = () => (clip.gen && !clip.gen.custom ? (onCustom(), [set(['clips', clip.id, 'gen'], { ...clip.gen, custom: true })]) : []);

  const onDown = (e: PointerEvent) => {
    const { t, v, x, y, G } = toTV(e);
    const pts = (clip.points ?? []).map((pt) => ({ ...pt }));
    const i = nearest(pts, x, y, G);
    if (e.button === 2) {
      if (i >= 0 && pts.length > 2) {
        pts.splice(i, 1);
        edit([...customOps(), set(['clips', clip.id, 'points'], pts)], 'Apagar ponto');
      }
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    let idx = i;
    if (idx < 0) {
      pts.push({ t, v });
      pts.sort((a, b) => a.t - b.t || 0);
      idx = pts.findIndex((pt) => pt.t === t && pt.v === v);
    }
    const ops = customOps();
    if (ops.length) edit(ops, 'Editar automação');
    drag.current = { idx, pts };
    previewEdit([set(['clips', clip.id, 'points'], pts)]);
  };
  const onMove = (e: PointerEvent) => {
    const { t, v } = toTV(e);
    setHover(`${fmtAuto(tg, v)} · compasso ${((clip.pos + t) / ticksPerBar(p) + 1).toFixed(2)}`);
    const d = drag.current;
    if (!d) return;
    const pts = d.pts.map((pt) => ({ ...pt }));
    const lo = d.idx > 0 ? pts[d.idx - 1].t : 0, hi = d.idx < pts.length - 1 ? pts[d.idx + 1].t : clip.len;
    pts[d.idx] = { t: Math.max(lo, Math.min(hi, t)), v };
    d.pts = pts;
    previewEdit([set(['clips', clip.id, 'points'], pts)]);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d) edit([set(['clips', clip.id, 'points'], d.pts)], 'Editar automação');
  };

  return (
    <div class="ac-graph-wrap">
      <canvas ref={ref} class="ac-graph" onPointerDown={onDown as any} onPointerMove={onMove as any} onPointerUp={onUp} onPointerLeave={() => setHover('')} onContextMenu={(e) => e.preventDefault()} />
      {hover && <div class="ac-hover">{hover}</div>}
    </div>
  );
}
