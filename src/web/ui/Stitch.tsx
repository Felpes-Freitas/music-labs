// Stitcher: junta várias gravações da mesma parte numa só, usando em cada trecho
// o áudio que chegou mais perto da nota que se queria cantar. Tudo acontece aqui
// dentro: grave (a música não toca), importe ou puxe áudios da lista do projeto.
//
// Em cima fica o resultado (a onda final, cada pedaço pintado com a cor do áudio
// de onde veio; clique para tocar dali), logo abaixo a melodia (arraste uma nota
// para corrigir) e embaixo a lista dos áudios, cada um com a sua cor.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { useApp, state, toast, setHint, edit } from '../state';
import { set } from '../../core/ops';
import type { StitchSession } from '../../core/model';
import { audio } from '../audio';
import { noteName } from '../../core/model';
import { planStitch, renderStitch, rescore, tuneToMelody, restoreSegments, type StitchPlan, type StitchTake, type StitchSegment } from '../../core/stitch';
import { trackPitch } from '../../core/pitchtrack';
import { alignOffset } from '../../core/align';
import { snapToKey, keyLabel, type Key } from '../../core/key';
import { Win, useCanvas, MenuTree, type MenuItem } from './widgets';
import { openTuneAudio } from './Tune';
import { Icon } from './icons';
import { ui } from '../theme';
import { loadAudio, audioClips, pickAudioFiles, droppedAudio, acceptsAudio } from '../clipaudio';
import { KeyPicker } from './KeyPicker';
import { getPref, setPref } from '../prefs';
import { poolItems, poolItem, addToPool, saveWav, sendToPlaylist, startToolRecording, finishToolRecording, importToPool } from '../pool';
import { LiveCapture } from './LiveCapture';

const COLORS = ['#ff5d5d', '#4fc3e8', '#f2c94c', '#6fdc8c', '#b58cf0', '#ff9e57', '#5fd3c4', '#ff7bc0', '#9ccc3a', '#7ba6ff', '#e8a87c', '#c0c0c0'];

/** Áudios (da lista do projeto) que estão no Stitcher. */
/** Trecho de um áudio aberto no Afinador: um áudio da lista que substitui o pedaço (o take não muda). */
interface PieceRef {
  id: string; // áudio da lista
  start: number; // tempo (s, na costura) da amostra 0 do trecho
  off?: boolean; // edição desativada: usa o take como estava
}
type Seg = StitchSegment & { piece?: PieceRef };
const pieceAudio = new Map<string, { path: string; ch: Float32Array[] }>();

let ids: string[] = [];
/** Cor fixa de cada áudio (não muda quando outros entram ou saem). */
const colorOf = new Map<string, string>();
let plan: StitchPlan | null = null;
let takes: StitchTake[] = [];
let sr = 48000;
let busy = '';
let key: Key | null = null;
let tuneOut = getPref('stitch.tune', true);
let recording = false;
/** Resultado salvo na lista (some quando a costura muda). */
let savedId: string | null = null;
/** Áudio final já montado (refeito quando a costura muda). */
let final: { L: Float32Array; R: Float32Array; peaks: Float32Array } | null = null;
let rev = 0;
let preview: { stop: () => void; pos: () => number } | null = null;
const trackCache = new Map<string, ReturnType<typeof trackPitch>>();
const listeners = new Set<() => void>();
const changed = () => {
  rev++;
  listeners.forEach((l) => l());
  persist();
};

// ---------------------------------------------------------------- sessão guardada no projeto

/** Última sessão escrita no projeto (ou lida dele), em JSON. */
let savedJson = '';
/** Sessão a reaplicar quando a análise terminar (projeto aberto, desfazer). */
let pending: StitchSession | null = null;
/** Lista de áudios a que o plano atual corresponde. */
let planIds = '';
let persistTimer = 0;

function sessionNow(): StitchSession | null {
  if (!ids.length) return null;
  return {
    ids: [...ids],
    key,
    tune: tuneOut,
    segments: plan && planIds === ids.join()
      ? (plan.segments as Seg[]).map((sg) => ({
          t0: +sg.t0.toFixed(4),
          t1: +sg.t1.toFixed(4),
          take: sg.take,
          target: sg.target,
          ...(sg.manual ? { manual: true } : {}),
          ...(sg.piece ? { piece: { ...sg.piece } } : {}),
        }))
      : [],
  };
}

