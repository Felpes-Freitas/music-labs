// Aparência: temas (cores de fundo, painéis, bordas, texto) e cor de destaque
// escolhida à parte. Os temas trocam variáveis CSS; os desenhos em canvas usam
// ui() para remapear os tons neutros e accent() para a cor de destaque.
// As preferências ficam no próprio computador (localStorage), não no projeto.

import { getPref, setPref } from './prefs';

export type ThemeId = 'grafite' | 'oled' | 'adobe';

interface Theme {
  id: ThemeId;
  name: string;
  hint: string;
  accent: string; // destaque padrão do tema
  vars: Record<string, string>;
  /** Remapeamento da luminosidade dos tons neutros dos canvas: pares [entrada, saída]. */
  curve: [number, number][];
  /** Saturação dos neutros (1 = mantém o tom azulado original, 0 = cinza puro). */
  sat: number;
}

// tema original: grafite azulado
const GRAFITE: Record<string, string> = {
  '--bg': '#121618',
  '--bg2': '#171c1f',
  '--ws': '#1d2326',
  '--panel': '#232a2e',
  '--panel2': '#2b3338',
  '--panel3': '#343e44',
  '--line': '#3b464c',
  '--line2': '#0b0e10',
  '--edge': '#0f1315',
  '--text': '#dfe4e7',
  '--text2': '#c9d1d5',
  '--head': '#9fb0b8',
  '--dim': '#8e9aa1',
  '--dim2': '#66737a',
  '--btn1': '#323b41',
  '--btn2': '#2a3237',
  '--btn-h1': '#3b464c',
  '--btn-h2': '#323b41',
  '--btn-down': '#262d31',
  '--btn-shine': 'rgba(255,255,255,0.05)',
  '--input': '#1a1f22',
  '--well': '#14191b',
  '--deep': '#0b0e10',
  '--pop': '#2a3237',
  '--hover': '#26303a',
  '--sel': '#2c3a46',
  '--title1': '#3a454b',
  '--title2': '#2e373c',
  '--titlef1': '#45525a',
  '--titlef2': '#343e44',
  '--bar1': '#323b41',
  '--bar2': '#262d31',
  '--appbar1': '#262e33',
  '--appbar2': '#1d2327',
  '--rack': '#1d2326',
  '--row': '#232a2e',
  '--row-line': '#1a1f22',
  '--row-sel': '#2b353b',
  '--row-sel-line': '#46525a',
  '--step1': '#59646a',
  '--step2': '#49535a',
  '--step-alt1': '#6b5a52',
  '--step-alt2': '#5a4b44',
  '--card1': '#262e33',
  '--card2': '#20272b',
  '--strip1': '#2c3439',
  '--strip2': '#252c30',
  '--mixer': '#1b2023',
  '--side': '#20272b',
  '--cfx': '#1a2023',
  '--winbar': '#252c30',
  '--knob': '#262e33',
  '--knob-track': '#161b1e',
  '--knob-ptr': '#f1f3f4',
  '--hint-text': '#a9d6c2',
  '--scroll': '#46525a',
  '--grip': '#5b6a72',
  '--shadow': 'rgba(0,0,0,0.55)',
  '--veil': 'rgba(10,13,15,0.86)',
  '--rad': '3px',
  '--win-rad': '5px',
  '--win-glow': '0 0 0 1px color-mix(in srgb, var(--acc) 25%, transparent)',
};

