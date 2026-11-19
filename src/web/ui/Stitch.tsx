// Stitcher: junta várias gravações da mesma parte numa só, usando em cada trecho
// o take que chegou mais perto da nota que se queria cantar. A melodia (a nota
// pretendida de cada trecho) é deduzida do tom e do consenso entre os takes, e
// pode ser corrigida arrastando as notas na faixa de cima.

import { useEffect, useReducer, useRef } from 'preact/hooks';
import { useApp, state, toggleRecord, toast, setHint } from '../state';
import { audio } from '../audio';
import type { Clip } from '../../core/model';
import { noteName } from '../../core/model';
import { planStitch, renderStitch, rescore, tuneToMelody, type StitchPlan, type StitchTake } from '../../core/stitch';
import { trackPitch } from '../../core/pitchtrack';
import { snapToKey, keyLabel, type Key } from '../../core/key';
import { Win, useCanvas } from './widgets';
import { Icon } from './icons';
import { accent, ui } from '../theme';
import { loadAudio, audioClips, clipName, trackBelow, saveAsClip, ticksPerSec, pickAudioFiles, uploadFiles, placeAudios, playheadTick, droppedAudio, acceptsAudio } from '../clipaudio';
import { KeyPicker } from './KeyPicker';
import { getPref, setPref } from '../prefs';

const COLORS = ['#f2a93b', '#4fc3e8', '#a77bff', '#6fdc8c', '#ff7b8a', '#e8d36a', '#5fd3c4', '#ff9e57', '#c0e05a', '#e07bd8', '#7ba6ff', '#ffb3a0'];
const col = (k: number) => COLORS[k % COLORS.length];

let ids: string[] = [];
let plan: StitchPlan | null = null;
let takes: StitchTake[] = [];
let sr = 48000;
let busy = '';
let key: Key | null = null;
let tuneOut = getPref('stitch.tune', true);
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
  busy = `Analisando a afinação de ${clips.length} takes…`;
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
    plan = planStitch(takes, sr, key, false);
  } catch (e) {
    toast(`Stitcher: ${(e as Error).message}`);
  }
  busy = '';
  changed();
}

/** Adiciona takes (por exemplo, os que acabaram de ser gravados ou importados). */
export function addStitchTakes(newIds: string[]) {
  ids = [...new Set([...ids, ...newIds])];
  analyze();
}

async function importPaths(paths: string[]) {
  if (!paths.length) return;
  busy = `Importando ${paths.length} ${paths.length > 1 ? 'áudios' : 'áudio'}…`;
  changed();
  try {
    // alinhados entre si pelo contorno de volume, a partir da posição atual da música
    addStitchTakes(await placeAudios(paths, playheadTick(), true));
  } catch (e) {
    busy = '';
    toast(`Stitcher: ${(e as Error).message}`);
    changed();
  }
}