/** Escreve a sessão no projeto (com um pequeno atraso, só quando muda). */
function persist() {
  if (busy || pending) return;
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    if (busy || pending) return;
    const ses = sessionNow();
    const json = JSON.stringify(ses);
    if (json === savedJson) return;
    savedJson = json;
    edit([set(['stitch'], ses)], 'Stitcher');
  }, 350);
}

/** O projeto trouxe outra sessão (abriu um projeto, desfez/refez): carrega. */
function adopt(ses: StitchSession | null | undefined) {
  const json = JSON.stringify(ses ?? null);
  if (json === savedJson) return;
  savedJson = json;
  stopPreview();
  if (!ses) {
    ids = [];
    plan = null;
    takes = [];
    final = null;
    pending = null;
    listeners.forEach((l) => l());
    return;
  }
  ids = ses.ids.filter((id) => !!poolItem(id));
  key = ses.key;
  tuneOut = ses.tune;
  pending = ses;
  analyze();
}

const colorFor = (id: string) => {
  if (!colorOf.has(id)) {
    const used = new Set(colorOf.values());
    colorOf.set(id, COLORS.find((c) => !used.has(c)) ?? COLORS[colorOf.size % COLORS.length]);
  }
  return colorOf.get(id)!;
};
const takeColor = (k: number) => (k >= 0 && ids[k] ? colorFor(ids[k]) : '#666');
const nameOf = (k: number) => poolItem(ids[k])?.name ?? '?';

function stopPreview() {
  preview?.stop();
  preview = null;
}

/** Remonta o áudio final (com a afinação na melodia, se ligada). */
function rebuild() {
  stopPreview();
  final = null;
  savedId = null;
  if (!plan) return;
  // pedaços editados no Afinador entram como fontes extras, sem afinação automática
  const extra: StitchTake[] = [];
  const segs = (plan.segments as Seg[]).map((sg) => {
    const pa = sg.piece && !sg.piece.off ? pieceAudio.get(sg.piece.id) : undefined;
    if (!pa) return sg;
    extra.push({ offset: sg.piece!.start, from: 0, to: pa.ch[0].length / sr, ch: pa.ch });
    return { ...sg, src: takes.length + extra.length - 1, noTune: true };
  });
  const rp = { ...plan, segments: segs };
  let [L, R] = renderStitch(rp, [...takes, ...extra], sr);
  if (tuneOut) [L, R] = tuneToMelody(L, R, rp, sr);
  const per = 256;
  const peaks = new Float32Array(Math.ceil(L.length / per));
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    for (let j = i * per; j < Math.min(L.length, (i + 1) * per); j++) m = Math.max(m, Math.abs(L[j]), Math.abs(R[j]));
    peaks[i] = m;
  }
  final = { L, R, peaks };
}

const mono = (ch: Float32Array[]) => {
  const m = new Float32Array(ch[0].length);
  for (const c of ch) for (let i = 0; i < m.length; i++) m[i] += c[i] / ch.length;
  return m;
};

/** Analisa os áudios e monta o plano da costura (os áudios são alinhados ao primeiro). */
let gen = 0;
async function analyze() {
  const my = ++gen;
  stopPreview();
  ids = ids.filter((id) => !!poolItem(id));
  ids.forEach(colorFor);
  plan = null;
  final = null;
  savedId = null;
  takes = [];
  if (ids.length < 2) {
    pending = null;
    return changed();
  }
  busy = `Analisando a afinação de ${ids.length} áudios…`;
  changed();
  try {
    const items = ids.map((id) => poolItem(id)!);
    const loaded = await Promise.all(items.map((it) => loadAudio(it.path)));
    if (my !== gen) return; // outra análise começou depois desta
    sr = loaded[0].sr;
    if (loaded.some((a) => a.sr !== sr)) throw new Error('os áudios têm taxas de amostragem diferentes');
    await new Promise((r) => setTimeout(r, 0));
    if (my !== gen) return;
    const ref = mono(loaded[0].ch);
    takes = items.map((it, k) => {
      const a = loaded[k];
      const m = k === 0 ? ref : mono(a.ch);
      let tr = trackCache.get(it.path);
      if (!tr) {
        tr = trackPitch(m, sr);
        trackCache.set(it.path, tr);
      }
      // gravações da mesma parte começam em momentos diferentes do arquivo: alinha pelo contorno de volume
      const offset = k === 0 ? 0 : -alignOffset(ref, m, sr);
      return { offset, from: 0, to: a.ch[0].length / sr, ch: a.ch, track: tr };
    });
    if (my !== gen) return; // outra análise começou depois desta
    plan = planStitch(takes, sr, key, false);
    planIds = ids.join();
    // sessão guardada: os mesmos áudios, na mesma ordem → volta cortes, escolhas e pedaços
    const ses = pending;
    pending = null;
    if (ses && ses.ids.join() === ids.join() && ses.segments.length) {
      restoreSegments(plan, takes, sr, ses.segments);
      ses.segments.forEach((sv, i) => {
        if (sv.piece && poolItem(sv.piece.id)) (plan!.segments[i] as Seg).piece = { ...sv.piece };
      });
      await loadPieces();
      if (my !== gen) return;
      rebuild();
      busy = '';
      savedJson = JSON.stringify(sessionNow()); // é o que já está no projeto
      changed();
      return;
    }
    rebuild();
  } catch (e) {
    toast(`Stitcher: ${(e as Error).message}`);
  }
  busy = '';
  changed();
}