const THEMES: Theme[] = [
  {
    id: 'grafite',
    name: 'Grafite',
    hint: 'Tema original: cinza-azulado com relevo suave',
    accent: '#f2a93b',
    vars: GRAFITE,
    curve: [[0, 0], [1, 1]],
    sat: 1,
  },
  {
    // preto de verdade nos fundos, superfícies em camadas quase pretas separadas
    // por bordas finas; nada de branco puro em blocos nem contorno grosso
    id: 'oled',
    name: 'OLED',
    hint: 'Preto de verdade, camadas sutis e bordas finas (ótimo em telas OLED)',
    accent: '#7c8cff',
    vars: {
      ...GRAFITE,
      '--bg': '#000000',
      '--bg2': '#030303',
      '--ws': '#050506',
      '--panel': '#09090a',
      '--panel2': '#101012',
      '--panel3': '#18181b',
      '--line': '#232327',
      '--line2': '#19191c',
      '--edge': '#151517',
      '--text': '#ececef',
      '--text2': '#c8c8cd',
      '--head': '#8b8b94',
      '--dim': '#8a8a93',
      '--dim2': '#5c5c64',
      '--btn1': '#121214',
      '--btn2': '#121214',
      '--btn-h1': '#1b1b1f',
      '--btn-h2': '#1b1b1f',
      '--btn-down': '#0b0b0c',
      '--btn-shine': 'transparent',
      '--input': '#060607',
      '--well': '#030303',
      '--deep': '#000000',
      '--pop': '#0c0c0e',
      '--hover': '#141417',
      '--sel': 'color-mix(in srgb, var(--acc) 16%, #0a0a0b)',
      '--title1': '#09090a',
      '--title2': '#09090a',
      '--titlef1': '#0e0e10',
      '--titlef2': '#0e0e10',
      '--bar1': '#050506',
      '--bar2': '#050506',
      '--appbar1': '#000000',
      '--appbar2': '#000000',
      '--rack': '#000000',
      '--row': '#09090a',
      '--row-line': '#131315',
      '--row-sel': '#111114',
      '--row-sel-line': 'color-mix(in srgb, var(--acc) 45%, #222)',
      '--step1': '#202024',
      '--step2': '#1a1a1e',
      '--step-alt1': '#2a2522',
      '--step-alt2': '#221e1c',
      '--card1': '#09090a',
      '--card2': '#09090a',
      '--strip1': '#09090a',
      '--strip2': '#09090a',
      '--mixer': '#000000',
      '--side': '#040405',
      '--cfx': '#040405',
      '--winbar': '#070708',
      '--knob': '#141417',
      '--knob-track': '#1f1f23',
      '--knob-ptr': '#ffffff',
      '--hint-text': '#9d9da6',
      '--scroll': '#2a2a2f',
      '--grip': '#3a3a41',
      '--shadow': 'rgba(0,0,0,0.9)',
      '--veil': 'rgba(0,0,0,0.88)',
      '--rad': '5px',
      '--win-rad': '8px',
      '--win-glow': '0 0 0 1px color-mix(in srgb, var(--acc) 35%, transparent), 0 0 24px color-mix(in srgb, var(--acc) 10%, transparent)',
    },
    curve: [[0, 0], [0.06, 0], [0.1, 0.025], [0.16, 0.05], [0.22, 0.09], [0.3, 0.15], [0.42, 0.26], [0.6, 0.5], [1, 1]],
    sat: 0.1,
  },
  {
    // cinzas neutros dos apps da Adobe (Photoshop escuro), destaque azul
    id: 'adobe',
    name: 'Adobe',
    hint: 'Cinzas neutros no estilo do Photoshop, cantos arredondados e destaque azul',
    accent: '#378ef0',
    vars: {
      ...GRAFITE,
      '--bg': '#1e1e1e',
      '--bg2': '#2b2b2b',
      '--ws': '#262626',
      '--panel': '#323232',
      '--panel2': '#393939',
      '--panel3': '#444444',
      '--line': '#4a4a4a',
      '--line2': '#1c1c1c',
      '--edge': '#242424',
      '--text': '#e3e3e3',
      '--text2': '#cfcfcf',
      '--head': '#a8a8a8',
      '--dim': '#9a9a9a',
      '--dim2': '#747474',
      '--btn1': '#3e3e3e',
      '--btn2': '#3a3a3a',
      '--btn-h1': '#4a4a4a',
      '--btn-h2': '#454545',
      '--btn-down': '#2c2c2c',
      '--btn-shine': 'rgba(255,255,255,0.03)',
      '--input': '#262626',
      '--well': '#1e1e1e',
      '--deep': '#161616',
      '--pop': '#383838',
      '--hover': '#424242',
      '--sel': 'color-mix(in srgb, var(--acc) 30%, #323232)',
      '--title1': '#2b2b2b',
      '--title2': '#2b2b2b',
      '--titlef1': '#353535',
      '--titlef2': '#353535',
      '--bar1': '#2b2b2b',
      '--bar2': '#2b2b2b',
      '--appbar1': '#1f1f1f',
      '--appbar2': '#1f1f1f',
      '--rack': '#2b2b2b',
      '--row': '#383838',
      '--row-line': '#2a2a2a',
      '--row-sel': '#444444',
      '--row-sel-line': '#5c5c5c',
      '--step1': '#5c5c5c',
      '--step2': '#535353',
      '--step-alt1': '#6a605a',
      '--step-alt2': '#5d5550',
      '--card1': '#383838',
      '--card2': '#353535',
      '--strip1': '#393939',
      '--strip2': '#343434',
      '--mixer': '#282828',
      '--side': '#2e2e2e',
      '--cfx': '#2b2b2b',
      '--winbar': '#333333',
      '--knob': '#3e3e3e',
      '--knob-track': '#1e1e1e',
      '--knob-ptr': '#f2f2f2',
      '--hint-text': '#bdbdbd',
      '--scroll': '#5a5a5a',
      '--grip': '#6e6e6e',
      '--shadow': 'rgba(0,0,0,0.5)',
      '--veil': 'rgba(20,20,20,0.82)',
      '--rad': '4px',
      '--win-rad': '6px',
      '--win-glow': '0 0 0 1px color-mix(in srgb, var(--acc) 45%, transparent)',
    },
    curve: [[0, 0.06], [0.06, 0.11], [0.1, 0.15], [0.16, 0.2], [0.22, 0.26], [0.3, 0.32], [0.42, 0.42], [0.6, 0.6], [1, 1]],
    sat: 0,
  },
];

