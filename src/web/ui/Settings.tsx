// Janela de configurações gerais: barra lateral com as seções e o conteúdo ao lado.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { ACCENTS, themes, prefs as looks, setTheme, setAccent, setAltDrag, accentColor, onTheme, inkFor, type ThemeId } from '../theme';
import { getPref, setPref } from '../prefs';
import { audio, type RecChannels } from '../audio';
import { api, emit, toast } from '../state';

type Section = 'aparencia' | 'audio' | 'bibliotecas' | 'atalhos';
const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'aparencia', label: 'Aparência', icon: 'sparkle' },
  { id: 'audio', label: 'Áudio e gravação', icon: 'wave' },
  { id: 'bibliotecas', label: 'Bibliotecas', icon: 'folder' },
  { id: 'atalhos', label: 'Atalhos', icon: 'piano' },
];

let open: Section | null = null;
const listeners = new Set<() => void>();
export function openSettings(s: Section = 'aparencia') {
  open = s;
  listeners.forEach((l) => l());
}
export const settingsOpen = () => open !== null;
function close() {
  open = null;
  listeners.forEach((l) => l());
}

export function SettingsHost() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const l = () => force(undefined);
    listeners.add(l);
    const off = onTheme(l);
    return () => (listeners.delete(l), off());
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  const sec = open;
  return (
    <div class="set-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="set-win" role="dialog">
        <nav class="set-side">
          <div class="set-side-title">Configurações</div>
          {SECTIONS.map((s) => (
            <button class={`set-nav ${s.id === sec ? 'on' : ''}`} onClick={() => openSettings(s.id)}>
              <Icon name={s.icon} size={14} />
              {s.label}
            </button>
          ))}
        </nav>
        <div class="set-main">
          <header class="set-head">
            <h2>{SECTIONS.find((s) => s.id === sec)!.label}</h2>
            <button class="win-btn win-close" data-hint="Fechar (Esc)" onClick={close}>
              <Icon name="close" size={12} />
            </button>
          </header>
          <div class="set-body">
            {sec === 'aparencia' && <Appearance />}
            {sec === 'audio' && <AudioSection />}
            {sec === 'bibliotecas' && <Libraries />}
            {sec === 'atalhos' && <Shortcuts />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- aparência

const PREVIEW: Record<ThemeId, string[]> = {
  grafite: ['#121618', '#232a2e', '#343e44'],
  oled: ['#000000', '#09090a', '#18181b'],
  adobe: ['#1e1e1e', '#323232', '#444444'],
};

function Appearance() {
  const custom = !!looks.accent && !ACCENTS.some((a) => a.color === looks.accent);
  const [picker, setPicker] = useState(custom);
  return (
    <>
      <section class="set-group">
        <h3>Tema</h3>
        <div class="theme-cards">
          {themes().map((t) => {
            const [bg, panel, hi] = PREVIEW[t.id];
            return (
              <button class={`theme-card ${looks.theme === t.id ? 'on' : ''}`} data-hint={t.hint} onClick={() => setTheme(t.id)}>
                <div class="theme-prev" style={{ background: bg }}>
                  <div style={{ background: panel, left: '8px', top: '8px', width: '62%', height: '58%' }} />
                  <div style={{ background: hi, left: '8px', top: '8px', width: '62%', height: '9px' }} />
                  <div style={{ background: panel, right: '8px', top: '8px', width: '22%', height: '78%' }} />
                  <div class="acc" style={{ left: '14px', bottom: '10px' }} />
                </div>
                <span>{t.name}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section class="set-group">
        <h3>Cor de destaque</h3>
        <div class="swatches">
          <button class={`swatch-def ${looks.accent === null ? 'on' : ''}`} onClick={() => (setAccent(null), setPicker(false))} data-hint="Usa o destaque que acompanha o tema">
            Padrão do tema
          </button>
          {ACCENTS.map((a) => (
            <button class={`swatch ${looks.accent === a.color ? 'on' : ''}`} style={{ background: a.color }} data-hint={a.name} onClick={() => (setAccent(a.color), setPicker(false))} />
          ))}
          <button class={`swatch custom ${custom || picker ? 'on' : ''}`} style={custom ? { background: looks.accent! } : undefined} data-hint="Cor personalizada" onClick={() => setPicker(!picker)}>
            {!custom && <Icon name="plus" size={12} />}
          </button>
        </div>
        {picker && <ColorPicker value={accentColor()} onChange={(c) => setAccent(c)} />}
      </section>
      <section class="set-group">
        <h3>Janelas</h3>
        <label class="set-check" data-hint="Segure Alt e arraste qualquer ponto de uma janela para movê-la (Alt + botão direito redimensiona)">
          <input type="checkbox" checked={looks.altDrag} onChange={() => (setAltDrag(!looks.altDrag), emit())} />
          <span>
            <b>Alt + arrastar move janelas</b>
            <small>Segurando Alt, qualquer ponto da janela serve para arrastá-la; com o botão direito, redimensiona.</small>
          </span>
        </label>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- seletor de cor (HSV)

function ColorPicker(p: { value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(p.value));
  const [text, setText] = useState(p.value);
  const raf = useRef(0);
  const push = (next: [number, number, number]) => {
    setHsv(next);
    const hex = hsvToHex(...next);
    setText(hex);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => p.onChange(hex));
  };
  const drag = (e: PointerEvent, fn: (fx: number, fy: number) => void) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const at = (ev: PointerEvent) => fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => (el.removeEventListener('pointermove', move), el.removeEventListener('pointerup', up));
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const [h, s, v] = hsv;
  const hex = hsvToHex(h, s, v);
  return (
    <div class="cpick">
      <div
        class="cpick-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(h, 1, 1)})` }}
        onPointerDown={(e) => drag(e as any, (fx, fy) => push([h, fx, 1 - fy]))}
      >
        <div class="cpick-dot" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: hex }} />
      </div>
      <div class="cpick-side">
        <div class="cpick-hue" onPointerDown={(e) => drag(e as any, (fx) => push([fx * 360, s, v]))}>
          <div class="cpick-knob" style={{ left: `${(h / 360) * 100}%`, background: hsvToHex(h, 1, 1) }} />
        </div>
        <div class="cpick-prev" style={{ background: hex, color: inkFor(hex) }}>
          Aa
        </div>
        <label class="cpick-hex">
          <span>HEX</span>
          <input
            type="text"
            value={text}
            spellcheck={false}
            onInput={(e) => {
              const t = (e.target as HTMLInputElement).value.trim();
              setText(t);
              const m = t.replace('#', '');
              if (/^[0-9a-f]{6}$/i.test(m)) {
                setHsv(hexToHsv('#' + m));
                p.onChange('#' + m.toLowerCase());
              }
            }}
          />
        </label>
      </div>
    </div>
  );
}

function hsvToHex(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

// ---------------------------------------------------------------- áudio

function AudioSection() {
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [device, setDevice] = useState(getPref<string>('rec.device', ''));
  const [chans, setChans] = useState<RecChannels>(getPref<RecChannels>('rec.channels', 'stereo'));
  const load = () => audio.inputDevices().then(setDevices).catch(() => setDevices([]));
  useEffect(() => {
    load();
  }, []);
  const askPermission = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      load();
    } catch (e) {
      toast(`Sem acesso às entradas de áudio: ${(e as Error).message}`);
    }
  };
  const ctx = (audio as any).ctx as AudioContext | undefined;
  const ms = ctx ? Math.round(((ctx.baseLatency || 0) + ((ctx as any).outputLatency || 0)) * 1000) : null;
  const unnamed = devices.length > 0 && devices.every((d) => d.label.startsWith('Entrada '));
  return (
    <>
      <section class="set-group">
        <h3>Gravação</h3>
        <div class="set-row">
          <span class="set-lbl">Entrada</span>
          <select
            value={device}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setDevice(v);
              setPref('rec.device', v);
            }}
          >
            <option value="">Padrão do sistema</option>
            {devices.filter((d) => d.id && d.id !== 'default').map((d) => (
              <option value={d.id}>{d.label}</option>
            ))}
          </select>
          {unnamed && <button onClick={askPermission}>Mostrar nomes</button>}
        </div>
        <div class="set-row">
          <span class="set-lbl">Canais</span>
          <div class="seg">
            {(
              [
                ['stereo', 'Estéreo'],
                ['left', 'Só entrada 1'],
                ['right', 'Só entrada 2'],
              ] as [RecChannels, string][]
            ).map(([k, l]) => (
              <button
                class={chans === k ? 'on' : ''}
                onClick={() => {
                  setChans(k);
                  setPref('rec.channels', k);
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <p class="set-note">Para guitarra ou microfone ligados numa entrada só da interface, escolha "Só entrada 1" (ou 2): o som vai para os dois lados em vez de ficar só num. A gravação usa o sinal limpo, sem cancelamento de eco nem controle automático de volume.</p>
        <p class="set-note">Os arquivos ficam em <code>~/MusicLabs/Gravações</code>.</p>
      </section>
      <section class="set-group">
        <h3>Saída</h3>
        <div class="set-row">
          <span class="set-lbl">Taxa</span>
          <span>{ctx ? `${ctx.sampleRate} Hz` : 'áudio desligado'}</span>
        </div>
        <div class="set-row">
          <span class="set-lbl">Latência</span>
          <span>{ms !== null ? `${ms} ms (compensada nas gravações)` : '—'}</span>
        </div>
        <p class="set-note">Parar: o primeiro clique para a música; com tudo parado, outro clique corta também o que ainda soa (caudas de reverb, ecos e notas soltas).</p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- bibliotecas e atalhos

function Libraries() {
  return (
    <section class="set-group">
      <h3>Samples das DAWs instaladas</h3>
      <p class="set-note">Na primeira vez o app procura as pastas de samples de DAWs conhecidas (inclusive dentro do Wine) e as mostra no navegador. Rode de novo depois de instalar packs ou outra DAW.</p>
      <div class="set-row">
        <button onClick={() => api('POST', '/api/library/rescan', {}).then(() => toast('Procurando samples das DAWs instaladas…'))}>Varrer bibliotecas agora</button>
      </div>
    </section>
  );
}

const KEYS: [string, string][] = [
  ['Espaço', 'Tocar / parar'],
  ['L', 'Alternar pattern / song'],
  ['F5 · F6 · F7 · Alt+F8 · F9', 'Playlist · Rack · Piano roll · Navegador · Mixer'],
  ['Tab / Shift+Tab', 'Alternar entre as janelas abertas'],
  ['Ctrl+Z · Ctrl+Y', 'Desfazer · Refazer'],
  ['Ctrl+S', 'Salvar'],
  ['Ctrl+,', 'Configurações'],
  ['Z…M · Q…P', 'Teclado musical (duas oitavas)'],
  ['- / =', 'Oitava abaixo / acima'],
  ['Botão do meio no knob', 'Volta ao valor padrão'],
  ['Botão direito no knob', 'Criar clipe de automação'],
  ['Alt + arrastar', 'Mover janela (se ativado em Aparência)'],
];

function Shortcuts() {
  return (
    <section class="set-group">
      <table class="keys">
        {KEYS.map(([k, d]) => (
          <tr>
            <td>
              <kbd>{k}</kbd>
            </td>
            <td>{d}</td>
          </tr>
        ))}
      </table>
    </section>
  );
}
