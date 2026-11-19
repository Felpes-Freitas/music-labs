// Afinador: editor de notas de uma gravação (voz, instrumento solo). Cada nota
// aparece como um bloco na altura em que foi cantada; arraste para outra nota,
// corrija tudo de uma vez e salve como variação, sem mexer no áudio original.

import { useEffect, useReducer, useRef } from 'preact/hooks';
import { useApp, state, toggleRecord, toast, openWindow, setHint } from '../state';
import { audio } from '../audio';
import { noteName, type Clip } from '../../core/model';
import { trackPitch, segmentNotes, type PitchTrack, type Note } from '../../core/pitchtrack';
import { shiftPitch } from '../../core/psola';
import { Win, Knob, useCanvas, IconBtn } from './widgets';
import { Icon } from './icons';
import { accent, ui } from '../theme';
import { loadAudio, audioClips, clipName, makeRoomBelow, saveAsClip, ticksPerSec } from '../clipaudio';

interface Doc {
  clipId: string;
  path: string;
  sr: number;
  ch: Float32Array[];
  track: PitchTrack;
  notes: Note[];
  /** Altura de destino de cada nota (MIDI fracionário). */
  target: number[];
  straight: number;
  rendered: Float32Array[] | null;
}

let doc: Doc | null = null;
let loading = '';
let sel = -1;
let preview: { stop: () => void; pos: () => number } | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Abre o Afinador com um clipe de áudio da playlist. */
export async function openTune(clipId: string) {
  openWindow('tune');
  const c = state.project.clips.find((x) => x.id === clipId);
  if (!c?.sample) return;
  stopPreview();
  loading = `Analisando ${clipName(c)}…`;
  doc = null;
  sel = -1;
  changed();
  try {
    const a = await loadAudio(c.sample);
    const mono = new Float32Array(a.ch[0].length);
    for (const ch of a.ch) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / a.ch.length;
    await new Promise((r) => setTimeout(r, 0));
    const track = trackPitch(mono, a.sr);
    const notes = segmentNotes(track);
    doc = { clipId, path: c.sample, sr: a.sr, ch: a.ch, track, notes, target: notes.map((n) => n.pitch), straight: 0, rendered: null };
    if (!notes.length) toast('Não encontrei notas com altura definida nesse áudio (precisa ser uma voz ou instrumento solo)');
  } catch (e) {
    toast(`Afinador: ${(e as Error).message}`);
  }
  loading = '';
  fitNext = true;
  changed();
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

function render(d: Doc) {
  if (!d.rendered) d.rendered = d.notes.some((n, i) => Math.abs(d.target[i] - n.pitch) > 1e-3) || d.straight > 0 ? shiftPitch(d.ch, d.track, shifts(d)) : d.ch;
  return d.rendered;
}

const edited = (d: Doc) => {
  d.rendered = null;
  stopPreview();
  changed();
};

export function TuneWindow() {
  const s = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force as () => void);
    return () => void listeners.delete(force as () => void);
  }, []);
  const clip = doc ? s.project.clips.find((c) => c.id === doc!.clipId) : undefined;
  const clips = audioClips(s.project);
  const recording = audio.recording;

  const rec = () => {
    if (audio.recording) return toggleRecord();
    toggleRecord(null, { smart: true, onDone: (ids) => openTune(ids[ids.length - 1]) });
  };
  const play = () => {
    if (preview) return stopPreview(), changed();
    if (!doc || !clip) return;
    const ch = render(doc);
    preview = audio.playBuffer(ch, doc.sr, clip.startSec ?? 0, () => {
      preview = null;
      changed();
    });
    changed();
  };
  const saveVariation = async () => {
    if (!doc || !clip) return;
    const ch = render(doc);
    const p = state.project;
    try {
      const id = await saveAsClip(ch[0], ch[1] ?? ch[0], doc.sr, `${clipName(clip)} (variação)`, {
        tick: clip.pos,
        track: () => makeRoomBelow(clip.track, clip.pos, clip.len),
        startSec: clip.startSec ?? 0,
        lengthSec: clip.len / ticksPerSec(p),
        insert: clip.insert,
        gain: clip.gain,
      });
      if (id) toast('Variação salva logo abaixo do original');
    } catch (e) {
      toast(`Erro ao salvar a variação: ${(e as Error).message}`);
    }
  };

  const tools = (
    <div class="tool-src nodrag">
      <select
        value={doc?.clipId ?? ''}
        data-hint="Qual gravação editar (ou dê duplo clique num clipe de áudio na playlist)"
        onChange={(e) => openTune((e.target as HTMLSelectElement).value)}
      >
        <option value="" disabled>
          Escolha um áudio…
        </option>
        {clips.map((c) => (
          <option value={c.id}>
            {clipName(c)} · track {c.track + 1}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Win id="tune" title="Afinador" icon="tune" tools={tools} minW={600} minH={320}>
      <div class="tool">
        <div class="tool-bar">
          <button class={`amp-rec ${recording ? 'on' : ''}`} onClick={rec} data-hint="Grava (só quando você canta/toca) e abre a gravação aqui">
            <Icon name="record" size={14} />
            {recording ? 'Parar' : 'Gravar'}
          </button>
          <button class={preview ? 'on' : ''} disabled={!doc || !clip} onClick={play} data-hint="Ouvir como está ficando">
            <Icon name={preview ? 'stop' : 'play'} size={12} /> Ouvir
          </button>
          <span class="tool-sep" />
          <button
            disabled={!doc}
            onClick={() => {
              if (!doc) return;
              doc.target = doc.notes.map((n) => Math.round(n.pitch));
              edited(doc);
            }}
            data-hint="Leva cada nota para o semitom mais próximo (autotune)"
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
            disabled={!doc}
            onClick={() => {
              if (!doc) return;
              doc.target = doc.notes.map((n) => n.pitch);
              doc.straight = 0;
              edited(doc);
            }}
            data-hint="Volta todas as notas para a altura original"
          >
            Restaurar
          </button>
          <button class="tool-main" disabled={!doc || !clip} onClick={saveVariation} data-hint="Cria um novo clipe com a afinação editada, logo abaixo do original (o original não muda)">
            <Icon name="save" size={13} /> Salvar como variação
          </button>
        </div>
        {loading ? <div class="tool-empty">{loading}</div> : !doc ? <div class="tool-empty">Grave, escolha um áudio acima ou dê duplo clique num clipe de áudio na playlist.</div> : <NotesCanvas clip={clip} />}
      </div>
    </Win>
  );
}

const KEYW = 46;
const WAVEH = 34;

function NotesCanvas(p: { clip: Clip | undefined }) {
  const d = doc!;
  const view = useRef({ t0: 0, zx: 100, top: 72, rowH: 14 });
  const drag = useRef<{ i: number; y0: number; orig: number } | null>(null);
  const tr = d.track;
  const startSec = p.clip?.startSec ?? 0;
  const endSec = p.clip ? startSec + p.clip.len / ticksPerSec(state.project) : d.ch[0].length / d.sr;
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
      const lo = Math.floor(v.top - (h - WAVEH) / v.rowH) - 1;
      for (let m = Math.ceil(v.top); m >= lo; m--) {
        const y = rowY(m + 0.5);
        const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
        ctx.fillStyle = black ? ui('#1d2326') : ui('#232a2e');
        ctx.fillRect(KEYW, y, w - KEYW, v.rowH);
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
    [d, d.target, d.straight, sel, p.clip?.id],
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
    return `Nota ${i + 1}: cantada em ${from}${fmtC(n.pitch)} → ${to}${c ? ` (${c > 0 ? '+' : ''}${c} cents)` : ''} · arraste para mudar · Shift: sem grade · duplo clique: afinar`;
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
        d.target[g.i] = e.shiftKey ? raw : Math.round(raw);
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
        d.target[i] = Math.round(d.notes[i].pitch);
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
