// Teclado RGB (OpenRGB): a interface diz ao servidor como pintar o teclado do computador.
// Instrumento comum: as teclas do "piano" (Z…M e Q…P) — brancas em branco, pretas na cor
// de destaque; Soundpad: 1234/QWER/ASDF/ZXCV nas cores dos pads. Só repinta
// quando a cena muda e nenhuma tecla está apertada (ver sendScene).
// O servidor fala com o OpenRGB e devolve o teclado ao normal quando o app fecha.

import { state, onState, onConnect, sendServer, api, toast } from './state';
import { askConfirm } from './ui/Dialog';
import { getPref, setPref } from './prefs';
import { accentColor } from './theme';
import { PAD_COUNT, padColor, padKey } from '../core/pads';

export interface RgbPrefs {
  enabled: boolean;
  host: string;
  port: number;
  brightness: number;
}
// desligado até o usuário ligar (em alguns teclados o controle pelo OpenRGB atrapalhou a digitação)
export const rgbPrefs = (): RgbPrefs => ({ enabled: false, host: '127.0.0.1', port: 6742, brightness: 1, ...getPref<Partial<RgbPrefs>>('rgb', {}) });
export function setRgbPrefs(p: Partial<RgbPrefs>) {
  setPref('rgb', { ...rgbPrefs(), ...p });
  sendConfig(p.enabled !== undefined); // ligar/desligar é escolha explícita
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

/** Teclas do computador apertadas agora: o teclado não é repintado enquanto houver alguma. */
const held = new Set<string>();
let lastScene = '';
let timer: ReturnType<typeof setTimeout> | null = null;

function sendConfig(explicit = false) {
  const p = rgbPrefs();
  sendServer({ type: 'rgb', explicit, config: { enabled: p.enabled, host: p.host, port: p.port, brightness: p.brightness } });
}
/**
 * Repinta o teclado só quando a cena muda (troca de instrumento, cor de destaque) e nunca
 * com tecla apertada: em alguns teclados (SteelSeries Apex) cada atualização de LEDs reinicia
 * a iluminação e o teclado perde o "soltou a tecla" que chega nesse instante — a nota ficava
 * presa. Por isso também não há mais "tecla tocada acende".
 */
function sendScene() {
  if (!rgbPrefs().enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (held.size) return; // tenta de novo quando soltar tudo
    const scene = { keys: sceneKeys(), base: BASE, pressed: [] };
    const sig = JSON.stringify(scene);
    if (sig === lastScene) return;
    lastScene = sig;
    sendServer({ type: 'rgb', scene });
  }, 400);
}

/** Tecla do computador apertada/solta: só segura a repintura enquanto houver tecla apertada. */
export function rgbKey(key: string, on: boolean) {
  const k = key.toLowerCase();
  if (on) held.add(k);
  else if (held.delete(k) && !held.size) sendScene();
}
/** Solta tudo (janela perdeu o foco). */
export function rgbKeysReleased() {
  held.clear();
  sendScene();
}

onConnect(() => {
  lastScene = '';
  sendConfig();
  sendScene();
  setTimeout(offerOpenRgb, 5000);
});

/**
 * Primeira vez: se há um periférico de marca RGB plugado (ou, fora do Linux, onde não dá
 * para saber) e nenhum OpenRGB rodando, pergunta uma vez se pode baixar o OpenRGB.
 */
async function offerOpenRgb() {
  if (getPref<boolean>('rgb.offered', false) || getPref<Partial<RgbPrefs>>('rgb', {}).enabled === false) return;
  if (state.loading) return void setTimeout(offerOpenRgb, 3000); // espera a tela de carregamento
  let st: { state: string; openrgb?: { platform: string; supported: boolean; installed: boolean; hint: string[] } };
  try {
    st = await api('GET', '/api/rgb');
  } catch {
    return;
  }
  const o = st.openrgb;
  if (!o?.supported || o.installed || st.state === 'on') return;
  if (o.platform === 'linux' && !o.hint.length) return; // nada RGB plugado: não incomoda
  setPref('rgb.offered', true);
  const found = o.hint.length ? `Encontrei ${o.hint.join(', ')}. ` : '';
  const yes = await askConfirm({
    title: 'Teclado RGB',
    message: `${found}O Music Labs pode acender as teclas do seu teclado RGB conforme o instrumento (o piano do teclado, as cores dos pads) e devolvê-lo ao normal quando você fechar o app. Para isso ele baixa o OpenRGB (programa livre, ≈30 MB, versão oficial conferida), que roda só enquanto o Music Labs está aberto. Dá para mudar depois em Configurações → Iluminação RGB.`,
    ok: 'Baixar e ativar',
  });
  if (!yes) return;
  setRgbPrefs({ enabled: true });
  await api('POST', '/api/rgb/install').catch(() => {});
  toast('Baixando o OpenRGB… o teclado acende quando terminar');
}
// canal selecionado, pads, cor de destaque: repinta quando muda algo (só envia se a cena mudou)
onState(() => sendScene());
