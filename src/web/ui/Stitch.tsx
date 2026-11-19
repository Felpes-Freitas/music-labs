// Stitcher: junta várias gravações da mesma parte numa só, usando em cada trecho
// o take que chegou mais perto da nota que se queria cantar.
//
// Em cima fica o resultado (a onda final, cada pedaço pintado com a cor do áudio
// de onde veio; clique para tocar dali), logo abaixo a melodia (arraste uma nota
// para corrigir) e embaixo a lista dos áudios, cada um com a sua cor.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { useApp, state, toggleRecord, toast, setHint } from '../state';
import { audio } from '../audio';
import type { Clip } from '../../core/model';
import { noteName } from '../../core/model';
import { planStitch, renderStitch, rescore, tuneToMelody, type StitchPlan, type StitchTake } from '../../core/stitch';
import { trackPitch } from '../../core/pitchtrack';
import { snapToKey, keyLabel, type Key } from '../../core/key';
import { Win, useCanvas } from './widgets';
import { Icon } from './icons';
import { ui } from '../theme';
import { loadAudio, audioClips, clipName, trackBelow, saveAsClip, ticksPerSec, pickAudioFiles, uploadFiles, placeAudios, playheadTick, droppedAudio, acceptsAudio } from '../clipaudio';
import { KeyPicker } from './KeyPicker';
import { getPref, setPref } from '../prefs';

const COLORS = ['#ff5d5d', '#4fc3e8', '#f2c94c', '#6fdc8c', '#b58cf0', '#ff9e57', '#5fd3c4', '#ff7bc0', '#9ccc3a', '#7ba6ff', '#e8a87c', '#c0c0c0'];

let ids: string[] = [];
/** Cor fixa de cada áudio (não muda quando outros entram ou saem). */
const colorOf = new Map<string, string>();
let plan: StitchPlan | null = null;
let takes: StitchTake[] = [];
let sr = 48000;
let busy = '';
let key: Key | null = null;
let tuneOut = getPref('stitch.tune', true);
/** Áudio final já montado (refeito quando a costura muda). */
let final: { L: Float32Array; R: Float32Array; peaks: Float32Array } | null = null;
let rev = 0;
let preview: { stop: () => void; pos: () => number } | null = null;
const trackCache = new Map<string, ReturnType<typeof trackPitch>>();
const listeners = new Set<() => void>();
const changed = () => {
  rev++;
  listeners.forEach((l) => l());
};

const colorFor = (id: string) => {
  if (!colorOf.has(id)) {
    const used = new Set(colorOf.values());
    colorOf.set(id, COLORS.find((c) => !used.has(c)) ?? COLORS[colorOf.size % COLORS.length]);
  }
  return colorOf.get(id)!;
};
const takeColor = (k: number) => (k >= 0 && ids[k] ? colorFor(ids[k]) : '#666');

function stopPreview() {
  preview?.stop();
  preview = null;
}

/** Remonta o áudio final (com a afinação na melodia, se ligada). */
function rebuild() {
  stopPreview();
  final = null;
  if (!plan) return;
  let [L, R] = renderStitch(plan, takes, sr);
  if (tuneOut) [L, R] = tuneToMelody(L, R, plan, sr);
  const per = 256;
  const peaks = new Float32Array(Math.ceil(L.length / per));
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    for (let j = i * per; j < Math.min(L.length, (i + 1) * per); j++) m = Math.max(m, Math.abs(L[j]), Math.abs(R[j]));
    peaks[i] = m;
  }
  final = { L, R, peaks };
}

