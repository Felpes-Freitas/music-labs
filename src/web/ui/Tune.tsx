// Melodify: editor de notas de um áudio (voz, instrumento solo). Tudo acontece
// aqui dentro: grave ou escolha um áudio da lista do projeto, veja cada nota como
// um bloco na altura cantada, arraste para outra nota e aplique — criando uma
// variante na lista ou alterando o próprio áudio (o original fica guardado).
// "Enviar para a playlist" coloca o áudio na música.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { useApp, state, toast, openWindow, setHint, act } from '../state';
import { audio } from '../audio';
import { noteName, PPQ } from '../../core/model';
import { detectBpm, mono as monoOf } from '../../core/tempo';
import { applyTempo } from '../../core/studio';
import { trackPitch, segmentNotes, type PitchTrack, type Note } from '../../core/pitchtrack';
import { shiftPitch } from '../../core/psola';
import { Win, Knob, useCanvas, MenuTree, type MenuItem } from './widgets';
import { Icon } from './icons';
import { accent, ui } from '../theme';
import { loadAudio, pickAudioFiles, droppedAudio, acceptsAudio } from '../clipaudio';
import { detectKey, snapToKey, keyPcs, keyLabel, type Key } from '../../core/key';
import { KeyPicker } from './KeyPicker';
import { poolItems, poolItem, addToPool, commitEdit, hasEdits, editsOn, toggleEdits, sendToPlaylist, startToolRecording, finishToolRecording, importToPool } from '../pool';
import { getPref, setPref } from '../prefs';
import { LiveCapture } from './LiveCapture';
import { ChannelMix } from './ChannelMix';

interface Doc {
  id: string; // áudio da lista
  path: string;
  sr: number;
  ch: Float32Array[];
  track: PitchTrack;
  notes: Note[];
  /** Altura de destino de cada nota (MIDI fracionário). */
  target: number[];
  straight: number;
  rendered: Float32Array[] | null;
  detectedKey: Key;
  /** Tom escolhido (null = o detectado). */
  key: Key | null;
}

const keyOf = (d: Doc) => d.key ?? d.detectedKey;

let doc: Doc | null = null;
let loading = '';
let sel = -1;
let recording = false;
let variant = getPref('tune.variant', true);
/** Aberto pelo Stitcher: as alterações voltam para o próprio trecho (sem variante). */
let inPlace = false;
let preview: { stop: () => void; pos: () => number } | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Abre um áudio da lista no Melodify. */
export async function openTuneAudio(id: string, opts: { inPlace?: boolean; clip?: string } = {}) {
  openWindow('tune');
  tuneClip = opts.clip ?? null;
  const it = poolItem(id);
  if (!it) return;
  // reabrir o mesmo áudio (ex.: depois de aplicar) mantém o modo; outro áudio usa o pedido
  if (doc?.id !== id || opts.inPlace !== undefined) inPlace = !!opts.inPlace;
  stopPreview();
  loading = `Analisando ${it.name}…`;
  doc = null;
  sel = -1;
  changed();
  try {
    const a = await loadAudio(it.path);
    const mono = new Float32Array(a.ch[0].length);
    for (const ch of a.ch) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / a.ch.length;
    await new Promise((r) => setTimeout(r, 0));
    const track = trackPitch(mono, a.sr);
    const notes = segmentNotes(track);
    const weights = notes.map((n) => {
      let w = 0;
      for (let f = n.i0; f < n.i1; f++) w += track.rms[f];
      return { pitch: n.pitch, weight: w };
    });
    doc = { id, path: it.path, sr: a.sr, ch: a.ch, track, notes, target: notes.map((n) => n.pitch), straight: 0, rendered: null, detectedKey: detectKey(weights), key: null };
    if (!notes.length) toast('Não encontrei notas com altura definida nesse áudio (precisa ser uma voz ou instrumento solo)');
  } catch (e) {
    toast(`Melodify: ${(e as Error).message}`);
  }
  loading = '';
  fitNext = true;
  changed();
}

/** Abre no Melodify o arquivo de um clipe da playlist (entra na lista de áudios). */
export function openTune(clipId: string) {
  const c = state.project.clips.find((x) => x.id === clipId);
  if (c?.sample) openTuneAudio(addToPool(c.sample), { clip: clipId });
}