function render(): [Float32Array, Float32Array] | null {
  if (!plan) return null;
  const [L, R] = renderStitch(plan, takes, sr);
  return tuneOut ? tuneToMelody(L, R, plan, sr) : [L, R];
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
  // os takes escolhidos primeiro, na ordem das faixas; depois os outros áudios
  const rank = (c: Clip) => (ids.includes(c.id) ? ids.indexOf(c.id) : 1e6 + c.track);
  const clips = audioClips(s.project).sort((a, b) => rank(a) - rank(b) || a.pos - b.pos);
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
    const out = render();
    if (!out) return;
    preview = audio.playBuffer(out, sr, 0, () => {
      preview = null;
      changed();
    });
    changed();
  };
  const save = async () => {
    const out = render();
    if (!plan || !out) return;
    const p = state.project;
    const tps = ticksPerSec(p);
    const tick = Math.round(plan.start * tps), len = Math.round((plan.end - plan.start) * tps);
    const lowest = Math.max(...ids.map((id) => p.clips.find((c) => c.id === id)?.track ?? 0));
    const first = p.clips.find((c) => c.id === ids[0]);
    try {
      const id = await saveAsClip(out[0], out[1], sr, 'Costura', { tick, track: trackBelow(p, lowest, tick, len), insert: first?.insert });
      if (id) toast('Costura salva abaixo dos takes');
    } catch (e) {
      toast(`Erro ao salvar a costura: ${(e as Error).message}`);
    }
  };
  const used = plan ? new Set(plan.segments.filter((x) => x.take >= 0).map((x) => x.take)) : new Set<number>();
  return (
    <Win id="stitch" title="Stitcher" icon="stitch" minW={680} minH={320}>
      <div
        class="tool"
        onDragOver={(e) => acceptsAudio(e) && (e.preventDefault(), (e.currentTarget as HTMLElement).classList.add('dropping'))}
        onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('dropping')}
        onDrop={async (e) => {
          (e.currentTarget as HTMLElement).classList.remove('dropping');
          if (!acceptsAudio(e)) return;
          e.preventDefault();
          e.stopPropagation();
          try {
            importPaths(await droppedAudio(e));
          } catch (err) {
            toast(`Stitcher: ${(err as Error).message}`);
          }
        }}
      >
        <div class="tool-bar">
          <button class={`amp-rec ${recording ? 'on' : ''}`} onClick={rec} data-hint="Grava (só quando você canta/toca); cada take entra aqui. Dica: ligue a região de loop e grave a mesma parte várias vezes">
            <Icon name="record" size={14} />
            {recording ? 'Parar' : 'Gravar'}
          </button>
          <button
            class="tool-open"
            onClick={async () => {
              const files = await pickAudioFiles(true);
              if (!files.length) return;
              try {
                importPaths(await uploadFiles(files));
              } catch (err) {
                toast(`Stitcher: ${(err as Error).message}`);
              }
            }}
            data-hint="Importar vários áudios do computador (os takes são alinhados entre si). Também dá para arrastar arquivos para esta janela"
          >
            <Icon name="folder" size={13} /> Importar áudios…
          </button>
          <button class={preview ? 'on' : ''} disabled={!plan} onClick={play} data-hint="Ouvir a costura">
            <Icon name={preview ? 'stop' : 'play'} size={12} /> Ouvir
          </button>
          {plan && (
            <KeyPicker
              value={key}
              detected={plan.detectedKey}
              onChange={(k) => {
                key = k;
                analyze();
              }}
            />
          )}
          <label class="tool-check" data-hint="Depois de costurar, leva cada nota exatamente para a nota da melodia (mantém o vibrato)">
            <input
              type="checkbox"
              checked={tuneOut}
              onChange={() => {
                tuneOut = !tuneOut;
                setPref('stitch.tune', tuneOut);
                stopPreview();
                changed();
              }}
            />
            Afinar na melodia
          </label>
          <button disabled={!plan} onClick={() => analyze()} data-hint="Refaz a melodia e a escolha dos takes do zero (desfaz edições)">
            Recomeçar
          </button>
          <span class="tool-info">{plan ? `${plan.segments.length} notas · ${used.size} de ${takes.length} takes usados` : ''}</span>
          <button class="tool-main" disabled={!plan} onClick={save} data-hint="Cria um clipe com a costura abaixo dos takes (os takes não mudam)">
            <Icon name="save" size={13} /> Salvar costura
          </button>
        </div>
        <div class="stitch-body">
          <div class="stitch-list">
            <div class="stitch-list-head">
              Takes
              {clips.length > 1 && (
                <button
                  class="stitch-all"
                  onClick={() => {
                    ids = ids.length === clips.length ? [] : clips.map((c) => c.id);
                    analyze();
                  }}
                >
                  {ids.length === clips.length ? 'nenhum' : 'todos'}
                </button>
              )}
            </div>
            {clips.length === 0 && <div class="tool-empty small">Nenhum áudio ainda. Importe, arraste arquivos para cá ou grave.</div>}
            {clips.map((c) => {
              const k = ids.indexOf(c.id);
              const cents = k >= 0 && plan ? plan.takeCents[k] : null;
              return (
                <label class={`stitch-take ${k >= 0 ? 'on' : ''}`} data-hint={`${clipName(c)} · track ${c.track + 1}`}>
                  <input type="checkbox" checked={k >= 0} onChange={() => toggle(c.id)} />
                  {k >= 0 && <span class="stitch-dot" style={{ background: col(k) }} />}
                  <span class="stitch-name">{clipName(c)}</span>
                  {cents !== null && cents !== undefined && (
                    <span class={`stitch-cents ${cents < 15 ? 'good' : cents < 35 ? 'mid' : 'bad'}`} data-hint="Distância média até a melodia">
                      ±{Math.round(cents)}c
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {busy ? (
            <div class="tool-empty">{busy}</div>
          ) : plan ? (
            <div class="stitch-lanes">
              <Lanes />
            </div>
          ) : (
            <div class="tool-empty">Marque dois ou mais takes da mesma parte, importe vários áudios ou arraste arquivos para cá.</div>
          )}
        </div>
      </div>
    </Win>
  );
}

const MEL = 130; // altura da faixa da melodia
const LANE = 42;

function Lanes() {
  const pl = plan!;
  const names = ids.map((id) => {
    const c = state.project.clips.find((x) => x.id === id);
    return c ? clipName(c) : '';
  });
  const view = useRef({ zx: 100, lo: 55, hi: 72 });
  const drag = useRef<{ si: number; y0: number; orig: number } | null>(null);
  const melRow = () => (MEL - 18) / Math.max(1, view.current.hi - view.current.lo);
  const melY = (m: number) => 14 + (view.current.hi - m) * melRow();
  const xOf = (t: number) => (t - pl.start) * view.current.zx;
  const { ref, paint, paintOverlay } = useCanvas(
    (ctx, w, h) => {
      const v = view.current;
      v.zx = (w - 8) / Math.max(0.5, pl.end - pl.start);
      const targets = pl.segments.map((s) => s.target).filter((t): t is number => t !== null);
      if (!drag.current && targets.length) {
        v.lo = Math.min(...targets) - 2;
        v.hi = Math.max(...targets) + 2;
      }
      ctx.fillStyle = ui('#1a1f22');
      ctx.fillRect(0, 0, w, h);
      // ---- melodia: linhas das notas, blocos com a nota pretendida
      ctx.fillStyle = ui('#14191b');
      ctx.fillRect(0, 0, w, MEL);
      const rh = melRow();
      ctx.font = '9px sans-serif';
      for (let m = Math.ceil(v.lo); m <= v.hi; m++) {
        const y = melY(m);
        ctx.fillStyle = m % 12 === 0 ? ui('#2f383d') : ui('#1e2528');
        ctx.fillRect(0, y, w, 1);
      }
      pl.segments.forEach((sg, si) => {
        if (sg.target === null) return;
        const x0 = xOf(sg.t0), x1 = xOf(sg.t1);
        // o que o take escolhido cantou (traço fino) e a nota pretendida (bloco)
        const sung = sg.take >= 0 ? sg.sung[sg.take] : null;
        if (sung !== null) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x0 + 2, melY(sung) - 1, Math.max(2, x1 - x0 - 4), 2);
        }
        const y = melY(sg.target) - rh * 0.4;
        ctx.fillStyle = sg.take >= 0 ? col(sg.take) : '#777';
        ctx.globalAlpha = drag.current?.si === si ? 1 : 0.85;
        ctx.fillRect(x0 + 1, y, Math.max(3, x1 - x0 - 2), Math.max(6, rh * 0.8));
        ctx.globalAlpha = 1;
        if (x1 - x0 > 22) {
          ctx.fillStyle = '#111';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText(noteName(sg.target), x0 + 4, y + Math.max(6, rh * 0.8) - 2);
        }
      });
      ctx.font = 'bold 9.5px sans-serif';
      ctx.fillStyle = ui('#9fb0b8');
      ctx.fillText(`MELODIA · ${keyLabel(pl.key)} · arraste uma nota para corrigir`, 6, 10);
      // ---- takes
      takes.forEach((tk, k) => {
        const y = MEL + 6 + k * LANE;
        if (y > h) return;
        ctx.fillStyle = k % 2 ? ui('#1d2326') : ui('#20262a');
        ctx.fillRect(0, y, w, LANE - 4);
        for (const sg of pl.segments) {
          if (sg.take !== k) continue;
          ctx.fillStyle = col(k);
          ctx.globalAlpha = 0.22;
          ctx.fillRect(xOf(sg.t0), y, (sg.t1 - sg.t0) * v.zx, LANE - 4);
          ctx.globalAlpha = 1;
          ctx.fillRect(xOf(sg.t0), y + LANE - 7, (sg.t1 - sg.t0) * v.zx, 3);
        }
        const ch = tk.ch[0];
        ctx.fillStyle = col(k);
        ctx.globalAlpha = 0.75;
        const mid = y + (LANE - 4) / 2;
        for (let x = 0; x < w; x++) {
          const t = pl.start + x / v.zx;
          const a0 = Math.floor((t - tk.offset) * sr), a1 = Math.floor((t + 1 / v.zx - tk.offset) * sr);
          if (a1 < tk.from * sr || a0 > tk.to * sr) continue;
          let pk = 0;
          for (let i = Math.max(0, a0); i < Math.min(ch.length, a1); i += 3) pk = Math.max(pk, Math.abs(ch[i]));
          ctx.fillRect(x, mid - pk * 16, 1, Math.max(1, pk * 32));
        }
        ctx.globalAlpha = 1;
        ctx.font = '9px sans-serif';
        for (const sg of pl.segments) {
          const c = sg.cents[k];
          const sw = (sg.t1 - sg.t0) * v.zx;
          if (c === null || c === undefined || sw < 26) continue;
          ctx.fillStyle = c < 15 ? '#8ae8a4' : c < 35 ? '#e8c547' : '#ff8a8a';
          ctx.fillText(`${Math.round(c)}c`, xOf(sg.t0) + 3, y + 11);
        }
        ctx.fillStyle = ui('#c9d1d5');
        ctx.font = 'bold 9.5px sans-serif';
        ctx.fillText(names[k] ?? `Take ${k + 1}`, 6, y + LANE - 10);
      });
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      for (const sg of pl.segments) ctx.fillRect(xOf(sg.t0), 0, 1, h);
    },
    [pl, pl.key],
    (ctx, _w, h) => {
      if (!preview) return;
      const x = preview.pos() * view.current.zx;
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
    const t = pl.start + x / view.current.zx;
    const si = pl.segments.findIndex((sg) => t >= sg.t0 && t < sg.t1);
    const k = y > MEL + 6 ? Math.floor((y - MEL - 6) / LANE) : -1;
    return { x, y, si, k: k < takes.length ? k : -1, inMel: y < MEL };
  };
  return (
    <canvas
      ref={ref}
      class="tool-canvas"
      style={{ height: `${Math.max(200, MEL + 10 + takes.length * LANE)}px`, flex: 'none' }}
      onPointerDown={(e) => {
        const { y, si, k, inMel } = at(e as unknown as MouseEvent);
        if (si < 0) return;
        const sg = pl.segments[si];
        if (inMel && sg.target !== null) {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { si, y0: y, orig: sg.target };
          return;
        }
        if (k < 0) return;
        if (sg.cents[k] === null || sg.cents[k] === undefined) return toast(`${names[k]} não canta/toca nessa nota`);
        sg.take = k; // troca manual
        stopPreview();
        paint();
        changed();
      }}
      onPointerMove={(e) => {
        const { y, si, k, inMel } = at(e as unknown as MouseEvent);
        const d = drag.current;
        if (d) {
          const sg = pl.segments[d.si];
          const raw = d.orig - (y - d.y0) / melRow();
          // grade do tom; Ctrl: qualquer semitom
          sg.target = e.ctrlKey || pl.key.scale === 'chromatic' ? Math.round(raw) : snapToKey(raw, pl.key);
          setHint(`Nota ${d.si + 1}: era para ser ${noteName(sg.target)} (Ctrl: qualquer semitom)`);
          paint();
          return;
        }
        if (si < 0) return;
        const sg = pl.segments[si];
        if (inMel && sg.target !== null) {
          (e.currentTarget as HTMLElement).style.cursor = 'ns-resize';
          const sung = sg.take >= 0 ? sg.sung[sg.take] : null;
          setHint(`Nota pretendida: ${noteName(sg.target)}${sung !== null ? ` · ${names[sg.take]} cantou ${noteName(Math.round(sung))} ${Math.round((sung - Math.round(sung)) * 100)}c` : ''} · arraste para corrigir`);
          return;
        }
        (e.currentTarget as HTMLElement).style.cursor = k >= 0 ? 'pointer' : 'default';
        if (k < 0) return;
        const c = sg.cents[k];
        setHint(c === null || c === undefined ? `${names[k]}: sem som nesta nota` : `${names[k]}: ${Math.round(c)} cents da nota pretendida (${noteName(sg.target ?? 60)}) · clique para usar este take aqui`);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        // a melodia mudou: escolhe de novo o take mais perto em cada nota
        rescore(pl, takes, sr);
        stopPreview();
        paint();
        changed();
      }}
      data-hint="Em cima, a melodia (arraste uma nota para corrigir). Embaixo, cada take; o colorido é o que entra na costura. Clique num trecho de outro take para trocar."
    />
  );
}
