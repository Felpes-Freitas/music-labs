// Stitcher: junta várias gravações da mesma parte numa só, usando em cada trecho
// o take mais afinado. Grave várias vezes (de preferência com a região de loop
// ligada), escolha os takes e salve a costura como um clipe novo.

import { useEffect, useReducer, useRef } from 'preact/hooks';
import { useApp, state, toggleRecord, toast, setHint } from '../state';
import { audio } from '../audio';
import type { Clip } from '../../core/model';
import { planStitch, renderStitch, mergeSegments, type StitchPlan, type StitchTake } from '../../core/stitch';
import { trackPitch } from '../../core/pitchtrack';
import { Win, useCanvas } from './widgets';
import { Icon } from './icons';
import { accent, ui } from '../theme';
import { loadAudio, audioClips, clipName, trackBelow, saveAsClip, ticksPerSec } from '../clipaudio';

const COLORS = ['#f2a93b', '#4fc3e8', '#a77bff', '#6fdc8c', '#ff7b8a', '#e8d36a', '#5fd3c4', '#ff9e57'];

let ids: string[] = [];
let plan: StitchPlan | null = null;
let takes: StitchTake[] = [];
let sr = 48000;
let busy = '';
let preview: { stop: () => void; pos: () => number } | null = null;
const trackCache = new Map<string, ReturnType<typeof trackPitch>>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function stopPreview() {
  preview?.stop();
  preview = null;
}

/** Analisa os takes escolhidos e monta o plano da costura. */
async function analyze() {
  stopPreview();
  const p = state.project;
  const clips = ids.map((id) => p.clips.find((c) => c.id === id)).filter((c): c is Clip => !!c?.sample);
  ids = clips.map((c) => c.id);
  plan = null;
  takes = [];
  if (clips.length < 2) return changed();
  busy = 'Analisando a afinação dos takes…';
  changed();
  try {
    const tps = ticksPerSec(p);
    const loaded = await Promise.all(clips.map((c) => loadAudio(c.sample!)));
    sr = loaded[0].sr;
    if (loaded.some((a) => a.sr !== sr)) throw new Error('os takes têm taxas de amostragem diferentes');
    await new Promise((r) => setTimeout(r, 0));
    takes = clips.map((c, k) => {
      const a = loaded[k];
      const from = c.startSec ?? 0;
      let tr = trackCache.get(c.sample!);
      if (!tr) {
        const mono = new Float32Array(a.ch[0].length);
        for (const ch of a.ch) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / a.ch.length;
        tr = trackPitch(mono, sr);
        trackCache.set(c.sample!, tr);
      }
      return { offset: c.pos / tps - from, from, to: from + c.len / tps, ch: a.ch, track: tr };
    });
    plan = planStitch(takes, sr, null, false);
  } catch (e) {
    toast(`Stitcher: ${(e as Error).message}`);
  }
  busy = '';
  changed();
}

/** Adiciona takes (por exemplo, os que acabaram de ser gravados). */
export function addStitchTakes(newIds: string[]) {
  ids = [...new Set([...ids, ...newIds])];
  analyze();
}