/** Clipe da playlist que abriu o áudio (duplo clique): é ele que o "BPM" alinha à grade. */
let tuneClip: string | null = null;

/** Detecta o BPM do áudio aberto e oferece usar no projeto. */
function tempoMenu(d: Doc, x: number, y: number, show: (m: { x: number; y: number; items: MenuItem[] }) => void) {
  const p = state.project;
  // o clipe que abriu o áudio; senão, o único clipe da playlist com este arquivo
  const mine = p.clips.filter((c) => c.kind === 'audio' && c.sample === d.path);
  const clip = mine.find((c) => c.id === tuneClip) ?? (mine.length === 1 ? mine[0] : undefined);
  let a = 0, z = d.ch[0].length;
  if (clip) {
    a = Math.min(z, Math.round((clip.startSec ?? 0) * d.sr));
    z = Math.min(z, a + Math.round(((clip.len * 60) / (p.bpm * PPQ)) * d.sr));
  }
  const g = detectBpm(monoOf(d.ch.map((c) => c.subarray(a, z))), d.sr);
  if (!g) return toast('Não achei um pulso nesse áudio: ele é curto (menos de 3 s) ou não tem ataques claros');
  const first = g.firstBeat + a / d.sr;
  const use = (bpm: number) =>
    act(applyTempo, { bpm, clip: clip?.id, firstBeat: clip ? first : undefined }) &&
    toast(`Projeto em ${bpm} BPM${clip ? ' · áudio alinhado ao compasso' : ''}`);
  const conf = g.confidence > 0.6 ? 'alta' : g.confidence > 0.3 ? 'média' : 'baixa';
  const fmt = (b: number) => String(+b.toFixed(2)).replace('.', ',');
  show({
    x,
    y,
    items: [
      { label: `Detectado: ${fmt(g.bpm)} BPM · confiança ${conf}`, hint: `O projeto está em ${fmt(p.bpm)} BPM` },
      { sep: true, label: '' },
      {
        label: `Usar ${fmt(g.bpm)} BPM no projeto`,
        hint: clip ? 'Os áudios mantêm a duração e este clipe vai para a grade (primeiro tempo no começo do compasso)' : 'Os áudios mantêm a duração',
        run: () => use(g.bpm),
      },
      ...g.alternatives.map((b) => ({ label: `Usar ${fmt(b)} BPM`, hint: Math.abs(b - g.bpm * 2) < 1 ? 'o dobro' : Math.abs(b - g.bpm / 2) < 1 ? 'a metade' : 'outra leitura possível', run: () => use(b) })),
    ],
  });
}

let fitNext = false;

function stopPreview() {
  preview?.stop();
  preview = null;
}

/** Deslocamento (semitons) de cada quadro, com transições suaves entre as notas. */
function shifts(d: Doc) {
  const n = d.track.midi.length;
  const raw = new Float32Array(n);
  d.notes.forEach((nt, i) => {
    const base = d.target[i] - nt.pitch;
    for (let f = nt.i0; f < nt.i1; f++) {
      const m = d.track.midi[f];
      raw[f] = base + (Number.isNaN(m) ? 0 : d.straight * (nt.pitch - m));
    }
  });
  // média móvel curta (~40 ms) para não estalar nas trocas
  const w = 4, out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0, k = 0;
    for (let j = Math.max(0, f - w); j <= Math.min(n - 1, f + w); j++) (s += raw[j]), k++;
    out[f] = s / k;
  }
  return out;
}

const isEdited = (d: Doc) => d.notes.some((n, i) => Math.abs(d.target[i] - n.pitch) > 1e-3) || d.straight > 0;

function render(d: Doc) {
  if (!d.rendered) d.rendered = isEdited(d) ? shiftPitch(d.ch, d.track, shifts(d)) : d.ch;
  return d.rendered;
}

const edited = (d: Doc) => {
  d.rendered = null;
  stopPreview();
  changed();
};

/** Tocar/parar o áudio do Melodify (o Espaço chama isto quando a janela está em foco). */
export function toggleTunePreview() {
  if (preview) return stopPreview(), changed();
  if (!doc) return;
  const ch = render(doc);
  preview = audio.playBuffer(ch, doc.sr, 0, () => {
    preview = null;
    changed();
  });
  changed();
}

