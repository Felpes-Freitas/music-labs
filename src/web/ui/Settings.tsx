// Janela de configurações gerais: barra lateral com as seções e o conteúdo ao lado.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { ACCENTS, themes, prefs as looks, setTheme, setAccent, setAltDrag, setTooltips, accentColor, onTheme, inkFor, type ThemeId } from '../theme';
import { getPref, setPref } from '../prefs';
import { audio, audioBuffer, AUDIO_BUFFERS, type RecChannels } from '../audio';
import { api, emit, toast } from '../state';
import { rgbPrefs, setRgbPrefs, type RgbPrefs } from '../rgb';
import { KEY_LAYOUTS, keyLayout, setKeyLayout } from '../pianokeys';

type Section = 'aparencia' | 'audio' | 'rgb' | 'bibliotecas' | 'atalhos';
const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'aparencia', label: 'Aparência', icon: 'sparkle' },
  { id: 'audio', label: 'Áudio e gravação', icon: 'wave' },
  { id: 'rgb', label: 'Iluminação RGB', icon: 'sparkle' },
  { id: 'bibliotecas', label: 'Bibliotecas', icon: 'folder' },
  { id: 'atalhos', label: 'Teclado e atalhos', icon: 'piano' },
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
            {sec === 'rgb' && <RgbSection />}
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
      <section class="set-group">
        <h3>Dicas</h3>
        <label class="set-check">
          <input type="checkbox" checked={looks.tooltips} onChange={() => (setTooltips(!looks.tooltips), emit())} />
          <span>
            <b>Dicas em balão, perto do mouse</b>
            <small>Tira a barra de dicas do topo: a explicação de cada botão aparece num balão logo acima do mouse, e os controles do topo ficam centralizados.</small>
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
      <LatencySection />
      <section class="set-group">
        <h3>Saída</h3>
        <div class="set-row">
          <span class="set-lbl">Taxa</span>
          <span>{ctx ? `${ctx.sampleRate} Hz` : 'áudio desligado'}</span>
        </div>
        <div class="set-row">
          <span class="set-lbl">Bloco do app</span>
          <select
            value={String(audioBuffer())}
            onChange={(e) => {
              setPref('audio.buffer', Number((e.target as HTMLSelectElement).value));
              toast('Bloco de áudio alterado: vale ao reabrir o Music Labs');
            }}
          >
            {AUDIO_BUFFERS.map((b) => (
              <option value={String(b)}>
                {b} amostras ({((b / 48000) * 1000).toFixed(1)} ms){b === 512 ? ' · padrão' : ''}
              </option>
            ))}
          </select>
        </div>
        <div class="set-row">
          <span class="set-lbl">Latência</span>
          <span>{ms !== null ? `${ms} ms (compensada nas gravações)` : '—'}</span>
        </div>
        <p class="set-note">Bloco do app: maior = mais folga para projetos grandes (sem picotar), mas o teclado e os pads respondem um pouco depois. Se o som picotar, aumente. O retorno do amp não muda (usa outro caminho, com atraso mínimo). Vale ao reabrir o app.</p>
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
  ['F10 · F11 · F12', 'Amp · Melodify · Stitcher'],
  ['Duplo clique num áudio da playlist', 'Abre o canal do áudio (gravação do amp: abre o amp nos pedais dela)'],
  ['Tab / Shift+Tab', 'Alternar entre as janelas abertas'],
  ['Ctrl+Z · Ctrl+Y', 'Desfazer · Refazer'],
  ['Ctrl+S', 'Salvar'],
  ['Piano roll: Ctrl+D · Ctrl+B', 'Desmarcar todas as notas · duplicar as notas selecionadas'],
  ['Ctrl+,', 'Configurações'],
  ['Z…/ · Q…]', 'Teclado musical: letras e símbolos à direita (, . ; / e [ = ])'],
  ['Page Down / Page Up', 'Oitava do teclado abaixo / acima'],
  ['Botão do meio no knob', 'Volta ao valor padrão'],
  ['Botão direito no knob ou no BPM', 'Criar automação (abre a Central de Automações)'],
  ['Duplo clique num clipe da playlist', 'Abre: pattern → rack; automação → Central de Automações; áudio → canal do áudio'],
  ['Duplo clique no nome de uma track', 'Renomear'],
  ['Alt + arrastar', 'Mover janela (se ativado em Aparência)'],
];

