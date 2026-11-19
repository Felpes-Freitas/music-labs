import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, previewEdit, onLive, selectPattern, openWindow, setMode, act, setHint } from '../state';
import { audio } from '../audio';
import { PPQ, patternLength, songLength, ticksPerBar, uid, isPatternClip, type Clip, type AutoTarget } from '../../core/model';
import { set, ins, rem } from '../../core/ops';
import * as A from '../../core/actions';
import { Win, IconBtn, useCanvas } from './widgets';
import { askText } from './Dialog';
import { openTune } from './Tune';
import { Picker } from './Picker';
import { addStitchTakes } from './Stitch';

/** Janela de ferramenta (Stitcher/Afinador) embaixo do ponteiro, se houver. */
const toolAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('.win-stitch .tool, .win-tune .tool') as HTMLElement | null) ?? null;
import { ui, accent } from '../theme';

const HEADW = 120;
const RULER = 22;

type Drag =
  | { kind: 'move'; id: string; x0: number; y0: number; orig: Clip; dup: boolean }
  | { kind: 'resize'; id: string; x0: number; orig: Clip }
  | { kind: 'point'; id: string; idx: number; orig: Clip }
  | { kind: 'erase' }
  | { kind: 'seek' }
  | { kind: 'loop'; t0: number };