async function toggleRec() {
  if (recording) {
    recording = false;
    changed();
    try {
      const id = await finishToolRecording('Melodify');
      if (id) openTuneAudio(id);
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

export function TuneWindow() {
  const s = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [tempo, setTempo] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => {
    listeners.add(force as () => void);
    return () => void listeners.delete(force as () => void);
  }, []);
  const items = poolItems(s.project);
  const cur = doc ? poolItem(doc.id) : undefined;
  // canal de áudio do rack deste áudio (aba de configurações)
  const curCh = cur?.channel ? s.project.channels.find((c) => c.id === cur.channel) : undefined;
  const [gear, setGear] = useState(false);
  // o áudio foi trocado por fora (restaurado, editado em outro lugar): recarrega
  useEffect(() => {
    if (doc && cur && cur.path !== doc.path) openTuneAudio(doc.id);
  }, [cur?.path]);

  const apply = async () => {
    if (!doc) return;
    const ch = render(doc);
    try {
      const asVariant = variant && !inPlace;
      const id = await commitEdit(doc.id, ch[0], ch[1] ?? ch[0], doc.sr, asVariant);
      toast(inPlace ? 'Aplicado no trecho: o Stitcher já usa a versão nova' : asVariant ? 'Variante criada na lista de áudios' : 'Alterações aplicadas no áudio (o original continua guardado)');
      openTuneAudio(id);
    } catch (e) {
      toast(`Erro ao salvar: ${(e as Error).message}`);
    }
  };
  const openFiles = async (files: File[]) => {
    if (!files.length) return;
    try {
      const ids = await importToPool(files);
      openTuneAudio(ids[0]);
    } catch (err) {
      toast(`Melodify: ${(err as Error).message}`);
    }
  };

  const tools = (
    <div class="tool-src nodrag">
      <select value={doc?.id ?? ''} data-hint="Qual áudio da lista editar" onChange={(e) => openTuneAudio((e.target as HTMLSelectElement).value)}>
        <option value="" disabled>
          Escolha um áudio…
        </option>
        {items.map((a) => (
          <option value={a.id}>
            {a.name}
            {a.path !== a.original ? ' (editado)' : ''}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Win id="tune" title="Melodify" icon="tune" tools={tools} minW={640} minH={340}>
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
            const paths = await droppedAudio(e);
            if (paths.length) openTuneAudio(addToPool(paths[0]));
          } catch (err) {
            toast(`Melodify: ${(err as Error).message}`);
          }
        }}
      >
        <div class="tool-bar">
          <button class={`amp-rec ${recording ? 'on' : ''}`} onClick={toggleRec} data-hint="Grava aqui dentro (a música não toca). Ao parar, o áudio entra na lista e abre para editar">
            <Icon name="record" size={14} />
            {recording ? 'Parar' : 'Gravar'}
          </button>
          <button class="tool-open" disabled={recording} onClick={async () => openFiles(await pickAudioFiles(false))} data-hint="Abrir um arquivo de áudio do computador (também dá para arrastar um arquivo, um sample ou um clipe da playlist para cá)">
            <Icon name="folder" size={13} /> Abrir…
          </button>
          <button class={preview ? 'on' : ''} disabled={!doc || recording} onClick={toggleTunePreview} data-hint="Ouvir como está ficando (Espaço)">
            <Icon name={preview ? 'stop' : 'play'} size={12} /> Ouvir
          </button>
          <span class="tool-sep" />
          <button
            disabled={!doc || recording}
            onClick={() => {
              if (!doc) return;
              const k = keyOf(doc);
              doc.target = doc.notes.map((n) => snapToKey(n.pitch, k));
              edited(doc);
            }}
            data-hint="Leva cada nota para a nota mais próxima do tom escolhido (autotune)"
          >
            Corrigir afinação
          </button>
          <Knob
            size={26}
            value={doc?.straight ?? 0}
            min={0}
            max={1}
            def={0}
            label="Retidão"
            title="Endireita a variação de altura dentro de cada nota (0 = natural, 100% = reta como um robô)"
            format={(v) => `${Math.round(v * 100)}%`}
            onInput={(v) => doc && ((doc.straight = v), changed())}
            onCommit={(v) => doc && ((doc.straight = v), edited(doc))}
          />
          <button
            disabled={!doc || recording}
            onClick={() => {
              if (!doc) return;
              doc.target = doc.notes.map((n) => n.pitch);
              doc.straight = 0;
              edited(doc);
            }}
            data-hint="Desfaz as edições que ainda não foram aplicadas"
          >
            Desfazer edições
          </button>
          {doc && (
            <KeyPicker
              value={doc.key}
              detected={doc.detectedKey}
              onChange={(k) => {
                if (!doc) return;
                doc.key = k;
                changed();
              }}
            />
          )}
        </div>
        <div class="tool-bar tool-bar2">
          <label class="tool-check" data-hint={inPlace ? 'Trecho do Stitcher: as alterações voltam para lá (o original continua guardado)' : 'Marcado: aplicar cria um áudio novo na lista (o atual não muda). Desmarcado: altera o próprio áudio (o original fica guardado e pode ser restaurado)'}>
            <input
              type="checkbox"
              disabled={inPlace}
              checked={variant && !inPlace}
              onChange={() => {
                variant = !variant;
                setPref('tune.variant', variant);
                changed();
              }}
            />
            Criar variante
          </label>
          <button class="tool-main" disabled={!doc || recording || !isEdited(doc)} onClick={apply}>
            <Icon name="save" size={13} /> {inPlace ? 'Aplicar no trecho do Stitcher' : variant ? 'Salvar variante' : 'Aplicar no áudio'}
          </button>
          {cur && hasEdits(cur.id) && (
            <button class={editsOn(cur.id) ? '' : 'on'} disabled={recording} onClick={() => toggleEdits(cur.id)} data-hint="Liga/desliga as edições já aplicadas neste áudio (nada é perdido: o original e a versão editada ficam guardados)">
              {editsOn(cur.id) ? 'Desativar edições' : 'Edições desativadas · reativar'}
            </button>
          )}
          <button
            disabled={!doc || recording}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (doc) tempoMenu(doc, r.left, r.bottom + 2, setTempo);
            }}
            data-hint="Detecta o BPM deste áudio e oferece usar no projeto (a música fica no tempo do que você tocou)"
          >
            BPM
          </button>
          <button disabled={!cur || recording} onClick={() => cur && sendToPlaylist(cur.id)} data-hint="Coloca este áudio na playlist (variantes vão logo abaixo do original, se ele estiver lá)">
            <Icon name="playlist" size={13} /> Enviar para a playlist
          </button>
          <span class="tool-info">{cur ? `${cur.name}${cur.variantOf ? ' · variante' : ''}${cur.path !== cur.original ? ' · editado' : ''}` : ''}</span>
          <button class={`gear-btn ${gear ? 'on' : ''}`} disabled={!curCh} onClick={() => setGear(!gear)} data-hint="Configurações do áudio: volume, pan, insert do mixer e efeitos (o mesmo canal do rack)">
            <Icon name="settings" size={13} />
          </button>
        </div>
        {gear && curCh ? (
          <div class="tool-gear">
            <ChannelMix ch={curCh} />
          </div>
        ) : recording ? (
          <LiveCapture label="Gravando no Melodify" />
        ) : loading ? (
          <div class="tool-empty">{loading}</div>
        ) : !doc ? (
          <div class="tool-empty">Grave aqui, escolha um áudio da lista acima, abra um arquivo ou arraste um áudio para esta janela.</div>
        ) : (
          <NotesCanvas />
        )}
      </div>
      {tempo && <MenuTree x={tempo.x} y={tempo.y} items={tempo.items} onClose={() => setTempo(null)} />}
    </Win>
  );
}

