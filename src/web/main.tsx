import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import './style.css';
import { useApp, emit, state, togglePlay, setMode, undo, redo, openWindow, cycleWindows, fitWindows, api, toast } from './state';
import { audio } from './audio';
import { TitleBar, Toolbar } from './ui/Toolbar';
import { ChannelRack } from './ui/ChannelRack';
import { PianoRoll } from './ui/PianoRoll';
import { Playlist } from './ui/Playlist';
import { Mixer } from './ui/Mixer';
import { ChannelSettings } from './ui/ChannelSettings';
import { Browser, addSampleChannel } from './ui/Browser';
import { DialogHost, dialogOpen } from './ui/Dialog';
import { applyTheme, onTheme, prefs as looks } from './theme';

applyTheme();
onTheme(() => emit());
// Alt segurado: cursor de mover sobre as janelas
const altCursor = (on: boolean) => document.body.classList.toggle('alt-drag', on && looks.altDrag);
window.addEventListener('keydown', (e) => e.key === 'Alt' && altCursor(true));
window.addEventListener('keyup', (e) => e.key === 'Alt' && altCursor(false));
window.addEventListener('blur', () => altCursor(false));

// Teclado do computador como piano (duas fileiras, como em muitos DAWs).
const KEYMAP: Record<string, number> = {
  z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59, ',': 60,
  q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71, i: 72, '9': 73, o: 74, '0': 75, p: 76,
};
const held = new Map<string, { ch: string; key: number }>();
let octave = 0;

/** Só campos onde se digita texto ficam com o teclado; o resto toca o instrumento. */
function isTextField(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'color'].includes((el as HTMLInputElement).type);
  return false;
}

function onKeyDown(e: KeyboardEvent) {
  if (dialogOpen()) return;
  const t = e.target as HTMLElement;
  if (isTextField(t)) {
    if (e.key === 'Enter' || e.key === 'Escape') (t as HTMLElement).blur();
    return;
  }
  // um <select> focado não rouba as teclas: devolve o foco ao app
  if (t.tagName === 'SELECT') (t as HTMLElement).blur();
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleWindows(e.shiftKey);
    return;
  }
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k === 'z') return (e.preventDefault(), e.shiftKey ? redo() : undo());
  if (ctrl && k === 'y') return (e.preventDefault(), redo());
  if (ctrl && k === 's') {
    e.preventDefault();
    api('POST', '/api/save', {}).then((r) => toast(`Salvo em ${r.path}`)).catch((err) => toast(`Erro: ${err.message}`));
    return;
  }
  if (e.key === ' ') return (e.preventDefault(), togglePlay());
  if (e.key === 'F5') return (e.preventDefault(), openWindow('playlist', true));
  if (e.key === 'F6') return (e.preventDefault(), openWindow('rack', true));
  if (e.key === 'F7') return (e.preventDefault(), openWindow('piano', true));
  if (e.key === 'F8') return (e.preventDefault(), openWindow('browser', true));
  if (e.key === 'F9') return (e.preventDefault(), openWindow('mixer', true));
  if (ctrl || e.altKey) return;
  if (k === 'l' && !e.repeat) return setMode(state.mode === 'pattern' ? 'song' : 'pattern');
  if (k === '-' ) return (octave = Math.max(-3, octave - 1), toast(`Oitava do teclado: ${octave >= 0 ? '+' : ''}${octave}`));
  if (k === '=' ) return (octave = Math.min(3, octave + 1), toast(`Oitava do teclado: ${octave >= 0 ? '+' : ''}${octave}`));
  if (k in KEYMAP && !e.repeat && state.channelId) {
    const key = KEYMAP[k] + octave * 12;
    held.set(k, { ch: state.channelId, key });
    audio.liveOn(state.channelId, key, 0.85);
  }
}
function onKeyUp(e: KeyboardEvent) {
  const h = held.get(e.key.toLowerCase());
  if (h) {
    audio.liveOff(h.ch, h.key);
    held.delete(e.key.toLowerCase());
  }
}

