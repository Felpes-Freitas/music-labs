// Onda ao vivo da gravação feita dentro de uma ferramenta (Melodify, Stitcher):
// cresce da esquerda para a direita conforme o áudio chega.

import { useEffect, useRef } from 'preact/hooks';
import { audio } from '../audio';
import { ui } from '../theme';

export function LiveCapture(p: { label: string; compact?: boolean; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      const cap = audio.liveCapture;
      if (!c || !cap) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (!W || !H) return;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = ui('#14191b');
      ctx.fillRect(0, 0, W, H);
      const secs = cap.frames / cap.sr;
      // a escala aumenta conforme a gravação passa do que cabe na tela
      const span = Math.max(p.compact ? 12 : 8, Math.ceil((secs + 1) / 4) * 4);
      const pxPerPeak = (W * cap.peakFrames) / (span * cap.sr);
      const mid = H / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, mid, W, 1);
      ctx.fillStyle = p.color ?? '#ff6b6b';
      const n = cap.peaks.length;
      const per = 1 / pxPerPeak;
      for (let x = 0; x < Math.min(W, n * pxPerPeak); x++) {
        let pk = 0;
        for (let i = Math.floor(x * per); i < Math.min(n, Math.floor((x + 1) * per) + 1); i++) pk = Math.max(pk, cap.peaks[i]);
        const a = Math.min(1, pk) * (mid - 4);
        ctx.fillRect(x, mid - a, 1, Math.max(1, a * 2));
      }
      const xEnd = Math.min(W - 1, n * pxPerPeak);
      ctx.fillStyle = '#fff';
      ctx.fillRect(xEnd, 0, 1.5, H);
      ctx.font = `bold ${p.compact ? 10 : 12}px sans-serif`;
      ctx.fillStyle = '#ff7070';
      const blink = Math.floor(performance.now() / 500) % 2 === 0;
      ctx.fillText(`${blink ? '●' : '○'} ${p.label} · ${secs.toFixed(1)} s`, 8, p.compact ? 13 : 20);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [p.label, p.compact]);
  return <canvas ref={ref} class={`live-cap ${p.compact ? 'compact' : ''}`} />;
}