/** Analisa os takes e monta o plano da costura. */
async function analyze() {
  stopPreview();
  const p = state.project;
  const clips = ids.map((id) => p.clips.find((c) => c.id === id)).filter((c): c is Clip => !!c?.sample);
  ids = clips.map((c) => c.id);
  ids.forEach(colorFor);
  plan = null;
  final = null;
  takes = [];
  if (clips.length < 2) return changed();
  busy = `Analisando a afinação de ${clips.length} áudios…`;
  changed();
  try {
    const tps = ticksPerSec(p);
    const loaded = await Promise.all(clips.map((c) => loadAudio(c.sample!)));
    sr = loaded[0].sr;
    if (loaded.some((a) => a.sr !== sr)) throw new Error('os áudios têm taxas de amostragem diferentes');
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
    rebuild();
  } catch (e) {
    toast(`Stitcher: ${(e as Error).message}`);
  }
  busy = '';
  changed();
}

/** Adiciona áudios da playlist (por id de clipe). */
export function addStitchTakes(newIds: string[]) {
  const before = ids.length;
  ids = [...new Set([...ids, ...newIds])];
  if (ids.length !== before) analyze();
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

/** Toca o resultado a partir de t segundos (do começo da costura). */
function playFrom(t: number) {
  stopPreview();
  if (!final) return;
  preview = audio.playBuffer([final.L, final.R], sr, Math.max(0, Math.min(t, final.L.length / sr - 0.01)), () => {
    preview = null;
    listeners.forEach((l) => l());
  });
  listeners.forEach((l) => l());
}

export function StitchWindow() {
  const s = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [addMenu, setAddMenu] = useState<null | 'menu' | 'playlist'>(null);
  useEffect(() => {
    listeners.add(force as () => void);
    return () => void listeners.delete(force as () => void);
  }, []);
  // áudios apagados da playlist saem do Stitcher
  useEffect(() => {
    if (ids.some((id) => !s.project.clips.some((c) => c.id === id))) analyze();
  }, [s.version]);
  // fecha o menu de adicionar ao clicar fora
  useEffect(() => {
    if (addMenu !== 'menu') return;
    const close = () => setAddMenu(null);
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true }), 0);
    return () => window.removeEventListener('pointerdown', close);
  }, [addMenu]);
  const recording = audio.recording;
  const rec = () => {
    if (audio.recording) return toggleRecord();
    toggleRecord(null, { smart: true, onDone: addStitchTakes });
  };
  const fromPc = async () => {
    setAddMenu(null);
    const files = await pickAudioFiles(true);
    if (!files.length) return;
    try {
      importPaths(await uploadFiles(files));
    } catch (err) {
      toast(`Stitcher: ${(err as Error).message}`);
    }
  };
  const save = async () => {
    if (!plan || !final) return;
    const p = state.project;
    const tps = ticksPerSec(p);
    const tick = Math.round(plan.start * tps), len = Math.round((plan.end - plan.start) * tps);
    const lowest = Math.max(...ids.map((id) => p.clips.find((c) => c.id === id)?.track ?? 0));
    const first = p.clips.find((c) => c.id === ids[0]);
    try {
      const id = await saveAsClip(final.L, final.R, sr, 'Costura', { tick, track: trackBelow(p, lowest, tick, len), insert: first?.insert });
      if (id) toast('Costura salva na playlist, abaixo dos áudios usados');
    } catch (e) {
      toast(`Erro ao salvar a costura: ${(e as Error).message}`);
    }
  };
  const used = plan ? new Set(plan.segments.filter((x) => x.take >= 0).map((x) => x.take)) : new Set<number>();
  const remove = (id: string) => {
    ids = ids.filter((x) => x !== id);
    analyze();
  };
  const dur = plan ? plan.end - plan.start : 0;
  return (
    <Win id="stitch" title="Stitcher" icon="stitch" minW={680} minH={360}>
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
          <div class="st-add">
            <button class="st-add-btn" onClick={() => setAddMenu(addMenu ? null : 'menu')} data-hint="Adicionar áudios: do computador ou da playlist (também dá para arrastar um arquivo ou um clipe da playlist para esta janela)">
              <Icon name="plus" size={13} /> Adicionar áudio <Icon name="down" size={9} />
            </button>
            {addMenu === 'menu' && (
              <div class="st-pop" onPointerDown={(e) => e.stopPropagation()}>
                <button onClick={fromPc}>
                  <Icon name="folder" size={13} /> Do computador…
                </button>
                <button onClick={() => setAddMenu('playlist')}>
                  <Icon name="playlist" size={13} /> Da playlist…
                </button>
              </div>
            )}
            {addMenu === 'playlist' && <FromPlaylist onClose={() => setAddMenu(null)} />}
          </div>
          <button class={`amp-rec ${recording ? 'on' : ''}`} onClick={rec} data-hint="Grava (só quando você canta/toca); cada take entra aqui. Dica: ligue a região de loop e grave a mesma parte várias vezes">
            <Icon name="record" size={14} />
            {recording ? 'Parar' : 'Gravar'}
          </button>
          <span class="tool-sep" />
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
          <label class="tool-check" data-hint="Leva cada nota do resultado exatamente para a nota da melodia (mantém o vibrato)">
            <input
              type="checkbox"
              checked={tuneOut}
              onChange={() => {
                tuneOut = !tuneOut;
                setPref('stitch.tune', tuneOut);
                rebuild();
                changed();
              }}
            />
            Afinar na melodia
          </label>
          <button disabled={!plan} onClick={() => analyze()} data-hint="Refaz a melodia e a escolha dos pedaços do zero (desfaz edições)">
            Recomeçar
          </button>
          <button class="tool-main" disabled={!final} onClick={save} data-hint="Cria um clipe com o resultado na playlist (os áudios originais não mudam)">
            <Icon name="save" size={13} /> Salvar costura
          </button>
        </div>
        {busy ? (
          <div class="tool-empty">{busy}</div>
        ) : !plan ? (
          <div class="tool-empty">
            {ids.length === 1 ? 'Adicione pelo menos mais um áudio da mesma parte.' : 'Adicione dois ou mais áudios da mesma parte (do computador, da playlist ou gravando). Também dá para arrastar arquivos ou clipes da playlist para cá.'}
          </div>
        ) : (
          <div class="st-main">
            <div class="st-row st-final">
              <div class="st-label">
                <button class={`st-play ${preview ? 'on' : ''}`} onClick={() => (preview ? (stopPreview(), changed()) : playFrom(0))} data-hint="Tocar o resultado do começo (ou clique em qualquer ponto da onda)">
                  <Icon name={preview ? 'stop' : 'play'} size={14} />
                </button>
                <div>
                  <b>Resultado</b>
                  <small>
                    {dur.toFixed(1)} s · {used.size} de {takes.length} áudios usados
                  </small>
                </div>
              </div>
              <FinalCanvas />
            </div>
            <div class="st-row st-mel">
              <div class="st-label">
                <div>
                  <b>Melodia</b>
                  <small>{keyLabel(plan.key)} · arraste para corrigir</small>
                </div>
              </div>
              <MelodyCanvas />
            </div>
            <div class="st-list">
              {ids.map((id, k) => {
                const c = state.project.clips.find((x) => x.id === id);
                const cents = plan!.takeCents[k];
                const inUse = used.has(k);
                return (
                  <div class={`st-row st-take ${inUse ? 'used' : 'unused'}`} key={id}>
                    <div class="st-label">
                      <span class="st-swatch" style={{ background: colorFor(id) }} />
                      <div class="st-name">
                        <b>{c ? clipName(c) : '?'}</b>
                        <small>
                          {inUse ? `${plan!.segments.filter((x) => x.take === k).length} pedaços usados` : 'não usado'}
                          {cents !== null && (
                            <span class={`stitch-cents ${cents < 15 ? 'good' : cents < 35 ? 'mid' : 'bad'}`} data-hint="Distância média até a melodia">
                              {' '}
                              · ±{Math.round(cents)}c
                            </span>
                          )}
                        </small>
                      </div>
                      <button class="pedal-x" data-hint="Tirar este áudio do Stitcher (continua na playlist)" onClick={() => remove(id)}>
                        <Icon name="close" size={10} />
                      </button>
                    </div>
                    <TakeCanvas k={k} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Win>
  );
}

/** Lista de áudios da playlist para adicionar. */
function FromPlaylist(p: { onClose: () => void }) {
  const [pick, setPick] = useState<string[]>([]);
  const list = audioClips(state.project).filter((c) => !ids.includes(c.id)).sort((a, b) => a.pos - b.pos || a.track - b.track);
  useEffect(() => {
    const close = () => p.onClose();
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true }), 0);
    return () => window.removeEventListener('pointerdown', close);
  }, []);
  return (
    <div class="st-pop st-pick" onPointerDown={(e) => e.stopPropagation()}>
      <div class="st-pick-head">Áudios da playlist</div>
      {list.length === 0 && <div class="tool-empty small">Todos os áudios da playlist já estão aqui.</div>}
      <div class="st-pick-list">
        {list.map((c) => (
          <label class="stitch-take">
            <input type="checkbox" checked={pick.includes(c.id)} onChange={() => setPick(pick.includes(c.id) ? pick.filter((x) => x !== c.id) : [...pick, c.id])} />
            <span class="stitch-name">{clipName(c)}</span>
            <small class="dim">track {c.track + 1}</small>
          </label>
        ))}
      </div>
      <div class="st-pick-foot">
        {list.length > 1 && <button onClick={() => setPick(pick.length === list.length ? [] : list.map((c) => c.id))}>{pick.length === list.length ? 'Nenhum' : 'Todos'}</button>}
        <button
          class="on"
          disabled={!pick.length}
          onClick={() => {
            addStitchTakes(pick);
            p.onClose();
          }}
        >
          Adicionar {pick.length || ''}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- desenhos

/** Cursor de reprodução em todos os gráficos. */
function usePlayhead(paintOverlay: () => void) {
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      paintOverlay();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}
const drawHead = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
  if (!preview || !plan) return;
  const x = (preview.pos() / (plan.end - plan.start)) * w;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, 0, 1.5, h);
};
const segAt = (t: number) => (plan ? plan.segments.findIndex((sg) => t >= sg.t0 && t < sg.t1) : -1);
const localX = (e: MouseEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
};

/** Onda do resultado, com cada pedaço na cor do áudio de onde veio. */
function FinalCanvas() {
  const { ref, paintOverlay } = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = ui('#11161a');
      ctx.fillRect(0, 0, w, h);
      if (!plan || !final) return;
      const span = plan.end - plan.start;
      const mid = h / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, mid, w, 1);
      const per = final.peaks.length / w;
      for (const sg of plan.segments) {
        const x0 = ((sg.t0 - plan.start) / span) * w, x1 = ((sg.t1 - plan.start) / span) * w;
        const color = takeColor(sg.take);
        // fundo leve do pedaço + onda na cor do áudio
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.globalAlpha = 1;
        for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) {
          let pk = 0;
          for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) pk = Math.max(pk, final.peaks[i] ?? 0);
          const a = Math.min(1, pk * 1.6) * (mid - 3);
          ctx.fillRect(x, mid - a, 1, Math.max(1, a * 2));
        }
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(Math.round(x0), 0, 1, h);
      }
    },
    [rev],
    drawHead,
  );
  usePlayhead(paintOverlay);
  return (
    <canvas
      ref={ref}
      class="st-canvas"
      onPointerDown={(e) => {
        if (!plan) return;
        const { x, w } = localX(e as unknown as MouseEvent);
        playFrom((x / w) * (plan.end - plan.start));
      }}
      onPointerMove={(e) => {
        if (!plan) return;
        const { x, w } = localX(e as unknown as MouseEvent);
        const si = segAt(plan.start + (x / w) * (plan.end - plan.start));
        const sg = plan.segments[si];
        if (!sg) return;
        const c = state.project.clips.find((q) => q.id === ids[sg.take]);
        setHint(`${sg.target !== null ? noteName(sg.target) + ' · ' : ''}${c ? `vem de ${clipName(c)}` : 'silêncio'} · clique para tocar daqui`);
      }}
      style={{ cursor: 'pointer' }}
      data-hint="Resultado da costura: cada cor é o áudio de onde veio o pedaço. Clique para tocar a partir daí."
    />
  );
}