/** Adiciona áudios da lista do projeto. */
export function addStitchAudios(newIds: string[]) {
  // a análise roda pelo efeito que observa a lista (StitchWindow)
  ids = [...new Set([...ids, ...newIds])];
  changed();
}
/** Adiciona os arquivos de clipes da playlist (entram na lista de áudios). */
export function addStitchTakes(clipIds: string[]) {
  const paths = clipIds.map((id) => state.project.clips.find((c) => c.id === id)?.sample).filter((x): x is string => !!x);
  addStitchAudios(paths.map((p) => addToPool(p)));
}

/** Tocar/parar o resultado (o Espaço chama isto quando a janela está em foco). */
export function toggleStitchPreview() {
  if (preview) return stopPreview(), changed();
  playFrom(0);
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

async function toggleRec() {
  if (recording) {
    recording = false;
    changed();
    try {
      const id = await finishToolRecording('Take');
      if (id) addStitchAudios([id]);
      else toast('Gravação curta demais');
    } catch (e) {
      toast(`Erro ao salvar a gravação: ${(e as Error).message}`);
    }
    return;
  }
  stopPreview();
  try {
    await startToolRecording();
    recording = true;
  } catch (e) {
    toast(`Não consegui acessar o microfone: ${(e as Error).message}`);
  }
  changed();
}

/** Recorta o pedaço do take, põe na lista de áudios e abre no Afinador (as edições voltam para cá). */
async function openPiece(si: number) {
  if (!plan) return;
  const sg = plan.segments[si] as Seg;
  if (sg.piece && poolItem(sg.piece.id)) return openTuneAudio(sg.piece.id, { inPlace: true });
  if (sg.take < 0) return toast('Este pedaço é silêncio');
  const tk = takes[sg.take];
  const t0 = Math.max(tk.offset + tk.from, sg.t0 - 0.05), t1 = Math.min(tk.offset + tk.to, sg.t1 + 0.05);
  const a = Math.max(0, Math.round((t0 - tk.offset) * sr)), b = Math.min(tk.ch[0].length, Math.round((t1 - tk.offset) * sr));
  if (b - a < sr * 0.05) return toast('Pedaço curto demais');
  const L = tk.ch[0].slice(a, b), R = (tk.ch[1] ?? tk.ch[0]).slice(a, b);
  try {
    const name = `${nameOf(sg.take)} · trecho ${si + 1}`;
    const path = await saveWav(L, R, sr, name);
    const id = addToPool(path, name, ids[sg.take]);
    sg.piece = { id, start: tk.offset + a / sr };
    pieceAudio.set(id, { path, ch: [L, R] });
    changed();
    openTuneAudio(id, { inPlace: true });
  } catch (e) {
    toast(`Erro: ${(e as Error).message}`);
  }
}

/** Carrega o áudio atual de cada trecho editado (true se algum mudou). */
async function loadPieces() {
  if (!plan) return false;
  let dirty = false;
  for (const sg of plan.segments as Seg[]) {
    if (!sg.piece) continue;
    const it = poolItem(sg.piece.id);
    if (!it) {
      delete sg.piece;
      dirty = true;
      continue;
    }
    if (pieceAudio.get(it.id)?.path === it.path) continue;
    const a = await loadAudio(it.path);
    pieceAudio.set(it.id, { path: it.path, ch: a.ch });
    dirty = true;
  }
  return dirty;
}

/** Recarrega os trechos que mudaram no Afinador e remonta a costura. */
async function refreshPieces() {
  if (!plan) return;
  let dirty = false;
  for (const sg of plan.segments as Seg[]) {
    if (!sg.piece) continue;
    const it = poolItem(sg.piece.id);
    if (!it) {
      delete sg.piece;
      dirty = true;
      continue;
    }
    if (pieceAudio.get(it.id)?.path === it.path) continue;
    const a = await loadAudio(it.path);
    pieceAudio.set(it.id, { path: it.path, ch: a.ch });
    dirty = true;
  }
  if (dirty) {
    rebuild();
    changed();
  }
}

/** Salva o resultado na lista de áudios (uma vez por versão da costura). */
async function saveResult() {
  if (!final) return null;
  if (savedId && poolItem(savedId)) return savedId;
  const n = poolItems().filter((a) => a.name.startsWith('Costura')).length + 1;
  const name = `Costura ${n}`;
  const path = await saveWav(final.L, final.R, sr, name);
  savedId = addToPool(path, name);
  return savedId;
}

export function StitchWindow() {
  const s = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [addMenu, setAddMenu] = useState<null | 'menu' | 'list'>(null);
  useEffect(() => {
    listeners.add(force as () => void);
    return () => void listeners.delete(force as () => void);
  }, []);
  // áudios apagados da lista saem do Stitcher; áudios trocados (editados) são reanalisados
  // projeto aberto / desfazer: a sessão guardada manda
  const open = s.windows.stitch.open;
  useEffect(() => {
    if (open) adopt(s.project.stitch);
  }, [JSON.stringify(s.project.stitch ?? null), open]);
  const sig = ids.map((id) => poolItem(id)?.path ?? '-').join('|');
  useEffect(() => {
    analyze();
  }, [sig]);
  // trechos editados no Afinador: quando mudam, a costura se refaz
  const pieceSig = plan ? (plan.segments as Seg[]).filter((x) => x.piece).map((x) => `${x.piece!.id}:${poolItem(x.piece!.id)?.path ?? '-'}`).join('|') : '';
  useEffect(() => {
    refreshPieces();
  }, [pieceSig]);
  // fecha o menu de adicionar ao clicar fora
  useEffect(() => {
    if (addMenu !== 'menu') return;
    const close = () => setAddMenu(null);
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true }), 0);
    return () => window.removeEventListener('pointerdown', close);
  }, [addMenu]);
  void s;
  const fromPc = async () => {
    setAddMenu(null);
    const files = await pickAudioFiles(true);
    if (!files.length) return;
    busy = `Importando ${files.length} ${files.length > 1 ? 'áudios' : 'áudio'}…`;
    changed();
    try {
      addStitchAudios(await importToPool(files));
    } catch (err) {
      busy = '';
      changed();
      toast(`Stitcher: ${(err as Error).message}`);
    }
  };
  const save = async () => {
    try {
      if (await saveResult()) toast('Resultado salvo na lista de áudios');
    } catch (e) {
      toast(`Erro ao salvar: ${(e as Error).message}`);
    }
  };
  const send = async () => {
    try {
      const id = await saveResult();
      if (id) await sendToPlaylist(id);
    } catch (e) {
      toast(`Erro: ${(e as Error).message}`);
    }
  };
  const used = plan ? new Set(plan.segments.filter((x) => x.take >= 0).map((x) => x.take)) : new Set<number>();
  const remove = (id: string) => {
    ids = ids.filter((x) => x !== id);
    changed();
  };
  const dur = plan ? plan.end - plan.start : 0;
  return (
    <Win id="stitch" title="Stitcher" icon="stitch" minW={680} minH={360}>
      <div
        class={`tool ${recording ? 'recording' : ''}`}
        onDragOver={(e) => acceptsAudio(e) && (e.preventDefault(), (e.currentTarget as HTMLElement).classList.add('dropping'))}
        onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('dropping')}
        onDrop={async (e) => {
          (e.currentTarget as HTMLElement).classList.remove('dropping');
          if (!acceptsAudio(e)) return;
          e.preventDefault();
          e.stopPropagation();
          try {
            addStitchAudios((await droppedAudio(e)).map((p) => addToPool(p)));
          } catch (err) {
            toast(`Stitcher: ${(err as Error).message}`);
          }
        }}
      >
        <div class="tool-bar">
          <div class="st-add">
            <button class="st-add-btn" disabled={recording} onClick={() => setAddMenu(addMenu ? null : 'menu')} data-hint="Adicionar áudios: do computador ou da lista do projeto/playlist (também dá para arrastar arquivos ou clipes da playlist para esta janela)">
              <Icon name="plus" size={13} /> Adicionar áudio <Icon name="down" size={9} />
            </button>
            {addMenu === 'menu' && (
              <div class="st-pop" onPointerDown={(e) => e.stopPropagation()}>
                <button onClick={fromPc}>
                  <Icon name="folder" size={13} /> Do computador…
                </button>
                <button onClick={() => setAddMenu('list')}>
                  <Icon name="playlist" size={13} /> Do projeto (lista e playlist)…
                </button>
              </div>
            )}
            {addMenu === 'list' && <FromProject onClose={() => setAddMenu(null)} />}
          </div>
          <button class={`amp-rec ${recording ? 'on' : ''}`} onClick={toggleRec} data-hint="Grava aqui dentro (a música não toca); a gravação aparece ao vivo na lista e entra na costura ao parar">
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
          <span class="tool-grow" />
          <button disabled={!final} onClick={save} data-hint="Guarda o resultado na lista de áudios do projeto">
            <Icon name="save" size={13} /> Salvar na lista
          </button>
          <button class="tool-main" disabled={!final} onClick={send} data-hint="Guarda o resultado na lista e coloca na playlist">
            <Icon name="playlist" size={13} /> Enviar para a playlist
          </button>
        </div>
        {busy ? (
          <div class="tool-empty">{busy}</div>
        ) : !plan && !recording ? (
          <div class="tool-empty">
            {ids.length === 1 ? 'Adicione ou grave pelo menos mais um áudio da mesma parte.' : 'Grave aqui, adicione áudios do computador ou do projeto, ou arraste arquivos e clipes da playlist para cá (dois ou mais da mesma parte).'}
          </div>
        ) : (
          <div class="st-main">
            {plan && (
              <>
                <div class="st-row st-final">
                  <div class="st-label">
                    <button class={`st-play ${preview ? 'on' : ''}`} onClick={toggleStitchPreview} data-hint="Tocar o resultado (Espaço) — ou clique em qualquer ponto da onda">
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
              </>
            )}
            <div class="st-list">
              {plan &&
                ids.map((id, k) => {
                  const cents = plan!.takeCents[k];
                  const inUse = used.has(k);
                  return (
                    <div class={`st-row st-take ${inUse ? 'used' : 'unused'}`} key={id}>
                      <div class="st-label">
                        <span class="st-swatch" style={{ background: colorFor(id) }} />
                        <div class="st-name">
                          <b>{nameOf(k)}</b>
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
                        <button class="pedal-x" data-hint="Tirar este áudio do Stitcher (continua na lista do projeto)" onClick={() => remove(id)}>
                          <Icon name="close" size={10} />
                        </button>
                      </div>
                      <TakeCanvas k={k} />
                    </div>
                  );
                })}
              {!plan &&
                ids.map((id) => (
                  <div class="st-row st-take" key={id}>
                    <div class="st-label">
                      <span class="st-swatch" style={{ background: colorFor(id) }} />
                      <div class="st-name">
                        <b>{poolItem(id)?.name}</b>
                        <small>esperando mais áudios</small>
                      </div>
                    </div>
                    <div class="st-canvas" />
                  </div>
                ))}
              {recording && (
                <div class="st-row st-take st-rec">
                  <div class="st-label">
                    <span class="st-swatch rec" />
                    <div class="st-name">
                      <b>Gravando…</b>
                      <small>ao parar, entra na costura</small>
                    </div>
                  </div>
                  <LiveCapture label="Gravando" compact />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Win>
  );
}

/** Áudios do projeto (lista de áudios e clipes da playlist) para adicionar. */
function FromProject(p: { onClose: () => void }) {
  const [pick, setPick] = useState<string[]>([]);
  // itens da lista + arquivos de clipes da playlist que ainda não estão na lista
  const opts: { key: string; name: string; sub: string; pool?: string; path?: string }[] = [];
  for (const a of poolItems()) if (!ids.includes(a.id)) opts.push({ key: a.id, name: a.name, sub: 'lista de áudios', pool: a.id });
  const seen = new Set(poolItems().flatMap((a) => [a.path, a.original]));
  for (const c of audioClips(state.project))
    if (c.sample && !seen.has(c.sample)) {
      seen.add(c.sample);
      opts.push({ key: c.sample, name: (c.sample.split(/[\\/]/).pop() ?? '').replace(/\.[a-z0-9]{2,5}$/i, ''), sub: `playlist · track ${c.track + 1}`, path: c.sample });
    }
  useEffect(() => {
    const close = () => p.onClose();
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true }), 0);
    return () => window.removeEventListener('pointerdown', close);
  }, []);
  return (
    <div class="st-pop st-pick" onPointerDown={(e) => e.stopPropagation()}>
      <div class="st-pick-head">Áudios do projeto</div>
      {opts.length === 0 && <div class="tool-empty small">Nenhum outro áudio no projeto.</div>}
      <div class="st-pick-list">
        {opts.map((o) => (
          <label class="stitch-take">
            <input type="checkbox" checked={pick.includes(o.key)} onChange={() => setPick(pick.includes(o.key) ? pick.filter((x) => x !== o.key) : [...pick, o.key])} />
            <span class="stitch-name">{o.name}</span>
            <small class="dim">{o.sub}</small>
          </label>
        ))}
      </div>
      <div class="st-pick-foot">
        {opts.length > 1 && <button onClick={() => setPick(pick.length === opts.length ? [] : opts.map((o) => o.key))}>{pick.length === opts.length ? 'Nenhum' : 'Todos'}</button>}
        <button
          class="on"
          disabled={!pick.length}
          onClick={() => {
            addStitchAudios(opts.filter((o) => pick.includes(o.key)).map((o) => o.pool ?? addToPool(o.path!)));
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
  const [menu, setMenu] = useState<{ x: number; y: number; si: number; t: number } | null>(null);
  const drag = useRef<{ i: number; lo: number; hi: number } | null>(null);
  const { ref, paint, paintOverlay } = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = ui('#11161a');
      ctx.fillRect(0, 0, w, h);
      if (!plan || !final) return;
      const span = plan.end - plan.start;
      const mid = h / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, mid, w, 1);
      const per = final.peaks.length / w;
      for (const sg of plan.segments as Seg[]) {
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
        // pedaço editado no Afinador: selo; escolhido à mão: traço em cima
        if (sg.piece && x1 - x0 > 16) {
          ctx.fillStyle = sg.piece.off ? 'rgba(255,255,255,0.4)' : '#fff';
          ctx.font = 'bold 10px sans-serif';
          ctx.fillText(sg.piece.off ? '✎ off' : '✎', x0 + 4, 12);
        }
        if (sg.manual) {
          ctx.fillStyle = color;
          ctx.fillRect(x0, 0, x1 - x0, 3);
        }
        // divisa entre pedaços (arrastável)
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(Math.round(x0), 0, 1, h);
        ctx.fillRect(Math.round(x0) - 2, mid - 6, 5, 12);
      }
    },
    [rev],
    drawHead,
  );
  usePlayhead(paintOverlay);
  const xOfT = (t: number, w: number) => ((t - plan!.start) / (plan!.end - plan!.start)) * w;
  /** Divisa perto do ponteiro (índice do pedaço que começa nela). */
  const boundaryAt = (x: number, w: number) => {
    if (!plan) return -1;
    for (let i = 1; i < plan.segments.length; i++) if (Math.abs(xOfT(plan.segments[i].t0, w) - x) < 5) return i;
    return -1;
  };
  return (
    <>
      <canvas
        ref={ref}
        class="st-canvas"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (!plan) return;
          const { x, w } = localX(e as unknown as MouseEvent);
          const t = plan.start + (x / w) * (plan.end - plan.start);
          if (e.button === 2) {
            const si = segAt(t);
            if (si >= 0) setMenu({ x: e.clientX, y: e.clientY, si, t });
            return;
          }
          const b = boundaryAt(x, w);
          if (b > 0) {
            // arrastar a divisa: muda onde um pedaço termina e o próximo começa
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            drag.current = { i: b, lo: plan.segments[b - 1].t0 + 0.04, hi: plan.segments[b].t1 - 0.04 };
            stopPreview();
            return;
          }
          playFrom(t - plan.start);
        }}
        onPointerMove={(e) => {
          if (!plan) return;
          const { x, w } = localX(e as unknown as MouseEvent);
          const t = plan.start + (x / w) * (plan.end - plan.start);
          const d = drag.current;
          if (d) {
            const nt = Math.max(d.lo, Math.min(d.hi, t));
            plan.segments[d.i - 1].t1 = nt;
            plan.segments[d.i].t0 = nt;
            setHint(`Corte em ${(nt - plan.start).toFixed(2)} s`);
            paint();
            return;
          }
          (e.currentTarget as HTMLElement).style.cursor = boundaryAt(x, w) > 0 ? 'ew-resize' : 'pointer';
          const sg = plan.segments[segAt(t)] as Seg | undefined;
          if (!sg) return;
          setHint(`${sg.target !== null ? noteName(sg.target) + ' · ' : ''}${sg.take >= 0 ? `vem de ${nameOf(sg.take)}` : 'silêncio'}${sg.piece ? ' · editado no Afinador' : ''} · clique toca daqui · arraste as divisas para mudar os cortes · botão direito: opções`);
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          rebuild();
          changed();
        }}
        data-hint="Resultado: cada cor é o áudio de onde veio o pedaço. Clique para tocar dali; arraste as divisas para mudar os cortes; botão direito num pedaço para trocar o áudio, dividir ou abrir no Afinador."
      />
      {menu && plan && <PieceMenu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
}

