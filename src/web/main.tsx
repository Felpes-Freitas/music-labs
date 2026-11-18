import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import './style.css';
import { useApp, state, togglePlay, setMode, undo, redo, openWindow, api, toast } from './state';
import { audio } from './audio';
import { Toolbar } from './ui/Toolbar';
import { ChannelRack } from './ui/ChannelRack';
import { PianoRoll } from './ui/PianoRoll';
import { Playlist } from './ui/Playlist';
import { Mixer } from './ui/Mixer';
import { ChannelSettings } from './ui/ChannelSettings';
import { Browser, addSampleChannel } from './ui/Browser';

// Teclado do computador como piano (duas fileiras, como em muitos DAWs).
const KEYMAP: Record<string, number> = {
  z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59, ',': 60,
  q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71, i: 72, '9': 73, o: 74, '0': 75, p: 76,
};
const held = new Map<string, { ch: string; key: number }>();
let octave = 0;

function onKeyDown(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea')) return;
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

function App() {
  const s = useApp();
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
          {!audio.running && (
            <div class="audio-hint" onClick={() => audio.start().then(() => toast('Áudio ligado'))}>
              Clique para ligar o áudio
            </div>
          )}
        </div>
      </div>
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