export const ACCENTS: { name: string; color: string }[] = [
  { name: 'Âmbar', color: '#f2a93b' },
  { name: 'Azul', color: '#378ef0' },
  { name: 'Índigo', color: '#7c8cff' },
  { name: 'Ciano', color: '#3ec7e8' },
  { name: 'Verde', color: '#3ecf8e' },
  { name: 'Lima', color: '#a6e22e' },
  { name: 'Violeta', color: '#a77bff' },
  { name: 'Rosa', color: '#ff5c9a' },
  { name: 'Vermelho', color: '#ff5d5d' },
];

export const themes = () => THEMES.map(({ id, name, hint }) => ({ id, name, hint }));

// ---------------------------------------------------------------- preferências

interface Prefs {
  theme: ThemeId;
  accent: string | null; // null = destaque padrão do tema
  altDrag: boolean;
  /** Dicas em tooltip perto do mouse (sem a barra de dicas no topo). */
  tooltips: boolean;
}
function load(): Prefs {
  const p = getPref<Partial<Prefs>>('aparencia', {});
  return { theme: THEMES.some((t) => t.id === p.theme) ? p.theme! : 'grafite', accent: typeof p.accent === 'string' ? p.accent : null, altDrag: p.altDrag !== false, tooltips: p.tooltips === true };
}
export const prefs: Prefs = load();
const save = () => setPref('aparencia', { ...prefs });

const listeners = new Set<() => void>();
/** Avisa quando a aparência muda (para repintar canvas). Retorna o cancelamento. */
export function onTheme(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
/** Muda a cada troca de tema ou de destaque: use nas dependências de desenhos. */
export let themeRev = 0;

const current = () => THEMES.find((t) => t.id === prefs.theme)!;
export const accentColor = () => prefs.accent ?? current().accent;

export function setTheme(id: ThemeId) {
  prefs.theme = id;
  save();
  applyTheme();
}
export function setAccent(color: string | null) {
  prefs.accent = color;
  save();
  applyTheme();
}
export function setAltDrag(on: boolean) {
  prefs.altDrag = on;
  save();
}
export function setTooltips(on: boolean) {
  prefs.tooltips = on;
  save();
}

/** Aplica o tema e o destaque no documento. */
export function applyTheme() {
  const t = current();
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  const acc = accentColor();
  root.style.setProperty('--acc', acc);
  root.style.setProperty('--acc-ink', inkFor(acc));
  root.dataset.theme = t.id;
  cache.clear();
  themeRev++;
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- cores para canvas

const cache = new Map<string, string>();

/** Remapeia um tom neutro do tema original para o tema atual (cores vivas passam direto). */
export function ui(hex: string): string {
  if (prefs.theme === 'grafite') return hex;
  const hit = cache.get(hex);
  if (hit) return hit;
  const [h, s, l] = hsl(hex);
  let out = hex;
  if (s < 0.3) {
    const t = current();
    out = hslHex(h, s * t.sat, interp(t.curve, l));
  }
  cache.set(hex, out);
  return out;
}

/** Cor de destaque, opcionalmente clareada (+) ou escurecida (−) entre −1 e 1. */
export function accent(shift = 0): string {
  const acc = accentColor();
  if (!shift) return acc;
  const key = `acc${shift}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [r, g, b] = rgb(acc);
  const to = shift > 0 ? 255 : 0, k = Math.abs(shift);
  const out = hexOf(r + (to - r) * k, g + (to - g) * k, b + (to - b) * k);
  cache.set(key, out);
  return out;
}

/** Texto legível sobre a cor de destaque. */
export function inkFor(hex: string) {
  const [r, g, b] = rgb(hex).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.32 ? '#14110a' : '#ffffff';
}

export const isHex = (s: string) => /^#?[0-9a-f]{6}$/i.test(s.trim());

function interp(curve: [number, number][], x: number) {
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-6, x1 - x0);
  }
  return curve[curve.length - 1][1];
}

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexOf(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}
function hsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslHex(h: number, s: number, l: number) {
  if (!s) return hexOf(l * 255, l * 255, l * 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return hexOf(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
}
