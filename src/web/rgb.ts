// Teclado RGB (OpenRGB): a interface diz ao servidor como pintar o teclado do computador.
// Instrumento comum: as teclas do "piano" (Z…M e Q…P) — brancas em branco, pretas na cor
// de destaque; Soundpad: 1234/QWER/ASDF/ZXCV nas cores dos pads. A tecla tocada acende.
// O servidor fala com o OpenRGB e devolve o teclado ao normal quando o app fecha.

import { state, onState, onConnect, sendServer } from './state';
import { getPref, setPref } from './prefs';
import { accentColor } from './theme';
import { PAD_COUNT, padColor, padKey } from '../core/pads';

export interface RgbPrefs {
  enabled: boolean;
  host: string;
  port: number;
  brightness: number;
}
export const rgbPrefs = (): RgbPrefs => ({ enabled: true, host: '127.0.0.1', port: 6742, brightness: 1, ...getPref<Partial<RgbPrefs>>('rgb', {}) });
export function setRgbPrefs(p: Partial<RgbPrefs>) {
  setPref('rgb', { ...rgbPrefs(), ...p });
  sendConfig();
  lastScene = '';
  sendScene();
}

/** Teclado do computador como piano (o mesmo mapa de main.tsx): tecla → nota. */
const PIANO: Record<string, number> = {
  z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59, ',': 60,
  q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71, i: 72, '9': 73, o: 74, '0': 75, p: 76,
};
const BLACK = new Set([1, 3, 6, 8, 10]);
const hex = (c: string) => parseInt(c.replace('#', '').slice(0, 6), 16) || 0;
const WHITE_KEY = 0xd8dde4;
const BASE = 0x080808;

/** Cores das teclas para o canal selecionado. */
export function sceneKeys(): Record<string, number> {
  const ch = state.channelId ? state.project.channels.find((c) => c.id === state.channelId) : undefined;
  const keys: Record<string, number> = {};
  if (ch?.type === 'pads') {
    for (let i = 0; i < PAD_COUNT; i++) keys[padKey(i)] = hex(padColor(i));
    return keys;
  }
  const acc = hex(accentColor());
  for (const [k, note] of Object.entries(PIANO)) keys[k] = BLACK.has(note % 12) ? acc : WHITE_KEY;
  // trocar de oitava
  keys['-'] = keys['='] = (acc >> 1) & 0x7f7f7f;
  return keys;
}

const pressed = new Set<string>();
let lastScene = '';

function sendConfig() {
  const p = rgbPrefs();
  sendServer({ type: 'rgb', config: { enabled: p.enabled, host: p.host, port: p.port, brightness: p.brightness } });
}
function sendScene() {
  if (!rgbPrefs().enabled) return;
  const scene = { keys: sceneKeys(), base: BASE, pressed: [...pressed] };
  const sig = JSON.stringify(scene);
  if (sig === lastScene) return;
  lastScene = sig;
  sendServer({ type: 'rgb', scene });
}

/** Tecla do computador apertada/solta (acende no teclado). */
export function rgbPress(key: string, on: boolean) {
  const k = key.toLowerCase();
  if (on) pressed.add(k);
  else pressed.delete(k);
  sendScene();
}
/** Acende uma tecla por um instante (pad clicado ou tocado pela música). */
export function rgbFlash(key: string, ms = 120) {
  rgbPress(key, true);
  setTimeout(() => rgbPress(key, false), ms);
}

onConnect(() => {
  lastScene = '';
  sendConfig();
  sendScene();
});
// canal selecionado, pads, cor de destaque: repinta quando muda algo (só envia se a cena mudou)
onState(() => sendScene());