/** Melodia pretendida (arraste uma nota para corrigir). */
function MelodyCanvas() {
  const view = useRef({ lo: 55, hi: 72 });
  const drag = useRef<{ si: number; y0: number; orig: number } | null>(null);
  const row = (h: number) => (h - 6) / Math.max(1, view.current.hi - view.current.lo);
  const yOf = (m: number, h: number) => 3 + (view.current.hi - m) * row(h);
  const { ref, paint, paintOverlay } = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = ui('#14191b');
      ctx.fillRect(0, 0, w, h);
      if (!plan) return;
      const span = plan.end - plan.start;
      const targets = plan.segments.map((s) => s.target).filter((t): t is number => t !== null);
      if (!drag.current && targets.length) {
        view.current.lo = Math.min(...targets) - 2;
        view.current.hi = Math.max(...targets) + 2;
      }
      const rh = row(h);
      for (let m = Math.ceil(view.current.lo); m <= view.current.hi; m++) {
        ctx.fillStyle = m % 12 === 0 ? ui('#2f383d') : ui('#1c2326');
        ctx.fillRect(0, yOf(m, h), w, 1);
      }
      for (const sg of plan.segments) {
        if (sg.target === null) continue;
        const x0 = ((sg.t0 - plan.start) / span) * w, x1 = ((sg.t1 - plan.start) / span) * w;
        const sung = sg.take >= 0 ? sg.sung[sg.take] : null;
        if (sung !== null) {
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.fillRect(x0 + 2, yOf(sung, h) - 1, Math.max(2, x1 - x0 - 4), 2);
        }
        const bh = Math.max(7, rh * 0.8);
        const y = yOf(sg.target, h) - bh / 2;
        ctx.fillStyle = takeColor(sg.take);
        ctx.fillRect(x0 + 1, y, Math.max(3, x1 - x0 - 2), bh);
        if (x1 - x0 > 24) {
          ctx.fillStyle = '#111';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText(noteName(sg.target), x0 + 4, y + bh - 2);
        }
      }
    },
    [rev],
    drawHead,
  );
  usePlayhead(paintOverlay);
  return (
    <canvas
      ref={ref}
      class="st-canvas"
      onPointerDown={(e) => {
        if (!plan) return;
        const { x, y, w } = localX(e as unknown as MouseEvent);
        const si = segAt(plan.start + (x / w) * (plan.end - plan.start));
        const sg = plan.segments[si];
        if (!sg || sg.target === null) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { si, y0: y, orig: sg.target };
      }}
      onPointerMove={(e) => {
        if (!plan) return;
        const { x, y, w, h } = localX(e as unknown as MouseEvent);
        const d = drag.current;
        if (d) {
          const sg = plan.segments[d.si];
          const raw = d.orig - (y - d.y0) / row(h);
          // grade do tom; Ctrl: qualquer semitom
          sg.target = e.ctrlKey || plan.key.scale === 'chromatic' ? Math.round(raw) : snapToKey(raw, plan.key);
          setHint(`Nota ${d.si + 1}: era para ser ${noteName(sg.target)} (Ctrl: qualquer semitom)`);
          paint();
          return;
        }
        const sg = plan.segments[segAt(plan.start + (x / w) * (plan.end - plan.start))];
        if (!sg || sg.target === null) return;
        const sung = sg.take >= 0 ? sg.sung[sg.take] : null;
        setHint(`Nota pretendida: ${noteName(sg.target)}${sung !== null ? ` · cantado: ${noteName(Math.round(sung))} ${Math.round((sung - Math.round(sung)) * 100)}c` : ''} · arraste para corrigir`);
      }}
      onPointerUp={() => {
        if (!drag.current || !plan) return;
        drag.current = null;
        // a melodia mudou: escolhe de novo o áudio mais perto em cada nota
        rescore(plan, takes, sr);
        rebuild();
        changed();
      }}
      style={{ cursor: 'ns-resize' }}
      data-hint="Melodia: a nota que se queria cantar em cada trecho. Arraste uma nota para cima/baixo para corrigir."
    />
  );
}

