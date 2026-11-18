// Ícones próprios em SVG (traço simples, 16x16).
import type { JSX } from 'preact';

const P: Record<string, JSX.Element> = {
  play: <path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" stroke="none" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" stroke="none" />,
  record: <circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none" />,
  metronome: <path d="M5 14h6L9.5 2.5h-3zM8 11l4-6" />,
  playlist: <path d="M2 3h12M2 6.5h7M2 10h10M2 13.5h5" />,
  rack: <path d="M2.5 3h11v3h-11zM2.5 7.5h11v3h-11zM4 4.5h1M4 9h1M7 4.5h5M7 9h5" />,
  piano: <path d="M2 3h12v10H2zM5 3v6M8 3v6M11 3v6M5 9v4M8 9v4M11 9v4" />,
  mixer: <path d="M4 2v12M8 2v12M12 2v12M2.5 10h3M6.5 5h3M10.5 8h3" />,
  browser: <path d="M2 4h4l1.5 1.5H14v8H2zM2 4V3" />,
  plus: <path d="M8 3v10M3 8h10" />,
  clone: <path d="M5 5h8v8H5zM3 11V3h8" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  max: <path d="M3 3h10v10H3zM3 5.5h10" />,
  min: <path d="M3 12h10" />,
  pencil: <path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12zM9.5 4l2.5 2.5" />,
  brush: <path d="M13 3L7.5 8.5M7 9c-2 0-3 1.2-3 2.5S3 14 2 14c3 0 5.5-1 5.5-3.2z" />,
  eraser: <path d="M2.5 10.5l6-6 4.5 4.5-4 4H5zM6 13.5h8" />,
  select: <path d="M3 3h3M10 3h3v3M13 10v3h-3M6 13H3v-3M3 6V3" />,
  slice: <path d="M10 2L5 14M3 9h10" />,
  mute: <path d="M3 6h2.5L9 3v10L5.5 10H3zM11 6l3 4M14 6l-3 4" />,
  magnet: <path d="M4 3v5a4 4 0 008 0V3M4 5.5h2.5M9.5 5.5H12M6.5 3v5a1.5 1.5 0 003 0V3" />,
  zoom: <path d="M7 3a4 4 0 110 8 4 4 0 010-8zM10 10l3.5 3.5" />,
  scale: <path d="M2 13h3V9H2zM6.5 13h3V6h-3zM11 13h3V3h-3z" />,
  chord: <path d="M4 12h8M4 8.5h8M4 5h8M3 12h1M3 8.5h1M3 5h1" />,
  ghost: <path d="M4 13V7a4 4 0 018 0v6l-1.5-1.3L9 13l-1-1.3L7 13l-1.5-1.3zM6.5 7.5h.5M9 7.5h.5" />,
  follow: <path d="M3 8h8M8 5l3 3-3 3M13 3v10" />,
  undo: <path d="M5 4L2 7l3 3M2 7h7a3.5 3.5 0 010 7H6" />,
  redo: <path d="M11 4l3 3-3 3M14 7H7a3.5 3.5 0 000 7h3" />,
  save: <path d="M3 2.5h8l2.5 2.5v8.5h-11zM5 2.5v3.5h5V2.5M5 13.5v-4h6v4" />,
  folder: <path d="M2 4.5h4l1.5 1.5H14v7H2z" />,
  file: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
  wave: <path d="M1 8h2l1.5-4 2 8L8.5 3l2 10 1.5-5H15" />,
  synth: <path d="M2 11c1.5 0 1.5-6 3-6s1.5 6 3 6 1.5-6 3-6 1.5 6 3 6" />,
  drum: <path d="M3 6c0-1.3 2.2-2.5 5-2.5S13 4.7 13 6v4c0 1.3-2.2 2.5-5 2.5S3 11.3 3 10zM3 6c0 1.3 2.2 2.5 5 2.5S13 7.3 13 6" />,
  project: <path d="M5 12V4l8-1.5V11M5 12a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0zM13 11a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0z" />,
  flp: <path d="M4 2h5l3 3v9H4zM6 8h4M6 10.5h4" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  loop: <path d="M3 9V7a3 3 0 013-3h7M11 2l2 2-2 2M13 7v2a3 3 0 01-3 3H3M5 14l-2-2 2-2" />,
  scope: <path d="M1 8c2 0 2-5 4-5s2 10 4 10 2-5 4-5h2" />,
  cpu: <path d="M4 4h8v8H4zM6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" />,
  fx: <path d="M3 13l2-10h4M3.5 8h4M9 7l4 6M13 7l-4 6" />,
  settings: <path d="M8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />,
  help: <path d="M6 6a2 2 0 114 0c0 1.5-2 1.5-2 3M8 11.5v.5" />,
  sparkle: <path d="M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z" />,
};

export function Icon(p: { name: keyof typeof P | string; size?: number; class?: string }) {
  const s = p.size ?? 14;
  return (
    <svg class={`ico ${p.class ?? ''}`} width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      {P[p.name] ?? P.help}
    </svg>
  );
}