export function Playlist() {
  const s = useApp();
  const p = s.project;
  const view = useRef({ scrollX: 0, scrollY: 0, zx: 0.12, rowH: 34 });
  const [snapBeats, setSnapBeats] = useState(true);
  const [tool, setTool] = useState<'draw' | 'erase' | 'slice' | 'mute'>('draw');
  const drag = useRef<Drag | null>(null);
  const playTick = useRef(-1);
  const bar = ticksPerBar(p);
  const snap = snapBeats ? PPQ : bar;

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
      const t0 = Math.floor(v.scrollX / PPQ) * PPQ;
      for (let t = t0; tx(t) < w; t += PPQ) {
        const x = Math.round(tx(t)) + 0.5;
        if (x < HEADW) continue;
        const isBar = t % bar === 0;
        if (!isBar && v.zx * PPQ < 6) continue;
        ctx.strokeStyle = isBar ? ui('#3d474d') : ui('#2a3135');
        ctx.beginPath();
        ctx.moveTo(x, RULER);
        ctx.lineTo(x, h);
        ctx.stroke();
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
      ctx.fillStyle = ui('#2d3539');
      ctx.fillRect(0, 0, HEADW, RULER);
      ctx.fillStyle = ui('#889');
      ctx.fillText('Tracks', 8, 15);
    },
    [s.version],
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
      if (x >= cx && x <= cx + cw && y >= cy && y < cy + v.rowH) return { c, edge: x > cx + cw - 6 };
    }
    return null;
  };
  const clipOps = (c: Clip): ReturnType<typeof set>[] => [set(['clips', c.id], c)];

  const onDown = (e: PointerEvent) => {
    const [x, y] = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (y < RULER) {
      if (x < HEADW) return;
      if (e.shiftKey || e.button === 2) {
        const t0 = Math.round(tickAt(x) / bar) * bar;
        drag.current = { kind: 'loop', t0 };
        return;
      }
      drag.current = { kind: 'seek' };
      seek(x);
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
          if (near >= 0 && pts.length > 1) edit([set(['clips', c.id, 'points'], pts.filter((_, i) => i !== near))]);
          return;
        }
        let idx = near;
        if (idx < 0) {
          const t = Math.max(0, Math.min(c.len, Math.round((x - tx(c.pos)) / v.zx)));
          const val = Math.max(0, Math.min(1, 1 - (y - top) / hh));
          const next = [...pts, { t, v: val }].sort((a, b) => a.t - b.t);
          idx = next.findIndex((pt) => pt.t === t && pt.v === val);
          previewEdit([set(['clips', c.id, 'points'], next)]);
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
      const at = Math.round(tickAt(x) / snap) * snap;
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
        edit([set(['clips', c.id, 'len'], cut), set(['clips', c.id, 'points'], first), ins(['clips'], { ...c, id: uid('k'), pos: at, len: c.len - cut, points: rest })]);
      } else {
        const pat = p.patterns.find((q) => q.id === c.patternId);
        const plen = pat ? patternLength(p, pat) : c.len;
        const second = { ...c, id: uid('k'), pos: at, len: c.len - cut, offset: (c.offset + cut) % plen };
        edit([set(['clips', c.id, 'len'], cut), ins(['clips'], second)]);
      }
      return;
    }
    if (h) {
      if (isPatternClip(h.c)) selectPattern(h.c.patternId);
      if (e.detail === 2 && h.c.kind === 'audio') {
        openTune(h.c.id);
        return;
      }
      if (e.detail === 2 && isPatternClip(h.c)) {
        openWindow('rack');
        return;
      }
      if (h.edge) drag.current = { kind: 'resize', id: h.c.id, x0: x, orig: { ...h.c } };
      else drag.current = { kind: 'move', id: h.c.id, x0: x, y0: y, orig: { ...h.c }, dup: e.shiftKey };
      if (e.shiftKey) {
        // Shift+arrastar duplica o clip
        const copy = { ...h.c, id: uid('k') };
        edit([ins(['clips'], copy)]);
        drag.current = { kind: 'move', id: copy.id, x0: x, y0: y, orig: copy, dup: true };
      }
      return;
    }
    // novo clip do pattern selecionado
    const pat = p.patterns.find((x) => x.id === s.patternId);
    const track = trackAt(y);
    if (!pat || track < 0 || track >= p.tracks.length) return;
    const pos = Math.max(0, Math.floor(tickAt(x) / snap) * snap);
    const c: Clip = { id: uid('k'), track, pos, len: patternLength(p, pat), patternId: pat.id, offset: 0 };
    edit([ins(['clips'], c)]);
    drag.current = { kind: 'move', id: c.id, x0: x, y0: y, orig: c, dup: false };
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
    const d = drag.current;
    if (!d) {
      const h = y > RULER && x > HEADW ? hit(x, y) : null;
      (e.currentTarget as HTMLElement).style.cursor = h ? (h.edge ? 'ew-resize' : 'move') : y < RULER ? 'text' : 'crosshair';
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
      const tool = d.orig.kind === 'audio' && !d.dup ? toolAt(e.clientX, e.clientY) : null;
      document.querySelectorAll('.tool.dropping').forEach((el) => el !== tool && el.classList.remove('dropping'));
      tool?.classList.add('dropping');
      const dt = Math.round((x - d.x0) / v.zx / snap) * snap;
      const dtr = Math.round((y - d.y0) / v.rowH);
      const c = { ...d.orig, pos: Math.max(0, d.orig.pos + dt), track: Math.max(0, Math.min(p.tracks.length - 1, d.orig.track + dtr)) };
      previewEdit(clipOps(c));
    } else if (d.kind === 'resize') {
      const end = Math.round((d.orig.pos + d.orig.len + (x - d.x0) / v.zx) / snap) * snap;
      previewEdit(clipOps({ ...d.orig, len: Math.max(snap, end - d.orig.pos) }));
    } else if (d.kind === 'erase') {
      const h = hit(x, y);
      if (h) edit([rem(['clips', h.c.id])]);
    } else if (d.kind === 'seek') seek(x);
    else if (d.kind === 'loop') {
      const t1 = Math.round(tickAt(x) / bar) * bar;
      const [a, b] = [Math.min(d.t0, t1), Math.max(d.t0, t1)];
      previewEdit([set(['loop'], b > a ? { start: a, end: b } : null)]);
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
    if (d.kind === 'point') {
      const c = state.project.clips.find((x) => x.id === d.id);
      if (c) edit([set(['clips', c.id, 'points'], c.points ?? [])]);
      return;
    }
    if (d.kind === 'move' || d.kind === 'resize') {
      const c = state.project.clips.find((x) => x.id === d.id);
      if (c) edit(clipOps(c));
    } else if (d.kind === 'loop') edit([set(['loop'], state.project.loop ?? null)]);
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
            <IconBtn icon="magnet" label={snapBeats ? 'tempo' : 'compasso'} hint="Snap da playlist: tempo ou compasso" onClick={() => setSnapBeats(!snapBeats)} />
            <IconBtn icon="follow" on={s.followPlay} hint="Seguir a reprodução" onClick={() => ((state.followPlay = !state.followPlay), paint())} />
            <IconBtn icon="plus" label="track" hint="Adicionar track" onClick={() => edit([ins(['tracks'], { id: uid('t'), name: `Track ${p.tracks.length + 1}`, color: '#888', mute: false })])} />
          </span>
        </span>
      }
    >
      <div class="pl-wrap">
        <Picker />
        <canvas
          ref={ref}
          class="pl-canvas"
          onPointerDown={onDown as any}
          onPointerMove={onMove as any}
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

/** Contorno do arquivo, se já carregado (senão começa a carregar e repinta depois). */
function peaksFor(path: string) {
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

function fmtAuto(t: AutoTarget, v: number) {
  const real = t.log && t.min > 0 ? t.min * Math.pow(t.max / t.min, v) : t.min + v * (t.max - t.min);
  if (t.path[t.path.length - 1] === 'volume') return real <= 0.0001 ? '-∞ dB' : `${(20 * Math.log10(real)).toFixed(1)} dB`;
  return Math.abs(real) >= 100 ? real.toFixed(0) : real.toFixed(2);
}
