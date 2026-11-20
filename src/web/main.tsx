import { AutoCenterWindow } from './ui/AutoCenter';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './style.css';
import { useApp, emit, state, togglePlay, setMode, undo, redo, openWindow, cycleWindows, fitWindows, api, toast, onLive } from './state';
import { audio } from './audio';
import { TitleBar, Toolbar } from './ui/Toolbar';
import { ChannelRack } from './ui/ChannelRack';
import { PianoRoll } from './ui/PianoRoll';
import { Playlist } from './ui/Playlist';
import { Mixer } from './ui/Mixer';
import { ChannelSettings } from './ui/ChannelSettings';
import { AmpWindow } from './ui/Amp';
import { TuneWindow, toggleTunePreview } from './ui/Tune';
import { StitchWindow, toggleStitchPreview } from './ui/Stitch';
import { Browser, addSampleChannel } from './ui/Browser';
import { DialogHost, dialogOpen } from './ui/Dialog';
import { SettingsHost, settingsOpen, openSettings } from './ui/Settings';
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
  if ((e.ctrlKey || e.metaKey) && e.key === ',') return (e.preventDefault(), openSettings());
  if (settingsOpen()) return;
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
  if (e.key === ' ') {
    e.preventDefault();
    // com o Afinador ou o Stitcher em foco, o Espaço toca o áudio deles (não a música)
    const top = (Object.entries(state.windows) as [string, { open: boolean; z: number }][]).filter(([, w]) => w.open).sort((x, y) => y[1].z - x[1].z)[0]?.[0];
    if (top === 'tune') return toggleTunePreview();
    if (top === 'stitch') return toggleStitchPreview();
    return togglePlay();
  }
  if (e.key === 'F5') return (e.preventDefault(), openWindow('playlist', true));
  if (e.key === 'F6') return (e.preventDefault(), openWindow('rack', true));
  if (e.key === 'F7') return (e.preventDefault(), openWindow('piano', true));
  if (e.key === 'F8') return (e.preventDefault(), openWindow('browser', true));
  if (e.key === 'F9') return (e.preventDefault(), openWindow('mixer', true));
  if (e.key === 'F10') return (e.preventDefault(), openWindow('amp', true));
  if (e.key === 'F11') return (e.preventDefault(), openWindow('tune', true));
  if (e.key === 'F12') return (e.preventDefault(), openWindow('stitch', true));
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

/** Logo que se preenche: o anel acompanha o carregamento (null = indeterminado) e a onda se desenha em loop. */
function LogoMark(p: { progress: number | null }) {
  const done = p.progress === 100;
  return (
    <svg class={`logomark ${p.progress === null ? 'spin' : ''} ${done ? 'done' : ''}`} viewBox="0 0 120 120" width="132" height="132">
      <circle class="lm-track" cx="60" cy="60" r="44" />
      <circle class="lm-ring" cx="60" cy="60" r="44" pathLength={100} style={{ strokeDashoffset: `${100 - (p.progress ?? 25)}` }} />
      <circle class="lm-hole" cx="60" cy="60" r="28" />
      <path class="lm-wave" pathLength={100} d="M33 60 C39 44, 49 42, 53 56 C56 66, 58 71, 60 71 C62 71, 64 66, 67 56 C71 42, 81 44, 87 60" />
    </svg>
  );
}

/** "4, 3, 2, 1" grande enquanto a contagem antes da gravação roda. */
function CountInOverlay() {
  const s = useApp();
  const [n, setN] = useState(0);
  useEffect(() => onLive((st) => setN(st.countIn)), []);
  const v = n || s.countdown;
  if (!v) return null;
  return (
    <div class="countin" key={v}>
      {v}
    </div>
  );
}

function LoadingScreen() {
  const s = useApp();
  if (!s.loading && !s.needsClick) return null;
  const l = s.loading;
  const pct = l && l.total ? Math.round((l.done / l.total) * 100) : 0;
  return (
    <div class="loading" onPointerDown={() => s.needsClick && audio.resume().then((ok) => ok && ((state.needsClick = false), toast('Áudio ligado')))}>
      <div class="loading-box">
        <LogoMark progress={l ? (l.total && !(l.done >= l.total && l.pending) ? pct : null) : 100} />
        <h1 class="brand">
          <span class="brand-a">MUSIC</span>
          <span class="brand-b">LABS</span>
        </h1>
        {l ? (
          <>
            <div class="loading-title">{l.total ? `Carregando o projeto · ${pct}%` : 'Carregando o projeto'}</div>
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
          onDragOver={(e) => e.dataTransfer?.types.includes('text/x-musiclabs-sample') && e.preventDefault()}
          onDrop={(e) => {
            const path = e.dataTransfer?.getData('text/x-musiclabs-sample');
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
          <AmpWindow />
          <TuneWindow />
          <StitchWindow />
          <AutoCenterWindow />

        </div>
      </div>
      <LoadingScreen />
      <CountInOverlay />
      <SettingsHost />
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