/** Teclado RGB pelo OpenRGB: ligar, endereço, brilho e estado da conexão. */
function RgbSection() {
  const [p, setP] = useState(rgbPrefs());
  const [st, setSt] = useState<{
    enabled?: boolean;
    state: string;
    devices: string[];
    error?: string;
    openrgb?: { supported: boolean; version: string; installed: boolean; install: { state: string; progress: number; error?: string }; managed: boolean; needsAccess: boolean; hint: string[] };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = () => api('GET', '/api/rgb').then((r) => alive && setSt(r)).catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const change = (patch: Partial<RgbPrefs>) => {
    const next = { ...p, ...patch };
    setP(next);
    setRgbPrefs(patch);
    if (patch.enabled !== undefined) setSt((x) => (x ? { ...x, enabled: patch.enabled } : x));
  };
  // ligado/desligado vale o que o servidor guardou (é ele quem decide)
  const on = st?.enabled ?? p.enabled;
  const label: Record<string, string> = { on: 'Conectado', connecting: 'Conectando…', missing: 'Não encontrado', error: 'Erro', off: 'Desligado' };
  return (
    <>
      <section class="set-group">
        <h3>Teclado RGB</h3>
        <div class="set-row">
          <span class="set-lbl">Usar</span>
          <div class="seg">
            <button class={on ? 'on' : ''} onClick={() => change({ enabled: true })}>
              Ligado
            </button>
            <button class={!on ? 'on' : ''} onClick={() => change({ enabled: false })}>
              Desligado
            </button>
          </div>
        </div>
        <div class="set-row">
          <span class="set-lbl">Estado</span>
          <span class={`rgb-state ${st?.state ?? ''}`}>
            {on ? label[st?.state ?? 'off'] ?? st?.state : 'Desligado'}
            {on && st?.state === 'on' && st.devices.length ? `: ${st.devices.join(', ')}` : ''}
            {on && st?.error ? ` — ${st.error}` : ''}
          </span>
        </div>
        <div class="set-row">
          <span class="set-lbl">Brilho</span>
          <input type="range" min={0.1} max={1} step={0.05} value={p.brightness} onChange={(e) => change({ brightness: Number((e.target as HTMLInputElement).value) })} />
          <span>{Math.round(p.brightness * 100)}%</span>
        </div>
        <div class="set-row">
          <span class="set-lbl">Servidor</span>
          <input class="rgb-host" value={p.host} onChange={(e) => change({ host: (e.target as HTMLInputElement).value.trim() || '127.0.0.1' })} />
          <input class="rgb-port" type="number" value={p.port} min={1} max={65535} onChange={(e) => change({ port: Number((e.target as HTMLInputElement).value) || 6742 })} />
        </div>
        {st?.openrgb && <OpenRgbView o={st.openrgb} busy={busy} setBusy={setBusy} connected={st.state === 'on'} />}
        <p class="set-note">
          Com um teclado RGB, as teclas acompanham o instrumento selecionado: o "piano" do teclado (Z…M e Q…P) fica com as teclas brancas em branco e as pretas na cor de destaque; num Soundpad, 1234 / QWER /
          ASDF / ZXCV ficam com as cores dos pads. A tecla tocada acende. Ao fechar o Music Labs (ou desligar aqui), o teclado volta à iluminação que tinha.
        </p>
        <p class="set-note">
          Funciona com os teclados que o <b>OpenRGB</b> controla (SteelSeries, Corsair, Razer, Logitech, HyperX, Redragon e muitos outros — openrgb.org). O Music Labs baixa o OpenRGB oficial (programa
          livre, conferido pelo SHA-256) e o roda sozinho, sem janela, só enquanto o app está aberto. Se você já usa o OpenRGB com o servidor SDK ligado (aba "SDK Server" ou{' '}
          <code>openrgb --server</code>), o Music Labs usa o seu e não baixa nada.
        </p>
      </section>
    </>
  );
}

/** OpenRGB de fábrica: baixar/instalar, estado e acesso aos dispositivos (Linux). */
function OpenRgbView({ o, busy, setBusy, connected }: { o: { supported: boolean; version: string; installed: boolean; install: { state: string; progress: number; error?: string }; managed: boolean; needsAccess: boolean; hint: string[] }; busy: boolean; setBusy: (b: boolean) => void; connected: boolean }) {
  const dl = o.install.state === 'downloading' || o.install.state === 'installing';
  return (
    <>
      <div class="set-row">
        <span class="set-lbl">OpenRGB</span>
        {o.installed ? (
          <span>
            {o.version} instalado pelo Music Labs{o.managed ? ' · rodando' : ''} <span class="dim">(abre e fecha junto com o app)</span>
          </span>
        ) : dl ? (
          <span>
            {o.install.state === 'downloading' ? `Baixando… ${Math.round(o.install.progress * 100)}%` : 'Instalando…'}
            <progress class="rgb-prog" value={o.install.progress} max={1} />
          </span>
        ) : connected ? (
          <span class="dim">usando o OpenRGB que já está rodando</span>
        ) : o.supported ? (
          <button disabled={busy} onClick={() => (setBusy(true), api('POST', '/api/rgb/install').finally(() => setBusy(false)))}>
            Baixar e ativar o OpenRGB (≈30 MB)
          </button>
        ) : (
          <span class="dim">neste sistema, instale pelo site openrgb.org e ligue o servidor SDK</span>
        )}
      </div>
      {o.install.state === 'error' && <p class="set-note">Não deu para instalar: {o.install.error}</p>}
      {o.needsAccess && (
        <div class="set-row">
          <span class="set-lbl">Acesso</span>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('POST', '/api/rgb/access');
                toast('Acesso aos dispositivos liberado');
              } catch (e) {
                toast(`Não deu: ${(e as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            Dar acesso aos dispositivos (pede a senha)
          </button>
          <span class="dim">instala as regras udev oficiais do OpenRGB</span>
        </div>
      )}
      {!!o.hint.length && !connected && <p class="set-note">Encontrado no USB: {o.hint.join(', ')}.</p>}
    </>
  );
}

function Shortcuts() {
  const [layout, setLayout] = useState(keyLayout());
  return (
    <>
    <section class="set-group">
      <h3>Teclado musical</h3>
      <div class="set-row">
        <span class="set-lbl">Teclado físico</span>
        <div class="seg">
          {KEY_LAYOUTS.map((l) => (
            <button class={layout === l.id ? 'on' : ''} data-hint={l.hint} onClick={() => (setKeyLayout(l.id), setLayout(l.id))}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <p class="set-note">
        As notas seguem a posição das teclas no teclado que você tem na mão, não o layout configurado no sistema: um teclado americano com o layout PT-BR toca as mesmas notas que um americano com layout americano. Fileira de baixo do Z até o <kbd>/</kbd> (C3), fileira de cima do Q até o <kbd>]</kbd> (C4), pretas na fileira de cima de cada uma. No ABNT2 entram também a tecla <kbd>\</kbd> ao lado do Z e a <kbd>/</kbd> ao lado do <kbd>;</kbd>.
      </p>
    </section>
    <section class="set-group">
      <h3>Atalhos</h3>
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
    </>
  );
}

// ---------------------------------------------------------------- latência

function LatencySection() {
  const [pw, setPw] = useState<{ available: boolean; quantum?: number; force?: number; rate?: number } | null>(null);
  const [cal, setCal] = useState<string>('');
  const [ms, setMs] = useState<number | null>(getPref<number | null>('rec.latencyMs', null));
  useEffect(() => {
    api('GET', '/api/latency').then(setPw).catch(() => setPw({ available: false }));
  }, []);
  const setQ = async (q: number) => setPw(await api('POST', '/api/latency', { quantum: q }));
  const ctx = (audio as any).ctx as AudioContext | undefined;
  const outMs = ctx ? Math.round(((ctx.baseLatency || 0) + ((ctx as any).outputLatency || 0)) * 1000) : null;
  const monMs = audio.monitorLatencyMs;
  const qms = (q: number) => ((q / (pw?.rate || 48000)) * 1000).toFixed(1);
  const calibrate = async () => {
    setCal('Ouça os 8 cliques…');
    try {
      const r = await audio.calibrateLatency({ deviceId: getPref<string>('rec.device', '') || undefined, channels: getPref('rec.channels', 'stereo') }, (k, n) => setCal(`Clique ${k} de ${n}…`));
      audio.recLatencyMs = r.ms;
      setPref('rec.latencyMs', r.ms);
      setMs(r.ms);
      setCal(`Medido: ${r.ms} ms (${r.hits} de 8 cliques${r.spread > 25 ? `, variação de ${r.spread} ms — se tocou junto, tente de novo com mais precisão` : ''}).`);
    } catch (e) {
      setCal(`Não deu: ${(e as Error).message}.`);
    }
  };
  return (
    <section class="set-group">
      <h3>Latência</h3>
      {pw?.available && (
        <>
          <div class="set-row">
            <span class="set-lbl">Blocos</span>
            <div class="seg">
              {[
                [0, `Sistema (${pw.quantum})`],
                [256, 'Baixa · 256'],
                [128, 'Muito baixa · 128'],
                [64, 'Extrema · 64'],
              ].map(([q, l]) => (
                <button class={(pw.force ?? 0) === q ? 'on' : ''} onClick={() => setQ(q as number)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <p class="set-note">
            O som anda em blocos: cada bloco é um atraso ({pw.quantum} amostras = {qms(pw.quantum ?? 1024)} ms). Blocos menores deixam o retorno e o metrônomo mais rápidos, mas pedem mais do processador — se começar a estalar, suba um nível. Vale enquanto o Music Labs estiver aberto; ao fechar, volta ao normal. Isto força o sistema inteiro (todos os programas); o tamanho que o próprio app pede fica em Saída → Bloco do app.
          </p>
        </>
      )}
      <div class="set-row">
        <span class="set-lbl">Agora</span>
        <span>
          saída {outMs ?? '—'} ms{monMs !== null ? ` · retorno do amp ${monMs} ms` : ''}
        </span>
      </div>
      <div class="set-row">
        <span class="set-lbl">Gravação</span>
        <span>{ms !== null ? `atraso compensado: ${ms} ms (calibrado)` : 'atraso estimado pelo sistema (pode ficar curto)'}</span>
      </div>
      <div class="set-row">
        <button class="on" onClick={calibrate}>
          Calibrar atraso da gravação
        </button>
        {ms !== null && (
          <button
            onClick={() => {
              audio.recLatencyMs = null;
              setPref('rec.latencyMs', null);
              setMs(null);
              setCal('');
            }}
          >
            Usar o estimado
          </button>
        )}
      </div>
      {cal && <p class="set-note">{cal}</p>}
      <p class="set-note">
        A calibração toca 8 cliques e mede quanto tempo eles demoram para voltar pela entrada. <b>Com caixas de som</b>: só aperte e fique em silêncio (o microfone ouve os cliques). <b>Com fone</b>: toque junto com cada clique (uma palhetada abafada na guitarra, ou uma batida perto do microfone). Depois disso, o que você grava cai em cima do tempo.
      </p>
    </section>
  );
}