export function StitchWindow() {
  const s = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force as () => void);
    return () => void listeners.delete(force as () => void);
  }, []);
  // takes apagados da playlist saem da lista
  useEffect(() => {
    if (ids.some((id) => !s.project.clips.some((c) => c.id === id))) analyze();
  }, [s.version]);
  const clips = audioClips(s.project).sort((a, b) => a.pos - b.pos || a.track - b.track);
  const recording = audio.recording;
  const toggle = (id: string) => {
    ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    analyze();
  };
  const rec = () => {
    if (audio.recording) return toggleRecord();
    toggleRecord(null, { smart: true, onDone: addStitchTakes });
  };
  const play = () => {
    if (preview) return stopPreview(), changed();
    if (!plan) return;
    const [L, R] = renderStitch({ ...plan, segments: mergeSegments(plan.segments) }, takes, sr);
    preview = audio.playBuffer([L, R], sr, 0, () => {
      preview = null;
      changed();
    });
    changed();
  };
  const save = async () => {
    if (!plan) return;
    const p = state.project;
    const tps = ticksPerSec(p);
    const [L, R] = renderStitch({ ...plan, segments: mergeSegments(plan.segments) }, takes, sr);
    const tick = Math.round(plan.start * tps), len = Math.round((plan.end - plan.start) * tps);
    const lowest = Math.max(...ids.map((id) => p.clips.find((c) => c.id === id)?.track ?? 0));
    const first = p.clips.find((c) => c.id === ids[0]);
    try {
      const id = await saveAsClip(L, R, sr, 'Costura', { tick, track: trackBelow(p, lowest, tick, len), insert: first?.insert });
      if (id) toast('Costura salva abaixo dos takes');
    } catch (e) {
      toast(`Erro ao salvar a costura: ${(e as Error).message}`);
    }
  };
  const used = plan ? new Set(plan.segments.map((x) => x.take)) : new Set<number>();
  return (
    <Win id="stitch" title="Stitcher" icon="stitch" minW={640} minH={300}>
      <div class="tool">
        <div class="tool-bar">
          <button class={`amp-rec ${recording ? 'on' : ''}`} onClick={rec} data-hint="Grava (só quando você canta/toca); cada take entra aqui. Dica: ligue a região de loop e grave a mesma parte várias vezes">
            <Icon name="record" size={14} />
            {recording ? 'Parar' : 'Gravar'}
          </button>
          <button class={preview ? 'on' : ''} disabled={!plan} onClick={play} data-hint="Ouvir a costura">
            <Icon name={preview ? 'stop' : 'play'} size={12} /> Ouvir
          </button>
          <button disabled={!plan} onClick={() => analyze()} data-hint="Volta para a escolha automática (desfaz as trocas feitas à mão)">
            Escolha automática
          </button>
          <span class="tool-info">{plan ? `${plan.segments.length} trechos · ${used.size} de ${takes.length} takes usados` : ids.length === 1 ? 'Escolha pelo menos 2 takes' : ''}</span>
          <button class="tool-main" disabled={!plan} onClick={save} data-hint="Cria um clipe com a costura abaixo dos takes (os takes não mudam)">
            <Icon name="save" size={13} /> Salvar costura
          </button>
        </div>
        <div class="stitch-body">
          <div class="stitch-list">
            <div class="stitch-list-head">Takes</div>
            {clips.length === 0 && <div class="tool-empty small">Nenhum áudio na playlist ainda. Grave pelo botão acima.</div>}
            {clips.map((c) => {
              const k = ids.indexOf(c.id);
              const cents = k >= 0 && plan ? plan.takeCents[k] : null;
              return (
                <label class={`stitch-take ${k >= 0 ? 'on' : ''}`} data-hint={`${clipName(c)} · track ${c.track + 1}`}>
                  <input type="checkbox" checked={k >= 0} onChange={() => toggle(c.id)} />
                  {k >= 0 && <span class="stitch-dot" style={{ background: COLORS[k % COLORS.length] }} />}
                  <span class="stitch-name">{clipName(c)}</span>
                  {cents !== null && cents !== undefined && (
                    <span class={`stitch-cents ${cents < 12 ? 'good' : cents < 25 ? 'mid' : 'bad'}`} data-hint="Desvio médio da afinação">
                      ±{Math.round(cents)}c
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {busy ? <div class="tool-empty">{busy}</div> : plan ? <Lanes /> : <div class="tool-empty">Marque dois ou mais takes da mesma parte (gravados no mesmo trecho da música) para costurar.</div>}
        </div>
      </div>
    </Win>
  );
}

const HEAD = 0;
const LANE = 46;

function Lanes() {
  const pl = plan!;
  const view = useRef({ zx: 100 });
  const { ref, paint, paintOverlay } = useCanvas(
    (ctx, w, h) => {
      const v = view.current;
      v.zx = (w - HEAD - 8) / Math.max(0.5, pl.end - pl.start);
      const xOf = (t: number) => HEAD + (t - pl.start) * v.zx;
      ctx.fillStyle = ui('#1a1f22');
      ctx.fillRect(0, 0, w, h);
      // faixa do resultado
      ctx.fillStyle = ui('#14191b');
      ctx.fillRect(0, 0, w, 22);
      for (const sg of pl.segments) {
        if (sg.take < 0) continue;
        ctx.fillStyle = COLORS[sg.take % COLORS.length];
        ctx.fillRect(xOf(sg.t0), 4, Math.max(1, (sg.t1 - sg.t0) * v.zx - 1), 14);
      }
      ctx.font = 'bold 10px sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText('Costura', 6, 15);
      ctx.fillStyle = '#fff';
      ctx.fillText('Costura', 6, 15);
      ctx.lineWidth = 1;
      takes.forEach((tk, k) => {
        const y = 28 + k * LANE;
        if (y > h) return;
        ctx.fillStyle = k % 2 ? ui('#1d2326') : ui('#20262a');
        ctx.fillRect(0, y, w, LANE - 4);
        // trechos escolhidos deste take
        for (const sg of pl.segments) {
          if (sg.take !== k) continue;
          ctx.fillStyle = COLORS[k % COLORS.length];
          ctx.globalAlpha = 0.22;
          ctx.fillRect(xOf(sg.t0), y, (sg.t1 - sg.t0) * v.zx, LANE - 4);
          ctx.globalAlpha = 1;
          ctx.fillRect(xOf(sg.t0), y + LANE - 7, (sg.t1 - sg.t0) * v.zx, 3);
        }
        // forma de onda
        const ch = tk.ch[0];
        ctx.fillStyle = COLORS[k % COLORS.length];
        ctx.globalAlpha = 0.75;
        const mid = y + (LANE - 4) / 2;
        for (let x = HEAD; x < w; x++) {
          const t = pl.start + (x - HEAD) / v.zx;
          const a0 = Math.floor((t - tk.offset) * sr), a1 = Math.floor((t + 1 / v.zx - tk.offset) * sr);
          if (a1 < tk.from * sr || a0 > tk.to * sr) continue;
          let pk = 0;
          for (let i = Math.max(0, a0); i < Math.min(ch.length, a1); i += 3) pk = Math.max(pk, Math.abs(ch[i]));
          ctx.fillRect(x, mid - pk * 18, 1, Math.max(1, pk * 36));
        }
        ctx.globalAlpha = 1;
        // desvio por trecho
        ctx.font = '9px sans-serif';
        for (const sg of pl.segments) {
          const c = sg.cents[k];
          const sw = (sg.t1 - sg.t0) * v.zx;
          if (c === null || sw < 26) continue;
          ctx.fillStyle = c < 12 ? '#8ae8a4' : c < 25 ? '#e8c547' : '#ff8a8a';
          ctx.fillText(`${Math.round(c)}c`, xOf(sg.t0) + 3, y + 11);
        }
        ctx.fillStyle = ui('#c9d1d5');
        ctx.font = 'bold 9.5px sans-serif';
        ctx.fillText(`Take ${k + 1}`, 6, y + LANE - 10);
      });
      // divisões entre trechos
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      for (const sg of pl.segments) ctx.fillRect(xOf(sg.t0), 22, 1, h);
    },
    [pl],
    (ctx, _w, h) => {
      if (!preview) return;
      const x = HEAD + preview.pos() * view.current.zx;
      ctx.fillStyle = accent();
      ctx.fillRect(x, 0, 1.5, h);
    },
  );
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      paintOverlay();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const at = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t = pl.start + (x - HEAD) / view.current.zx;
    const k = Math.floor((y - 28) / LANE);
    const si = pl.segments.findIndex((sg) => t >= sg.t0 && t < sg.t1);
    return { k: y >= 28 && k < takes.length ? k : -1, si };
  };
  return (
    <canvas
      ref={ref}
      class="tool-canvas"
      style={{ height: `${Math.max(120, 32 + takes.length * LANE)}px`, flex: 'none' }}
      onPointerDown={(e) => {
        const { k, si } = at(e as unknown as MouseEvent);
        if (k < 0 || si < 0) return;
        const sg = pl.segments[si];
        if (sg.cents[k] === null) return toast(`O take ${k + 1} não canta/toca nesse trecho`);
        sg.take = k; // troca manual
        stopPreview();
        paint();
        changed();
      }}
      onPointerMove={(e) => {
        const { k, si } = at(e as unknown as MouseEvent);
        if (k < 0 || si < 0) return;
        const c = pl.segments[si].cents[k];
        setHint(c === null ? `Take ${k + 1}: sem som neste trecho` : `Take ${k + 1}: desvio de ${Math.round(c)} cents neste trecho · clique para usar este take aqui`);
      }}
      data-hint="Cada faixa é um take; o colorido é o trecho que entra na costura. Clique num trecho de outro take para trocar."
    />
  );
}
