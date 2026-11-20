import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, toast, previewEdit, onLive, selectPattern, setBrush, openWindow, setMode, act, setHint, setSelection, setLivePeaksHandler } from '../state';
import { SelectionMenu } from './SelectionMenu';
import { audio } from '../audio';
import { PPQ, patternLength, songLength, ticksPerBar, uid, isPatternClip, type Clip, type AutoTarget } from '../../core/model';
import { set, ins, rem } from '../../core/ops';
import { autoSnap } from '../../core/snap';
import { regen, trimAutoStart } from '../../core/autogen';
import { openAutoCenter } from '../autos';
import * as A from '../../core/actions';
import { Win, IconBtn, useCanvas } from './widgets';
import { askText } from './Dialog';
import { openTune } from './Tune';
import { Picker } from './Picker';
import { addStitchTakes } from './Stitch';

/** Janela de ferramenta (Stitcher/Afinador) embaixo do ponteiro, se houver. */
const toolAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('.win-stitch .tool, .win-tune .tool') as HTMLElement | null) ?? null;
import { ui, accent } from '../theme';
import { getPref, setPref } from '../prefs';

const HEADW = 120;

/** O último clique foi na playlist? (atalhos de teclado dela: Delete, Esc, Ctrl+A) */
let plFocus = false;
export const playlistFocused = () => plFocus;
/** Área de transferência da playlist (Ctrl+C / Ctrl+X → Ctrl+V). */
let clipboard: Clip[] = [];
window.addEventListener('pointerdown', (e) => void (plFocus = !!(e.target as Element).closest?.('.win-playlist')), true);

const RULER = 22;

type Drag =
  /** Move o clipe clicado e, junto, os outros selecionados (group: originais de todos). */
  | { kind: 'move'; id: string; x0: number; y0: number; orig: Clip; dup: boolean; group: Clip[]; only: boolean }
  /** Redimensiona o clipe clicado e, junto, os outros selecionados (group: originais). */
  | { kind: 'resize'; id: string; x0: number; orig: Clip; side: 'l' | 'r'; group: Clip[] }
  | { kind: 'point'; id: string; idx: number; orig: Clip }
  | { kind: 'erase' }
  | { kind: 'seek' }
  | { kind: 'sel'; t0: number; x0: number; moved: boolean }
  /** Pintando com o pincel (pattern ou áudio): cada espaço vazio por onde o mouse passa ganha uma cópia. */
  | { kind: 'paint'; len: number; make: (track: number, pos: number) => Clip; placed: Clip[]; fr: Map<number, { lo: number; hi: number }> };