const KEYW = 46;
const WAVEH = 34;

function NotesCanvas() {
  const d = doc!;
  const view = useRef({ t0: 0, zx: 100, top: 72, rowH: 14 });
  const drag = useRef<{ i: number; y0: number; orig: number } | null>(null);
  const tr = d.track;
  const startSec = 0;
  const endSec = d.ch[0].length / d.sr;
  const rowY = (m: number) => (view.current.top - m) * view.current.rowH;
  const xOf = (sec: number) => KEYW + (sec - view.current.t0) * view.current.zx;

  const { ref, paint, paintOverlay } = useCanvas(
    (ctx, w, h) => {
      const v = view.current;
      if (fitNext && w > 0) {
        fitNext = false;
        v.t0 = startSec;
        v.zx = Math.max(10, (w - KEYW - 10) / Math.max(0.5, endSec - startSec));
        const ps = d.notes.map((n) => n.pitch);
        const lo = ps.length ? Math.min(...ps) - 4 : 55, hi = ps.length ? Math.max(...ps) + 4 : 72;
        v.rowH = Math.max(8, Math.min(26, (h - WAVEH) / (hi - lo)));
        v.top = hi;
      }
      ctx.fillStyle = ui('#1a1f22');
      ctx.fillRect(0, 0, w, h);
      // linhas das notas
      const pcs = keyPcs(keyOf(d));
      const lo = Math.floor(v.top - (h - WAVEH) / v.rowH) - 1;
      for (let m = Math.ceil(v.top); m >= lo; m--) {
        const y = rowY(m + 0.5);
        const pc = ((m % 12) + 12) % 12;
        const black = [1, 3, 6, 8, 10].includes(pc);
        // notas fora do tom ficam mais escuras; a tônica ganha um toque da cor de destaque
        ctx.fillStyle = !pcs.includes(pc) ? ui('#171c1f') : black ? ui('#1f262a') : ui('#252c30');
        ctx.fillRect(KEYW, y, w - KEYW, v.rowH);
        if (pc === keyOf(d).root) {
          ctx.fillStyle = accent();
          ctx.globalAlpha = 0.07;
          ctx.fillRect(KEYW, y, w - KEYW, v.rowH);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = m % 12 === 0 ? ui('#3d474d') : ui('#2a3135');
        ctx.fillRect(KEYW, y + v.rowH - 1, w - KEYW, 1);
        ctx.fillStyle = black ? ui('#2b3337') : ui('#d8dde0');
        ctx.fillRect(0, y, KEYW - 2, v.rowH - 1);
        if (v.rowH >= 11 || m % 12 === 0) {
          ctx.fillStyle = black ? ui('#9aa7ae') : ui('#2b3337');
          ctx.font = '9px sans-serif';
          ctx.fillText(noteName(m), 4, y + v.rowH - 3);
        }
      }
      // forma de onda embaixo
      const ch = d.ch[0];
      ctx.fillStyle = ui('#14191b');
      ctx.fillRect(KEYW, h - WAVEH, w - KEYW, WAVEH);
      ctx.fillStyle = 'rgba(160,190,200,0.35)';
      for (let x = KEYW; x < w; x++) {
        const a = Math.floor((v.t0 + (x - KEYW) / v.zx) * d.sr), b = Math.floor((v.t0 + (x + 1 - KEYW) / v.zx) * d.sr);
        let pk = 0;
        for (let i = Math.max(0, a); i < Math.min(ch.length, b); i += 4) pk = Math.max(pk, Math.abs(ch[i]));
        ctx.fillRect(x, h - WAVEH / 2 - pk * (WAVEH / 2 - 2), 1, Math.max(1, pk * (WAVEH - 4)));
      }
      // fora do trecho do clipe: escurecido
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(KEYW, 0, Math.max(0, xOf(startSec) - KEYW), h);
      ctx.fillRect(xOf(endSec), 0, w, h);
      // notas
      const sh = shifts(d);
      d.notes.forEach((n, i) => {
        const x0 = xOf((n.i0 * tr.hop) / tr.sr), x1 = xOf((n.i1 * tr.hop) / tr.sr);
        if (x1 < KEYW || x0 > w) return;
        const moved = Math.abs(d.target[i] - n.pitch) > 0.005;
        if (moved) {
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(x0, rowY(n.pitch + 0.4), x1 - x0, v.rowH * 0.8);
          ctx.setLineDash([]);
        }
        const y = rowY(d.target[i] + 0.4);
        ctx.fillStyle = accent();
        ctx.globalAlpha = i === sel ? 0.95 : 0.6;
        roundRect(ctx, x0, y, Math.max(3, x1 - x0), v.rowH * 0.8, Math.min(5, v.rowH * 0.3));
        ctx.fill();
        ctx.globalAlpha = 1;
        if (i === sel) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          roundRect(ctx, x0, y, Math.max(3, x1 - x0), v.rowH * 0.8, Math.min(5, v.rowH * 0.3));
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        // curva de altura (já com a edição)
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        let pen = false;
        for (let f = n.i0; f < n.i1; f++) {
          const m = tr.midi[f];
          if (Number.isNaN(m)) {
            pen = false;
            continue;
          }
          const px = xOf((f * tr.hop) / tr.sr), py = rowY(m + sh[f]);
          if (pen) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
          pen = true;
        }
        ctx.stroke();
      });
    },
    [d, d.target, d.straight, sel, d.key],
    (ctx, _w, h) => {
      if (!preview) return;
      const x = xOf(preview.pos());
      ctx.fillStyle = '#9fe0ff';
      ctx.fillRect(x, 0, 1.5, h);
    },
  );
  // cursor da prévia
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      paintOverlay();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const hit = (x: number, y: number) => {
    const v = view.current;
    for (let i = d.notes.length - 1; i >= 0; i--) {
      const n = d.notes[i];
      const x0 = xOf((n.i0 * tr.hop) / tr.sr), x1 = xOf((n.i1 * tr.hop) / tr.sr);
      const yc = rowY(d.target[i]);
      if (x >= x0 - 2 && x <= x1 + 2 && Math.abs(y - yc) < Math.max(6, v.rowH * 0.6)) return i;
    }
    return -1;
  };
  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const describe = (i: number) => {
    const n = d.notes[i], t = d.target[i];
    const c = Math.round((t - Math.round(t)) * 100);
    const from = noteName(Math.round(n.pitch)), to = noteName(Math.round(t));
    return `Nota ${i + 1}: cantada em ${from}${fmtC(n.pitch)} → ${to}${c ? ` (${c > 0 ? '+' : ''}${c} cents)` : ''} · arraste para mudar (grade do tom ${keyLabel(keyOf(d))}; Ctrl: todos os semitons; Shift: livre) · duplo clique: afinar`;
  };
  return (
    <canvas
      ref={ref}
      class="tool-canvas"
      onPointerDown={(e) => {
        const [x, y] = local(e);
        const i = hit(x, y);
        sel = i;
        if (i >= 0) {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { i, y0: y, orig: d.target[i] };
          setHint(describe(i));
        }
        paint();
        changed();
      }}
      onPointerMove={(e) => {
        const [x, y] = local(e);
        const g = drag.current;
        if (!g) {
          const i = hit(x, y);
          (e.currentTarget as HTMLElement).style.cursor = i >= 0 ? 'ns-resize' : 'default';
          if (i >= 0) setHint(describe(i));
          return;
        }
        const raw = g.orig - (y - g.y0) / view.current.rowH;
        // grade de semitom (o centro da nota cai exatamente na nota); Shift = livre
        // grade do tom (Ctrl: todos os semitons; Shift: livre)
        const k = keyOf(d);
        d.target[g.i] = e.shiftKey ? raw : e.ctrlKey || k.scale === 'chromatic' ? Math.round(raw) : snapToKey(raw, k);
        d.rendered = null;
        setHint(describe(g.i));
        paint();
      }}
      onPointerUp={() => {
        if (drag.current) {
          drag.current = null;
          edited(d);
        }
      }}
      onDblClick={(e) => {
        const [x, y] = local(e);
        const i = hit(x, y);
        if (i < 0) return;
        d.target[i] = snapToKey(d.notes[i].pitch, keyOf(d));
        edited(d);
      }}
      onWheel={(e) => {
        e.preventDefault();
        const v = view.current;
        const [x] = local(e);
        if (e.ctrlKey) {
          const t = v.t0 + (x - KEYW) / v.zx;
          v.zx = Math.max(5, Math.min(2000, v.zx * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          v.t0 = t - (x - KEYW) / v.zx;
        } else if (e.shiftKey) v.t0 = Math.max(0, v.t0 + e.deltaY / v.zx);
        else v.top += (e.deltaY > 0 ? -1 : 1) * Math.max(1, Math.round(3 * (14 / v.rowH)));
        paint();
      }}
      data-hint="Arraste as notas para cima/baixo · duplo clique afina · roda: rolar notas · Shift+roda: tempo · Ctrl+roda: zoom"
    />
  );
}

const fmtC = (m: number) => {
  const c = Math.round((m - Math.round(m)) * 100);
  return c ? ` ${c > 0 ? '+' : ''}${c}c` : '';
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