/** Onda de um áudio da lista, com os pedaços usados destacados na cor dele. */
function TakeCanvas(p: { k: number }) {
  const { ref, paintOverlay } = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = ui('#181d20');
      ctx.fillRect(0, 0, w, h);
      if (!plan) return;
      const tk = takes[p.k];
      if (!tk) return;
      const span = plan.end - plan.start;
      const color = takeColor(p.k);
      for (const sg of plan.segments) {
        if (sg.take !== p.k) continue;
        const x0 = ((sg.t0 - plan.start) / span) * w, x1 = ((sg.t1 - plan.start) / span) * w;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.18;
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.globalAlpha = 1;
        ctx.fillRect(x0, h - 3, x1 - x0, 3);
      }
      const ch = tk.ch[0];
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const t = plan.start + (x / w) * span;
        const a0 = Math.floor((t - tk.offset) * sr), a1 = Math.floor((t + span / w - tk.offset) * sr);
        if (a1 < tk.from * sr || a0 > tk.to * sr) continue;
        const si = segAt(t);
        let pk = 0;
        for (let i = Math.max(0, a0); i < Math.min(ch.length, a1); i += 3) pk = Math.max(pk, Math.abs(ch[i]));
        // o que entra no resultado fica na cor do áudio; o resto, apagado
        ctx.fillStyle = si >= 0 && plan.segments[si].take === p.k ? color : 'rgba(150,160,165,0.35)';
        const a = Math.min(1, pk * 1.6) * (mid - 3);
        ctx.fillRect(x, mid - a, 1, Math.max(1, a * 2));
      }
      ctx.font = '9px sans-serif';
      for (const sg of plan.segments) {
        const c = sg.cents[p.k];
        const sw = ((sg.t1 - sg.t0) / span) * w;
        if (c === null || c === undefined || sw < 26) continue;
        ctx.fillStyle = c < 15 ? '#8ae8a4' : c < 35 ? '#e8c547' : '#ff8a8a';
        ctx.fillText(`${Math.round(c)}c`, ((sg.t0 - plan.start) / span) * w + 3, 10);
      }
    },
    [rev, p.k],
    drawHead,
  );
  usePlayhead(paintOverlay);
  return (
    <canvas
      ref={ref}
      class="st-canvas"
      onPointerDown={(e) => {
        if (!plan) return;
        const { x, w } = localX(e as unknown as MouseEvent);
        const sg = plan.segments[segAt(plan.start + (x / w) * (plan.end - plan.start))];
        if (!sg) return;
        if (sg.cents[p.k] === null || sg.cents[p.k] === undefined) return toast('Este áudio não canta/toca nessa nota');
        sg.take = p.k; // troca manual
        rebuild();
        changed();
      }}
      onPointerMove={(e) => {
        if (!plan) return;
        const { x, w } = localX(e as unknown as MouseEvent);
        const sg = plan.segments[segAt(plan.start + (x / w) * (plan.end - plan.start))];
        if (!sg) return;
        const c = sg.cents[p.k];
        setHint(c === null || c === undefined ? 'Sem som nesta nota' : `${Math.round(c)} cents da nota pretendida (${noteName(sg.target ?? 60)}) · clique para usar este áudio aqui`);
      }}
      style={{ cursor: 'pointer' }}
      data-hint="Clique num trecho para usar este áudio nele"
    />
  );
}