export function Playlist() {
  const s = useApp();
  const p = s.project;
  const view = useRef({ scrollX: 0, scrollY: 0, zx: 0.12, rowH: 34 });
  const [snapMode, setSnapMode] = useState<'auto' | 'beat' | 'bar'>(() => getPref('pl.snap', 'auto'));
  const [tool, setTool] = useState<'draw' | 'erase' | 'slice' | 'mute'>('draw');
  const [menu, setMenu] = useState<{ x: number; y: number; track: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  /** Clipes selecionados (Ctrl/Shift+clique soma); arrastar um deles move todos. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pickedRef = useRef(picked);
  /** Onde o mouse está na grade (Ctrl+V cola ali). */
  const hover = useRef<{ tick: number; track: number } | null>(null);
  /** Último ponto posto num clipe de automação (o duplo clique desfaz ele). */
  const lastAutoAdd = useRef<{ id: string; prev: { t: number; v: number }[]; at: number } | null>(null);
  /** snapNow do render atual (os atalhos de teclado são registrados uma vez só). */
  const snapRef = useRef<() => number>(() => PPQ);
  pickedRef.current = picked;
  const playTick = useRef(-1);
  const bar = ticksPerBar(p);
  /**
   * Snap da grade. "auto" (padrão) segue o zoom, como no FL: quanto mais perto, mais fino
   * (compasso → tempo → 1/2 → 1/4 → 1/8 → 1/16 de tempo), sempre com células de ~10 px.
   */
  const snapNow = () => {
    if (snapMode === 'beat') return PPQ;
    if (snapMode === 'bar') return bar;
    return autoSnap(view.current.zx, bar);
  };
  snapRef.current = snapNow;

  // Delete apaga os clipes selecionados; Esc tira a seleção; Ctrl+A seleciona tudo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a playlist fica no fundo: vale o último clique ter sido nela
      if (!plFocus || !state.windows.playlist.open || (e.target as HTMLElement).closest('input, select, textarea')) return;
      const sel = pickedRef.current;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
        e.preventDefault();
        edit(state.project.clips.filter((c) => sel.has(c.id)).map((c) => rem(['clips', c.id])));
        setPicked(new Set());
      } else if (e.key === 'Escape' && sel.size) setPicked(new Set());
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['c', 'x', 'v', 'b'].includes(e.key.toLowerCase())) {
        const k = e.key.toLowerCase();
        const chosen = state.project.clips.filter((c) => sel.has(c.id));
        if (k === 'c' || k === 'x') {
          if (!chosen.length) return;
          e.preventDefault();
          clipboard = chosen.map((c) => ({ ...c }));
          if (k === 'x') {
            edit(chosen.map((c) => rem(['clips', c.id])), 'Recortar');
            setPicked(new Set());
          }
          toast(`${chosen.length} ${chosen.length > 1 ? 'itens copiados' : 'item copiado'}${k === 'x' ? ' (recortado)' : ''}`);
        } else if (k === 'v' && clipboard.length) {
          e.preventDefault();
          // cola onde o mouse está (o item mais à esquerda/acima vai para lá); fora da grade, logo depois do original
          const minPos = Math.min(...clipboard.map((c) => c.pos)), maxEnd = Math.max(...clipboard.map((c) => c.pos + c.len));
          const minTrack = Math.min(...clipboard.map((c) => c.track));
          const h = hover.current;
          const sn = snapRef.current();
          const at = h ? Math.max(0, Math.round(h.tick / sn) * sn) : maxEnd;
          const dTrack = h ? h.track - minTrack : 0;
          pasteClips(clipboard, at - minPos, dTrack);
        } else if (k === 'b' && chosen.length) {
          // duplica logo à frente (como no FL)
          e.preventDefault();
          const minPos = Math.min(...chosen.map((c) => c.pos)), maxEnd = Math.max(...chosen.map((c) => c.pos + c.len));
          pasteClips(chosen, maxEnd - minPos, 0);
        }
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setPicked(new Set(state.project.clips.map((c) => c.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** Insere cópias deslocadas (dt ticks, dTrack tracks) e deixa elas selecionadas. */
  const pasteClips = (src: Clip[], dt: number, dTrack: number) => {
    const n = state.project.tracks.length;
    const copies = src.map((c) => ({ ...c, id: uid('k'), pos: Math.max(0, c.pos + dt), track: Math.max(0, Math.min(n - 1, c.track + dTrack)) }));
    edit(copies.map((c) => ins(['clips'], c)), 'Colar');
    setPicked(new Set(copies.map((c) => c.id)));
  };
  // clipes apagados (botão direito, desfazer...) saem da seleção
  useEffect(() => {
    if (!picked.size) return;
    const ids = new Set(p.clips.map((c) => c.id));
    if ([...picked].some((id) => !ids.has(id))) setPicked(new Set([...picked].filter((id) => ids.has(id))));
  }, [s.version]);

  useEffect(() => {
    repaintPeaks = () => paint();
    return () => void (repaintPeaks = null);
  });
  const { ref, paint, paintOverlay, size } = useCanvas(
    (ctx, w, h) => {
      const v = view.current;
      const tx = (t: number) => HEADW + (t - v.scrollX) * v.zx;
      ctx.fillStyle = ui('#1b2023');
      ctx.fillRect(0, 0, w, h);
      // linhas de track
      const first = Math.floor(v.scrollY / v.rowH);
      for (let i = first; i < p.tracks.length; i++) {
        const y = RULER + i * v.rowH - v.scrollY;
        if (y > h) break;
        ctx.fillStyle = i % 2 ? ui('#20262a') : ui('#232a2e');
        ctx.fillRect(HEADW, y, w - HEADW, v.rowH);
      }
      // grade
      const g = Math.min(PPQ, snapNow());
      const t0 = Math.floor(v.scrollX / g) * g;
      for (let t = t0; tx(t) < w; t += g) {
        const x = Math.round(tx(t)) + 0.5;
        if (x < HEADW) continue;
        const isBar = t % bar === 0;
        if (!isBar && v.zx * g < 6) continue;
        ctx.strokeStyle = isBar ? ui('#3d474d') : t % PPQ === 0 ? ui('#2c3438') : ui('#252c30');
        ctx.beginPath();
        ctx.moveTo(x, RULER);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      // área selecionada: a faixa inteira, de cima a baixo
      if (s.sel) {
        const x0 = tx(s.sel.start), x1 = tx(s.sel.end);
        ctx.fillStyle = accent();
        ctx.globalAlpha = 0.1;
        ctx.fillRect(Math.max(HEADW, x0), RULER, x1 - Math.max(HEADW, x0), h);
        ctx.globalAlpha = 0.6;
        if (x0 >= HEADW) ctx.fillRect(x0, RULER, 1, h);
        ctx.fillRect(x1, RULER, 1, h);
        ctx.globalAlpha = 1;
      }
      // loop
      if (p.loop) {
        ctx.fillStyle = 'rgba(127,214,255,0.08)';
        ctx.fillRect(tx(p.loop.start), RULER, (p.loop.end - p.loop.start) * v.zx, h);
      }
      // clips
      const secPerTick = 60 / (p.bpm * PPQ);
      for (const c of p.clips) {
        const pat = isPatternClip(c) ? p.patterns.find((x) => x.id === c.patternId) : undefined;
        const x = tx(c.pos);
        const y = RULER + c.track * v.rowH - v.scrollY;
        const cw = c.len * v.zx;
        if (x + cw < HEADW || x > w || y + v.rowH < RULER || y > h) continue;
        const col = c.kind === 'audio' ? '#4fb3d9' : c.kind === 'auto' ? '#b58cf0' : pat?.color ?? ui('#888');
        ctx.globalAlpha = c.muted || p.tracks[c.track]?.mute ? 0.35 : 1;
        ctx.fillStyle = col;
        ctx.fillRect(x, y + 1, cw - 1, 13);
        ctx.fillStyle = shade(col);
        ctx.fillRect(x, y + 14, cw - 1, v.rowH - 15);
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.max(HEADW, x), y, cw - 2, v.rowH);
        ctx.clip();
        if (c.kind === 'audio' && c.sample) {
          // forma de onda do arquivo
          const pk = peaksFor(c.sample);
          if (pk) {
            const mid = y + 14 + (v.rowH - 15) / 2;
            const amp = (v.rowH - 17) / 2;
            ctx.fillStyle = 'rgba(220,245,255,0.8)';
            const x0 = Math.max(HEADW, x), x1 = Math.min(w, x + cw);
            for (let px = x0; px < x1; px++) {
              const sec = ((px - x) / v.zx) * secPerTick + (c.startSec ?? 0);
              const i = Math.floor((sec / pk.duration) * pk.peaks.length);
              if (i < 0 || i >= pk.peaks.length) continue;
              const a = Math.min(1, (pk.peaks[i] / (pk.max ?? 1)) * Math.min(1, c.gain ?? 1)) * amp;
              ctx.fillRect(px, mid - a, 1, Math.max(1, a * 2));
            }
          }
        } else if (c.kind === 'auto' && c.points?.length) {
          // curva da automação
          const top = y + 16, hh = v.rowH - 19;
          ctx.strokeStyle = '#efe4ff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          c.points.forEach((pt, i) => {
            const px = x + pt.t * v.zx, py = top + (1 - pt.v) * hh;
            i ? ctx.lineTo(px, py) : ctx.moveTo(x, py);
            if (!i && pt.t > 0) ctx.lineTo(px, py);
          });
          const last = c.points[c.points.length - 1];
          ctx.lineTo(x + cw, top + (1 - last.v) * hh);
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.fillStyle = ui('#fff');
          for (const pt of c.points) {
            ctx.beginPath();
            ctx.arc(x + pt.t * v.zx, top + (1 - pt.v) * hh, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (pat) {
          // mini notas (com repetição dentro do clip)
          const plen = patternLength(p, pat);
          const all = Object.values(pat.notes).flat();
          if (all.length) {
            let lo = 127, hi = 0;
            for (const n of all) {
              lo = Math.min(lo, n.key);
              hi = Math.max(hi, n.key);
            }
            const span = Math.max(1, hi - lo);
            const inner = v.rowH - 19;
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            for (let rep = Math.floor(c.offset / plen) * plen - c.offset; rep < c.len; rep += plen)
              for (const n of all) {
                const nt = rep + n.pos;
                if (nt < 0 || nt >= c.len) continue;
                const nx = x + nt * v.zx;
                const ny = y + 16 + ((hi - n.key) / span) * inner;
                ctx.fillRect(nx, ny, Math.max(1, Math.min(n.len, c.len - nt) * v.zx - 0.5), 1.5);
              }
          }
        }
        ctx.fillStyle = ui('#111');
        ctx.font = '10px sans-serif';
        const label = c.kind === 'audio' ? `♫ ${(p.audios ?? []).find((au) => au.path === c.sample)?.name ?? (c.sample ?? '').split(/[\\/]/).pop()}` : c.kind === 'auto' ? `⤴ ${c.target?.label ?? 'automação'}` : pat?.name ?? '?';
        ctx.fillText(label, x + 3, y + 11);
        ctx.restore();
        if (picked.has(c.id)) {
          // selecionado: contorno claro e um leve brilho
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(x, y + 1, cw - 1, v.rowH - 2);
          ctx.strokeStyle = ui('#fff');
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.75, y + 1.75, cw - 2.5, v.rowH - 3.5);
          ctx.lineWidth = 1;
        }
        ctx.globalAlpha = 1;
      }
      // cabeçalho das tracks
      for (let i = first; i < p.tracks.length; i++) {
        const y = RULER + i * v.rowH - v.scrollY;
        if (y > h) break;
        const t = p.tracks[i];
        ctx.fillStyle = ui('#2b3236');
        ctx.fillRect(0, y, HEADW, v.rowH - 1);
        ctx.fillStyle = t.mute ? ui('#444') : '#7cdc6a';
        ctx.beginPath();
        ctx.arc(10, y + v.rowH / 2, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = t.mute ? ui('#777') : ui('#ddd');
        ctx.font = '11px sans-serif';
        ctx.fillText(t.name.slice(0, 15), 20, y + v.rowH / 2 + 4);
      }
      // régua
      ctx.fillStyle = ui('#2d3539');
      ctx.fillRect(0, 0, w, RULER);
      ctx.fillStyle = ui('#aab');
      ctx.font = '10px sans-serif';
      const every = v.zx * bar < 28 ? 4 : 1;
      for (let b = Math.floor(v.scrollX / bar); tx(b * bar) < w; b++) {
        const x = tx(b * bar);
        if (x < HEADW || b % every) continue;
        ctx.fillRect(x, 12, 1, RULER - 12);
        ctx.fillText(String(b + 1), x + 3, 12);
      }
      if (p.loop) {
        ctx.fillStyle = '#7fd6ff';
        ctx.fillRect(Math.max(HEADW, tx(p.loop.start)), RULER - 4, (p.loop.end - p.loop.start) * v.zx, 4);
      }
      if (s.sel) {
        const x0 = Math.max(HEADW, tx(s.sel.start)), x1 = tx(s.sel.end);
        ctx.fillStyle = accent();
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x0, 0, x1 - x0, RULER);
        ctx.globalAlpha = 1;
        ctx.fillRect(x0, RULER - 4, x1 - x0, 4);
      }
      ctx.fillStyle = ui('#2d3539');
      ctx.fillRect(0, 0, HEADW, RULER);
      ctx.fillStyle = ui('#889');
      ctx.fillText('Tracks', 8, 15);
    },
    [s.version, s.sel, picked, snapMode],
    (ctx, w, h) => {
      drawRecording(ctx, w, h);
      if (playTick.current < 0) return;
      const v = view.current;
      const x = HEADW + (playTick.current - v.scrollX) * v.zx;
      if (x >= HEADW && x < w) {
        ctx.fillStyle = '#9fe0ff';
        ctx.fillRect(x, 0, 1.5, h);
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 8);
        ctx.fill();
      }
    },
  );

  /** Takes sendo gravados: cada um cresce com o tempo e mostra a onda que está chegando. */
  const drawRecording = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const r = audio.liveRecording;
    if (!r) return;
    const v = view.current;
    const p = state.project;
    const ticksPerSec = (p.bpm * PPQ) / 60;
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADW, RULER, w - HEADW, h - RULER);
    ctx.clip();
    const perPx = r.sr / ticksPerSec / v.zx / r.peakFrames; // blocos de pico por pixel
    r.takes.forEach((t, k) => {
      const live = k === r.takes.length - 1 && t.c1 >= r.frames;
      if (!live) return; // takes fechados já viraram clipes de verdade na playlist
      const x = HEADW + (t.tick - v.scrollX) * v.zx;
      const cw = ((t.c1 - t.c0) / r.sr) * ticksPerSec * v.zx;
      const y = RULER + t.track * v.rowH - v.scrollY;
      if (y + v.rowH < RULER || y > h || x > w || x + cw < HEADW) return;
      ctx.fillStyle = live ? '#e04848' : '#b84545';
      ctx.fillRect(x, y + 1, Math.max(2, cw - 1), 13);
      ctx.fillStyle = 'rgba(120,24,24,0.85)';
      ctx.fillRect(x, y + 14, Math.max(2, cw - 1), v.rowH - 15);
      const mid = y + 14 + (v.rowH - 15) / 2;
      const amp = (v.rowH - 17) / 2;
      const b0 = t.c0 / r.peakFrames;
      ctx.fillStyle = '#ffd9d9';
      const x0 = Math.max(HEADW, Math.floor(x)), x1 = Math.min(w, x + cw);
      for (let px = x0; px < x1; px++) {
        const i0 = Math.floor(b0 + (px - x) * perPx), i1 = Math.max(i0 + 1, Math.floor(b0 + (px + 1 - x) * perPx));
        let a = 0;
        for (let i = i0; i < i1 && i < r.peaks.length; i++) a = Math.max(a, r.peaks[i]);
        const hh = Math.min(1, a) * amp;
        ctx.fillRect(px, mid - hh, 1, Math.max(1, hh * 2));
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      const label = r.smart ? `${live ? '● ' : ''}Take ${k + 1}` : `● Gravando ${((t.c1 - t.c0) / r.sr).toFixed(1)} s`;
      if (cw > 34) ctx.fillText(label, Math.max(HEADW, x) + 3, y + 11);
    });
    ctx.restore();
  };

  useEffect(
    () =>
      onLive((st) => {
        const t = st.playing && st.mode === 'song' ? st.tick : -1;
        // gravando, a onda cresce a cada atualização
        if (t !== playTick.current || audio.liveRecording) {
          playTick.current = t;
          // segue a reprodução (só repinta tudo quando a tela precisa rolar)
          const v = view.current;
          const w = size.current.w;
          let scrolled = false;
          if (t >= 0 && state.followPlay) {
            const x = HEADW + (t - v.scrollX) * v.zx;
            if (x > w - 40 || x < HEADW) {
              v.scrollX = Math.max(0, t - 20 / v.zx);
              scrolled = true;
            }
          }
          if (scrolled) paint();
          else paintOverlay();
        }
      }),
    [],
  );

  const local = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const tx = (t: number) => HEADW + (t - view.current.scrollX) * view.current.zx;
  const tickAt = (x: number) => view.current.scrollX + (x - HEADW) / view.current.zx;
  const trackAt = (y: number) => Math.floor((y - RULER + view.current.scrollY) / view.current.rowH);
  const hit = (x: number, y: number) => {
    const v = view.current;
    for (let i = p.clips.length - 1; i >= 0; i--) {
      const c = p.clips[i];
      const cx = HEADW + (c.pos - v.scrollX) * v.zx;
      const cy = RULER + c.track * v.rowH - v.scrollY;
      const cw = c.len * v.zx;
      if (x >= cx && x <= cx + cw && y >= cy && y < cy + v.rowH) {
        const edge = cw > 14 && x > cx + cw - 6 ? 'r' : cw > 14 && x < cx + 6 ? 'l' : null;
        return { c, edge } as { c: Clip; edge: 'l' | 'r' | null };
      }
    }
    return null;
  };
  const clipOps = (c: Clip): ReturnType<typeof set>[] => [set(['clips', c.id], c)];
  /**
   * Anda o começo de um clipe dt ticks sem mexer no conteúdo (áudio começa mais adiante
   * no arquivo; pattern muda o offset; automação: a função se recalcula, pontos ficam
   * no mesmo instante da música).
   */
  const trimStart = (c: Clip, dt: number, sn: number): Clip => {
    if (c.kind === 'auto') {
      const pos = Math.max(0, Math.min(c.pos + dt, c.pos + c.len - Math.min(sn, c.len)));
      return trimAutoStart(c, pos - c.pos);
    }
    const secPerTick = 60 / (p.bpm * PPQ);
    let pos = Math.min(c.pos + dt, c.pos + c.len - Math.min(sn, c.len));
    pos = Math.max(0, pos);
    if (c.kind === 'audio') pos = Math.max(pos, Math.ceil(c.pos - (c.startSec ?? 0) / secPerTick));
    const d = pos - c.pos;
    if (c.kind === 'audio') return { ...c, pos, len: c.len - d, startSec: Math.max(0, (c.startSec ?? 0) + d * secPerTick) };
    const pat = p.patterns.find((q) => q.id === c.patternId);
    const plen = pat ? patternLength(p, pat) : c.len;
    return { ...c, pos, len: c.len - d, offset: (((c.offset + d) % plen) + plen) % plen };
  };

  const onDown = (e: PointerEvent) => {
    const [x, y] = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (y < RULER) {
      if (x < HEADW) return;
      // clique na régua posiciona; arrastar seleciona uma área
      drag.current = { kind: 'sel', t0: Math.max(0, Math.round(tickAt(x) / snapNow()) * snapNow()), x0: x, moved: false };
      return;
    }
    if (x < HEADW) {
      const t = trackAt(y);
      const tr = p.tracks[t];
      if (!tr) return;
      if (e.button === 2 || e.detail === 2) {
        askText({ title: 'Renomear track', label: 'Nome', value: tr.name, ok: 'Renomear' }).then((n) => n && edit([set(['tracks', tr.id, 'name'], n)]));
      } else edit([set(['tracks', tr.id, 'mute'], !tr.mute)]);
      return;
    }
    const h = hit(x, y);
    // botão direito num lugar vazio da área selecionada: menu (preencher, inserir
    // instrumento) na track clicada. Em cima de um clipe, apaga como sempre.
    if (e.button === 2 && s.sel && !h) {
      const t = tickAt(x);
      if (t >= s.sel.start && t < s.sel.end) {
        drag.current = null;
        setMenu({ x: e.clientX, y: e.clientY, track: Math.max(0, Math.min(p.tracks.length - 1, trackAt(y))) });
        return;
      }
    }
    // automação: duplo clique ou Shift + botão direito abre na Central de Automações
    if (h && h.c.kind === 'auto' && !h.edge && (e.detail === 2 || (e.button === 2 && e.shiftKey))) {
      // o primeiro clique do duplo clique pôs um ponto: tira
      const la = lastAutoAdd.current;
      if (e.detail === 2 && la && la.id === h.c.id && performance.now() - la.at < 600) edit([set(['clips', la.id, 'points'], la.prev)]);
      lastAutoAdd.current = null;
      drag.current = null;
      openAutoCenter(h.c.id);
      return;
    }
    // edição de pontos no corpo de um clipe de automação
    if (h && h.c.kind === 'auto' && !h.edge && tool === 'draw') {
      const c = h.c;
      const v = view.current;
      const top = RULER + c.track * v.rowH - v.scrollY + 16;
      const hh = v.rowH - 19;
      if (y > top - 2) {
        const pts = c.points ?? [];
        const near = pts.findIndex((pt) => Math.hypot(tx(c.pos + pt.t) - x, top + (1 - pt.v) * hh - y) < 7);
        if (e.button === 2) {
          if (near >= 0 && pts.length > 1) edit([set(['clips', c.id, 'points'], pts.filter((_, i) => i !== near)), ...(c.gen ? [set(['clips', c.id, 'gen'], { ...c.gen, custom: true })] : [])]);
          return;
        }
        let idx = near;
        if (idx < 0) {
          const t = Math.max(0, Math.min(c.len, Math.round((x - tx(c.pos)) / v.zx)));
          const val = Math.max(0, Math.min(1, 1 - (y - top) / hh));
          const next = [...pts, { t, v: val }].sort((a, b) => a.t - b.t);
          idx = next.findIndex((pt) => pt.t === t && pt.v === val);
          lastAutoAdd.current = { id: c.id, prev: pts, at: performance.now() };
          previewEdit([set(['clips', c.id, 'points'], next), ...(c.gen && !c.gen.custom ? [set(['clips', c.id, 'gen'], { ...c.gen, custom: true })] : [])]);
        }
        drag.current = { kind: 'point', id: c.id, idx, orig: { ...state.project.clips.find((q) => q.id === c.id)! } };
        return;
      }
    }
    if (e.button === 2 || tool === 'erase') {
      drag.current = { kind: 'erase' };
      if (h) edit([rem(['clips', h.c.id])]);
      return;
    }
    if (tool === 'mute') {
      if (h) edit([set(['clips', h.c.id, 'muted'], !h.c.muted || undefined)]);
      return;
    }
    if (tool === 'slice') {
      if (!h) return;
      const at = Math.round(tickAt(x) / snapNow()) * snapNow();
      const c = h.c;
      if (at <= c.pos || at >= c.pos + c.len) return;
      const cut = at - c.pos;
      if (c.kind === 'audio') {
        const second = { ...c, id: uid('k'), pos: at, len: c.len - cut, startSec: (c.startSec ?? 0) + (cut * 60) / (p.bpm * PPQ) };
        edit([set(['clips', c.id, 'len'], cut), ins(['clips'], second)]);
      } else if (c.kind === 'auto') {
        const pts = c.points ?? [];
        const mid = autoNorm(c, cut);
        const first = [...pts.filter((q) => q.t < cut), { t: cut, v: mid }];
        const rest = [{ t: 0, v: mid }, ...pts.filter((q) => q.t > cut).map((q) => ({ t: q.t - cut, v: q.v }))];
        // fatiada, a função vira pontos (cada metade guarda o que tinha)
        const g = c.gen ? { ...c.gen, custom: true } : undefined;
        edit([set(['clips', c.id, 'len'], cut), set(['clips', c.id, 'points'], first), set(['clips', c.id, 'gen'], g), ins(['clips'], { ...c, id: uid('k'), pos: at, len: c.len - cut, points: rest, gen: g })]);
      } else {
        const pat = p.patterns.find((q) => q.id === c.patternId);
        const plen = pat ? patternLength(p, pat) : c.len;
        const second = { ...c, id: uid('k'), pos: at, len: c.len - cut, offset: (c.offset + cut) % plen };
        edit([set(['clips', c.id, 'len'], cut), ins(['clips'], second)]);
      }
      return;
    }
    if (h) {
      // Alt+clique: a faixa de tempo do clipe vira a área selecionada (loop, preencher...)
      if (e.altKey) {
        setSelection({ start: h.c.pos, end: h.c.pos + h.c.len });
        return;
      }
      // o clipe clicado vira o pincel: o próximo clique no vazio coloca ele
      if (isPatternClip(h.c)) selectPattern(h.c.patternId);
      else if (h.c.kind === 'audio' && h.c.sample) {
        const it = (p.audios ?? []).find((a) => a.path === h.c.sample);
        setBrush({ sample: h.c.sample, startSec: h.c.startSec ?? 0, len: h.c.len, gain: h.c.gain, insert: h.c.insert, name: it?.name ?? h.c.sample.split(/[\\/]/).pop()! });
      }
      if (e.detail === 2 && h.c.kind === 'audio') {
        openTune(h.c.id);
        return;
      }
      if (e.detail === 2 && isPatternClip(h.c)) {
        openWindow('rack');
        return;
      }
      // seleção: Ctrl alterna, Shift soma, clique simples seleciona só ele (ou mantém o grupo para arrastar)
      const cur = pickedRef.current;
      let next = cur;
      if (e.ctrlKey && !e.shiftKey) {
        next = new Set(cur);
        if (next.has(h.c.id)) next.delete(h.c.id);
        else next.add(h.c.id);
      } else if (e.shiftKey && !e.ctrlKey) next = new Set([...cur, h.c.id]);
      else if (!cur.has(h.c.id)) next = new Set([h.c.id]);
      if (next !== cur) setPicked(next);
      if (!next.has(h.c.id)) return; // Ctrl+clique tirou da seleção
      if (h.edge) {
        drag.current = { kind: 'resize', id: h.c.id, x0: x, orig: { ...h.c }, side: h.edge, group: state.project.clips.filter((c) => next.has(c.id)).map((c) => ({ ...c })) };
        return;
      }
      let group = state.project.clips.filter((c) => next.has(c.id)).map((c) => ({ ...c }));
      if (e.ctrlKey && e.shiftKey) {
        // Ctrl+Shift+arrastar duplica (os selecionados)
        const copies = group.map((c) => ({ ...c, id: uid('k') }));
        edit(copies.map((c) => ins(['clips'], c)));
        setPicked(new Set(copies.map((c) => c.id)));
        group = copies;
        const me = copies[state.project.clips.filter((c) => next.has(c.id)).findIndex((c) => c.id === h.c.id)] ?? copies[0];
        drag.current = { kind: 'move', id: me.id, x0: x, y0: y, orig: me, dup: true, group, only: false };
        return;
      }
      drag.current = { kind: 'move', id: h.c.id, x0: x, y0: y, orig: { ...h.c }, dup: false, group, only: !e.ctrlKey && !e.shiftKey && cur.has(h.c.id) && cur.size > 1 };
      return;
    }
    if (pickedRef.current.size) setPicked(new Set());
    // espaço vazio: pinta com o pincel (o pattern selecionado ou o último áudio escolhido)
    const track = trackAt(y);
    if (track < 0 || track >= p.tracks.length) return;
    const br = s.brush;
    const pat = p.patterns.find((x) => x.id === s.patternId);
    if (!br && !pat) return;
    const len = br ? br.len : patternLength(p, pat!);
    const make = (tr: number, pos: number): Clip =>
      br
        ? { id: uid('k'), kind: 'audio', track: tr, pos, len, patternId: '', offset: 0, sample: br.sample, startSec: br.startSec, gain: br.gain ?? 1, insert: br.insert ?? 0 }
        : { id: uid('k'), track: tr, pos, len, patternId: pat!.id, offset: 0 };
    const d: Drag = { kind: 'paint', len, make, placed: [], fr: new Map() };
    drag.current = d;
    paintAt(d, track, tickAt(x), true);
  };

  /** Livre o trecho [pos, pos+len) da track (contando o que já foi pintado agora)? */
  const isFree = (track: number, pos: number, len: number) => !state.project.clips.some((c) => c.track === track && c.pos < pos + len && c.pos + c.len > pos);
  /**
   * Pinta na track até o tick do mouse: a partir do primeiro clipe, para a direita e para
   * a esquerda, encostando um no outro; onde já tem clipe, pula.
   */
  const paintAt = (d: Extract<Drag, { kind: 'paint' }>, track: number, tick: number, first = false) => {
    const put = (pos: number) => {
      const c = d.make(track, pos);
      d.placed.push(c);
      previewEdit([ins(['clips'], c)]);
    };
    let f = d.fr.get(track);
    if (!f) {
      const pos = Math.max(0, Math.floor(tick / snapNow()) * snapNow());
      if (first || isFree(track, pos, d.len)) put(pos);
      f = { lo: pos, hi: pos + d.len };
      d.fr.set(track, f);
    }
    while (f.hi <= tick) {
      if (isFree(track, f.hi, d.len)) put(f.hi);
      f.hi += d.len;
    }
    while (f.lo > tick && f.lo - d.len >= 0) {
      f.lo -= d.len;
      if (isFree(track, f.lo, d.len)) put(f.lo);
    }
  };

  const seek = (x: number) => {
    const t = Math.max(0, Math.floor(tickAt(x) / PPQ) * PPQ);
    if (state.mode !== 'song') setMode('song');
    audio.seek(t);
    playTick.current = t;
    paintOverlay();
  };

  const onMove = (e: PointerEvent) => {
    const [x, y] = local(e);
    hover.current = x > HEADW && y > RULER ? { tick: tickAt(x), track: trackAt(y) } : null;
    const d = drag.current;
    if (!d) {
      const h = y > RULER && x > HEADW ? hit(x, y) : null;
      (e.currentTarget as HTMLElement).style.cursor = h ? (e.altKey ? 'pointer' : h.edge ? 'ew-resize' : 'move') : y < RULER ? 'text' : 'crosshair';
      return;
    }
    const v = view.current;
    if (d.kind === 'point') {
      const c = d.orig;
      const pts = [...(state.project.clips.find((q) => q.id === d.id)?.points ?? [])];
      const top = RULER + c.track * v.rowH - v.scrollY + 16;
      const hh = v.rowH - 19;
      const lo = d.idx > 0 ? pts[d.idx - 1].t : 0;
      const hi = d.idx < pts.length - 1 ? pts[d.idx + 1].t : c.len;
      const t = Math.max(lo, Math.min(hi, Math.round((x - HEADW) / v.zx + v.scrollX - c.pos)));
      const val = Math.max(0, Math.min(1, 1 - (y - top) / hh));
      pts[d.idx] = { t, v: val };
      previewEdit([set(['clips', d.id, 'points'], pts)]);
      const tg = c.target;
      if (tg) setHint(`${tg.label}: ${fmtAuto(tg, val)}`);
      return;
    }
    if (d.kind === 'move') {
      // arrastando um áudio por cima do Stitcher/Afinador: destaca a janela (soltar = enviar para lá)
      const tool = d.orig.kind === 'audio' && !d.dup && d.group.length === 1 ? toolAt(e.clientX, e.clientY) : null;
      document.querySelectorAll('.tool.dropping').forEach((el) => el !== tool && el.classList.remove('dropping'));
      tool?.classList.add('dropping');
      const sn = snapNow();
      // o clipe clicado encaixa na grade; os outros acompanham sem sair da tela
      let dt = Math.round((d.orig.pos + (x - d.x0) / v.zx) / sn) * sn - d.orig.pos;
      let dtr = Math.round((y - d.y0) / v.rowH);
      dt = Math.max(dt, -Math.min(...d.group.map((c) => c.pos)));
      dtr = Math.max(-Math.min(...d.group.map((c) => c.track)), Math.min(p.tracks.length - 1 - Math.max(...d.group.map((c) => c.track)), dtr));
      previewEdit(d.group.flatMap((c) => clipOps({ ...c, pos: c.pos + dt, track: c.track + dtr })));
    } else if (d.kind === 'resize') {
      // o clipe clicado encaixa na grade; os outros selecionados mudam o mesmo tanto
      const sn = snapNow();
      const o = d.orig;
      if (d.side === 'r') {
        const end = Math.round((o.pos + o.len + (x - d.x0) / v.zx) / sn) * sn;
        const dl = Math.max(sn, end - o.pos) - o.len;
        previewEdit(d.group.flatMap((c) => clipOps(regen({ ...c, len: Math.max(Math.min(sn, c.len), c.len + dl) }))));
      } else {
        const dt = Math.round((o.pos + (x - d.x0) / v.zx) / sn) * sn - o.pos;
        previewEdit(d.group.flatMap((c) => clipOps(trimStart(c, dt, sn))));
      }
    } else if (d.kind === 'erase') {
      // com uma área selecionada, arrastar apagando só pega o que está dentro dela
      const sel = state.sel;
      if (sel) {
        const t = tickAt(x);
        if (t < sel.start || t >= sel.end) return;
      }
      const h = hit(x, y);
      if (h && (!sel || (h.c.pos < sel.end && h.c.pos + h.c.len > sel.start))) edit([rem(['clips', h.c.id])]);
    } else if (d.kind === 'seek') seek(x);
    else if (d.kind === 'paint') {
      const tr = trackAt(y);
      if (tr >= 0 && tr < p.tracks.length) paintAt(d, tr, Math.max(0, tickAt(x)));
    }
    else if (d.kind === 'sel') {
      if (!d.moved && Math.abs(x - d.x0) < 4) return;
      d.moved = true;
      const t1 = Math.max(0, Math.round(tickAt(x) / snapNow()) * snapNow());
      setSelection({ start: Math.min(d.t0, t1), end: Math.max(d.t0, t1) });
    }
  };

  const onUp = (e?: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    document.querySelectorAll('.tool.dropping').forEach((el) => el.classList.remove('dropping'));
    // soltou um áudio dentro do Stitcher ou do Afinador: o clipe volta ao lugar e vai para a ferramenta
    if (d.kind === 'move' && !d.dup && d.orig.kind === 'audio' && e) {
      const tool = toolAt(e.clientX, e.clientY);
      if (tool) {
        previewEdit([set(['clips', d.id], d.orig)]);
        if (tool.closest('.win-stitch')) addStitchTakes([d.id]);
        else openTune(d.id);
        return;
      }
    }
    if (d.kind === 'paint') {
      // tudo o que foi pintado vira um passo só (desfazer tira tudo) e vira a área selecionada
      if (!d.placed.length) return;
      previewEdit(d.placed.map((c) => rem(['clips', c.id])));
      edit(d.placed.map((c) => ins(['clips'], c)));
      return;
    }
    if (d.kind === 'point') {
      const c = state.project.clips.find((x) => x.id === d.id);
      // editou à mão: uma automação de função vira personalizada
      if (c) edit([set(['clips', c.id, 'points'], c.points ?? []), ...(c.gen ? [set(['clips', c.id, 'gen'], { ...c.gen, custom: true })] : [])]);
      return;
    }
    if (d.kind === 'move') {
      const cur = d.group.map((g) => state.project.clips.find((x) => x.id === g.id)).filter((c): c is Clip => !!c);
      const same = cur.every((c, i) => c.pos === d.group[i].pos && c.track === d.group[i].track);
      if (same && !d.dup) {
        // clique sem arrastar num clipe de um grupo: fica só ele selecionado
        if (d.only) setPicked(new Set([d.id]));
        return;
      }
      edit(cur.flatMap((c) => clipOps(c)));
    } else if (d.kind === 'resize') {
      const cur = d.group.map((g) => state.project.clips.find((x) => x.id === g.id)).filter((c): c is Clip => !!c);
      if (cur.length) edit(cur.flatMap((c) => clipOps(c)));
    } else if (d.kind === 'sel' && !d.moved && e) {
      // clique simples na régua: tira a seleção e posiciona a agulha
      setSelection(null);
      seek(local(e)[0]);
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const v = view.current;
    if (e.ctrlKey) {
      const t = tickAt(e.offsetX);
      v.zx = Math.max(0.01, Math.min(1.5, v.zx * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      v.scrollX = Math.max(0, t - (e.offsetX - HEADW) / v.zx);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) v.scrollX = Math.max(0, v.scrollX + (e.deltaX || e.deltaY) / v.zx);
    else if (e.altKey) v.rowH = Math.max(18, Math.min(80, v.rowH + (e.deltaY < 0 ? 2 : -2)));
    else v.scrollY = Math.max(0, Math.min(p.tracks.length * v.rowH - 60, v.scrollY + e.deltaY));
    paint();
  };

  const len = songLength(p);
  return (
    <Win
      id="playlist"
      icon="playlist"
      title={
        <>
          Playlist <span class="dim">· arranjo · {Math.ceil(len / bar)} compassos</span>
        </>
      }
      minW={420}
      minH={200}
      tools={
        <span class="pl-tools nodrag">
          <span class="tgroup">
            <IconBtn icon="pencil" on={tool === 'draw'} hint="Lápis: clique pinta o pattern selecionado, arraste move, borda redimensiona (o pattern repete)" onClick={() => setTool('draw')} />
            <IconBtn icon="eraser" on={tool === 'erase'} hint="Borracha: apaga clips (o botão direito também apaga)" onClick={() => setTool('erase')} />
            <IconBtn icon="mute" on={tool === 'mute'} hint="Mute de clip" onClick={() => setTool('mute')} />
            <IconBtn icon="slice" on={tool === 'slice'} hint="Fatiar clip no ponto clicado" onClick={() => setTool('slice')} />
          </span>
          <span class="tgroup">
            <IconBtn icon="magnet" label={{ auto: 'auto', beat: 'tempo', bar: 'compasso' }[snapMode]} hint="Snap da playlist: auto (segue o zoom, como no FL), tempo ou compasso" onClick={() => {
              const n = ({ auto: 'beat', beat: 'bar', bar: 'auto' } as const)[snapMode];
              setSnapMode(n);
              setPref('pl.snap', n);
            }} />
            <IconBtn icon="follow" on={s.followPlay} hint="Seguir a reprodução" onClick={() => ((state.followPlay = !state.followPlay), paint())} />
            <IconBtn icon="plus" label="track" hint="Adicionar track" onClick={() => edit([ins(['tracks'], { id: uid('t'), name: `Track ${p.tracks.length + 1}`, color: '#888', mute: false })])} />
          </span>
        </span>
      }
    >
      <div class="pl-wrap">
        <Picker />
        {menu && s.sel && <SelectionMenu x={menu.x} y={menu.y} track={menu.track} sel={s.sel} onClose={() => setMenu(null)} />}
        <canvas
          ref={ref}
          class="pl-canvas"
          onPointerDown={onDown as any}
          onPointerMove={onMove as any}
          onPointerLeave={() => void (hover.current = null)}
          onDblClick={(e) => {
            // duplo clique num clipe de automação: abre na Central (o 1º clique pode ter posto um ponto: tira)
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const h = hit(e.clientX - r.left, e.clientY - r.top);
            if (!h || h.c.kind !== 'auto') return;
            const la = lastAutoAdd.current;
            if (la && la.id === h.c.id && performance.now() - la.at < 800) edit([set(['clips', la.id, 'points'], la.prev)]);
            lastAutoAdd.current = null;
            openAutoCenter(h.c.id);
          }}
          onPointerUp={onUp as any}
          onWheel={onWheel as any}
          onContextMenu={(e) => e.preventDefault()}
          onDragOver={(e) => e.dataTransfer?.types.includes('text/x-musiclabs-sample') && e.preventDefault()}
          onDrop={async (e) => {
            const path = e.dataTransfer?.getData('text/x-musiclabs-sample');
            if (!path) return;
            e.preventDefault();
            e.stopPropagation();
            const [x, y] = local(e as any);
            const track = Math.max(0, trackAt(y));
            const tick = Math.max(0, Math.round(tickAt(x) / PPQ) * PPQ);
            const pk = await loadPeaks(path);
            act(A.addAudioClip, { sample: path, bar: 1, beat: tick / PPQ, track: track + 1, lengthSec: pk.duration });
          }}
          data-hint="Solte um áudio do navegador para criar um clipe · Régua: posicionar (Shift ou direito: loop) · Shift+arrastar clip: duplicar · duplo clique no clip: abrir no rack · Ctrl+roda: zoom · Alt+roda: altura"
        />
      </div>
    </Win>
  );
}

function shade(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * 0.45, g = ((n >> 8) & 255) * 0.45, b = (n & 255) * 0.45;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ---------------------------------------------------------------- formas de onda e automação

const peaksCache = new Map<string, { duration: number; peaks: number[]; max?: number } | 'carregando'>();
let repaintPeaks: (() => void) | null = null;

export async function loadPeaks(path: string): Promise<{ duration: number; peaks: number[] }> {
  const hit = peaksCache.get(path);
  if (hit && hit !== 'carregando') return hit;
  peaksCache.set(path, 'carregando');
  const r = await fetch(`/api/peaks?path=${encodeURIComponent(path)}&n=2000`);
  const d = await r.json();
  if (!r.ok) {
    peaksCache.delete(path);
    throw new Error(d.error);
  }
  d.max = Math.max(0.05, ...d.peaks);
  peaksCache.set(path, d);
  repaintPeaks?.();
  return d;
}

/** Contorno de um áudio que ainda não está no servidor (prévia de take gravado agora). */
export function setLivePeaks(path: string, L: Float32Array, sr: number) {
  const n = 2000, per = Math.max(1, Math.floor(L.length / n));
  const peaks: number[] = [];
  for (let i = 0; i < L.length; i += per) {
    let m = 0;
    for (let j = i; j < Math.min(L.length, i + per); j++) m = Math.max(m, Math.abs(L[j]));
    peaks.push(m);
  }
  peaksCache.set(path, { duration: L.length / sr, peaks, max: Math.max(0.05, ...peaks) });
  repaintPeaks?.();
}

/** Contorno do arquivo, se já carregado (senão começa a carregar e repinta depois). */
function peaksFor(path: string) {
  if (path.startsWith('live:') && !peaksCache.has(path)) return null;
  const hit = peaksCache.get(path);
  if (hit === undefined) loadPeaks(path).catch(() => {});
  return hit && hit !== 'carregando' ? hit : null;
}

/** Valor normalizado da automação num instante do clipe. */
function autoNorm(c: Clip, t: number): number {
  const pts = c.points ?? [];
  if (!pts.length) return 0;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) if (t < pts[i].t) return pts[i - 1].v + ((pts[i].v - pts[i - 1].v) * (t - pts[i - 1].t)) / Math.max(1, pts[i].t - pts[i - 1].t);
  return pts[pts.length - 1].v;
}

export function fmtAuto(t: AutoTarget, v: number) {
  const real = t.log && t.min > 0 ? t.min * Math.pow(t.max / t.min, v) : t.min + v * (t.max - t.min);
  if (t.path[t.path.length - 1] === 'volume') return real <= 0.0001 ? '-∞ dB' : `${(20 * Math.log10(real)).toFixed(1)} dB`;
  return Math.abs(real) >= 100 ? real.toFixed(0) : real.toFixed(2);
}

setLivePeaksHandler(setLivePeaks);