// Botões, sliders, caixas e listas não guardam o foco depois de usados: assim o
// teclado continua tocando o instrumento selecionado, não importa onde se clicou.
const releaseFocus = () =>
  setTimeout(() => {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && !isTextField(a) && a.tagName !== 'SELECT') a.blur();
  }, 0);
window.addEventListener('pointerup', releaseFocus);
window.addEventListener('change', (e) => {
  const t = e.target as HTMLElement;
  if (!isTextField(t)) setTimeout(() => t.blur(), 0);
});
// botão do meio é "voltar ao padrão" nos knobs: sem a rolagem automática do navegador
window.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());

// Se a janela perde o foco com teclas apertadas, solta todas (evita nota presa).
window.addEventListener('blur', () => {
  for (const [k, h] of held) {
    audio.liveOff(h.ch, h.key);
    held.delete(k);
  }
});

// Teclado MIDI (Web MIDI) toca o canal selecionado.
async function setupMidi() {
  if (!('requestMIDIAccess' in navigator)) return;
  try {
    const midi = await navigator.requestMIDIAccess();
    const bind = () =>
      midi.inputs.forEach((inp) => {
        inp.onmidimessage = (m) => {
          const [st, d1, d2] = m.data as Uint8Array;
          const cmd = st & 0xf0;
          const ch = state.channelId;
          if (!ch) return;
          if (cmd === 0x90 && d2 > 0) audio.liveOn(ch, d1, d2 / 127);
          else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) audio.liveOff(ch, d1);
        };
      });
    bind();
    midi.onstatechange = bind;
  } catch {
    /* sem MIDI */
  }
}

function LoadingScreen() {
  const s = useApp();
  if (!s.loading && !s.needsClick) return null;
  const l = s.loading;
  const pct = l && l.total ? Math.round((l.done / l.total) * 100) : 0;
  return (
    <div class="loading" onPointerDown={() => s.needsClick && audio.resume().then((ok) => ok && ((state.needsClick = false), toast('Áudio ligado')))}>
      <div class="loading-box">
        <div class="logo">
          <span class="logo-dot" />
          MUSIC LABS
        </div>
        {l ? (
          <>
            <div class="loading-title">Carregando o projeto</div>
            <div class="loading-bar">
              <div style={{ width: `${l.total ? pct : 8}%` }} class={l.total && !(l.done >= l.total && l.pending) ? '' : 'indeterminate'} />
            </div>
            <div class="loading-label">
              {l.total ? `${l.done} de ${l.total} samples${l.label ? ' · ' + l.label : ''}` : 'Preparando o áudio…'}
              {l.total && l.done >= l.total && l.pending ? ' · preparando instrumentos…' : ''}
            </div>
          </>
        ) : (
          <>
            <div class="loading-title">Tudo carregado</div>
            <div class="loading-label">O navegador pediu um clique antes de tocar som: clique em qualquer lugar.</div>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  const s = useApp();
  // as janelas acompanham o tamanho real da área de trabalho
  useEffect(() => {
    const ws = document.querySelector('.workspace') as HTMLElement;
    const ro = new ResizeObserver(() => fitWindows(ws.clientWidth, ws.clientHeight));
    ro.observe(ws);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    setupMidi();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
  return (
    <div class="app">
      <TitleBar />
      <Toolbar />
      <div class="main">
        <Browser />
        <div
          class="workspace"
          onDragOver={(e) => e.dataTransfer?.types.includes('text/x-batuque-sample') && e.preventDefault()}
          onDrop={(e) => {
            const path = e.dataTransfer?.getData('text/x-batuque-sample');
            if (path) {
              e.preventDefault();
              addSampleChannel(path);
            }
          }}
        >
          <Playlist />
          <ChannelRack />
          <PianoRoll />
          <Mixer />
          <ChannelSettings />

        </div>
      </div>
      <LoadingScreen />
      <DialogHost />
      <div class="toasts">
        {s.toasts.map((t) => (
          <div class={`toast ${t.from === 'mcp' ? 'mcp' : ''}`} key={t.id}>
            {t.from === 'mcp' && <b>Claude · </b>}
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