/** Menu do botão direito num pedaço do resultado. */
function PieceMenu(p: { x: number; y: number; si: number; t: number; onClose: () => void }) {
  const pl = plan!;
  const sg = pl.segments[p.si] as Seg;
  const done = () => {
    rebuild();
    changed();
  };
  const items: MenuItem[] = [
    {
      label: 'Usar o áudio',
      sub: ids.map((id, k) => ({
        label: `${nameOf(k)}${sg.cents[k] !== null && sg.cents[k] !== undefined ? ` · ${Math.round(sg.cents[k]!)}c` : ' · sem som aqui'}`,
        swatch: colorFor(id),
        run: () => {
          sg.take = k;
          sg.manual = true;
          delete sg.piece; // o trecho editado era do outro áudio
          done();
        },
      })),
    },
    {
      label: 'Dividir aqui',
      hint: 'Corta este pedaço em dois neste ponto (cada metade pode usar outro áudio)',
      run: () => {
        if (p.t - sg.t0 < 0.05 || sg.t1 - p.t < 0.05) return;
        const b: Seg = { ...sg, t0: p.t, cents: [...sg.cents], sung: [...sg.sung] };
        delete b.piece;
        sg.t1 = p.t;
        delete sg.piece;
        pl.segments.splice(p.si + 1, 0, b);
        done();
      },
    },
    ...(p.si + 1 < pl.segments.length
      ? [
          {
            label: 'Juntar com o próximo',
            hint: 'Tira o corte entre este pedaço e o seguinte (fica o áudio deste)',
            run: () => {
              sg.t1 = pl.segments[p.si + 1].t1;
              delete sg.piece;
              pl.segments.splice(p.si + 1, 1);
              done();
            },
          },
        ]
      : []),
    { sep: true, label: '' },
    {
      label: sg.piece ? 'Abrir este pedaço no Afinador de novo' : 'Abrir este pedaço no Afinador',
      hint: 'Abre só este trecho no Afinador; o que você aplicar lá volta para cá (o áudio original não muda)',
      run: () => openPiece(p.si),
    },
    ...(sg.piece
      ? [
          {
            label: sg.piece.off ? 'Reativar a edição do Afinador neste pedaço' : 'Desativar a edição do Afinador neste pedaço',
            run: () => {
              sg.piece!.off = !sg.piece!.off;
              done();
            },
          },
        ]
      : []),
    ...(sg.manual
      ? [
          {
            label: 'Voltar à escolha automática neste pedaço',
            run: () => {
              sg.manual = false;
              rescore(pl, takes, sr);
              done();
            },
          },
        ]
      : []),
  ];
  return <MenuTree x={p.x} y={p.y} items={items} onClose={p.onClose} />;
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
        sg.manual = true;
        delete (sg as Seg).piece;
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
