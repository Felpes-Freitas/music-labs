// Tela ligada enquanto o Music Labs está em uso sem ninguém mexer no computador: tocando,
// gravando (REC geral, amp, Melodify, Stitcher) ou com o amp aberto ouvindo o retorno ou
// afinando. No app desktop usa o bloqueio do sistema (Electron); no navegador, a Wake Lock API.

import { audio } from './audio';
import { ampInUse } from './ui/Amp';

const busy = () => audio.status.playing || audio.recording || audio.capturing || ampInUse();

let on = false;
let lock: { release(): Promise<void> } | null = null;
let asking = false;

async function apply(want: boolean) {
  const w = window.mlabsWindow;
  if (w?.keepAwake) {
    if (want !== on) w.keepAwake(want);
    on = want;
    return;
  }
  // navegador: o sistema solta o bloqueio quando a aba some; pede de novo ao voltar
  const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void>; released: boolean }> } };
  if (!nav.wakeLock) return;
  if (want && (!lock || (lock as { released?: boolean }).released) && !asking && document.visibilityState === 'visible') {
    asking = true;
    try {
      lock = await nav.wakeLock.request('screen');
    } catch {
      lock = null;
    } finally {
      asking = false;
    }
  } else if (!want && lock) {
    const l = lock;
    lock = null;
    await l.release().catch(() => {});
  }
  on = want;
}

setInterval(() => void apply(busy()), 2000);
document.addEventListener('visibilitychange', () => void apply(busy()));
