import { createAutomation, BPM_TARGET } from '../autos';
import { useEffect, useRef, useState } from 'preact/hooks';
import { toggleLoop, toggleMetronome, toggleCountIn } from '../state';
import { midiRecording } from '../midirec';
import { tapBpm, TAP_RESET_MS } from '../../core/tempo';
import { useApp, useHint, state, play, stop, toggleRecord, setMode, selectPattern, act, edit, previewEdit, undo, redo, openWindow, api, toast, onLive, emit, type WindowId } from '../state';
import { audio } from '../audio';
import * as A from '../../core/actions';
import { INSTRUMENTS, PRESETS } from '../../core/registry';
import { PPQ, PROJECT_EXT, STEP, ticksPerBar, type InstrumentType } from '../../core/model';
import { set } from '../../core/ops';
import { Knob, IconBtn, dbFmt, ContextMenu } from './widgets';
import { Icon } from './icons';
import { askConfirm, askText } from './Dialog';
import { openSettings } from './Settings';
import { ui, accent, prefs as looks } from '../theme';

// ---------------------------------------------------------------- ações de arquivo

/** Pasta dos projetos (onde o explorador de arquivos abre). */
const projectsDir = () => api('GET', '/api/projects').then((r) => r.dir as string).catch(() => undefined);

export async function saveProject(as = false) {
  const s = state;
  if (as || !s.path) {
    const w = window.mlabsWindow;
    if (w?.saveDialog) {
      // app desktop: o "Salvar como" do sistema
      const dir = s.path ? s.path.replace(/[\\/][^\\/]*$/, '') : await projectsDir();
      const target = await w.saveDialog({ title: 'Salvar projeto', defaultPath: dir ? `${dir}/${s.project.name}${PROJECT_EXT}` : `${s.project.name}${PROJECT_EXT}`, filters: [{ name: 'Projeto do Music Labs', extensions: ['mlstudio'] }] });
      if (!target) return;
      const r = await api('POST', '/api/save', { path: target.endsWith(PROJECT_EXT) ? target : target + PROJECT_EXT });
      return toast(`Salvo em ${r.path}`);
    }
    const name = await askText({ title: 'Salvar como', label: 'Nome do projeto', value: s.project.name, ok: 'Salvar' });
    if (!name) return;
    edit([set(['name'], name)]);
    const r = await api('POST', '/api/save', { path: `${name}${PROJECT_EXT}` });
    toast(`Salvo em ${r.path}`);
  } else {
    const r = await api('POST', '/api/save', {});
    toast(`Salvo em ${r.path}`);
  }
}

export async function exportWav() {
  const p = state.project;
  toast('Renderizando…');
  try {
    const r = await api('POST', '/api/render', { mode: p.clips.length ? 'song' : 'pattern', pattern: state.patternId });
    toast(`WAV: ${r.file} · ${r.analysis.integratedLufs} LUFS · pico ${r.analysis.peakDb} dB`);
  } catch (e) {
    toast(`Erro: ${(e as Error).message}`);
  }
}

async function newProject(template: 'kit' | 'empty') {
  if (state.dirty && !(await askConfirm({ title: 'Criar projeto novo?', message: 'As alterações não salvas do projeto atual serão perdidas.', ok: 'Criar', danger: true }))) return;
  await api('POST', '/api/new', { template });
}

/** Escolhe um projeto (.mlstudio) ou um .flp no explorador de arquivos e abre. */
async function importPath() {
  if (state.dirty && !(await askConfirm({ title: 'Abrir outro projeto?', message: 'As alterações não salvas do projeto atual serão perdidas.', ok: 'Abrir', danger: true }))) return;
  let path: string | null = null;
  const w = window.mlabsWindow;
  try {
    if (w?.openDialog) {
      path = await w.openDialog({
        title: 'Abrir projeto',
        defaultPath: await projectsDir(),
        filters: [
          { name: 'Projetos (.mlstudio, .flp)', extensions: ['mlstudio', 'flp'] },
          { name: 'Music Labs', extensions: ['mlstudio'] },
          { name: 'FL Studio', extensions: ['flp'] },
        ],
      });
    } else {
      // navegador: o seletor de arquivos; o arquivo vai para ~/MusicLabs/Importados e abre de lá
      const f = await new Promise<File | null>((ok) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.mlstudio,.flp';
        inp.onchange = () => ok(inp.files?.[0] ?? null);
        inp.click();
      });
      if (f) {
        const r = await fetch(`/api/import?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        path = d.path;
      }
    }
    if (!path) return;
    const r = await api('POST', '/api/open', { path });
    if (r.imported) toast(`Importado: ${r.imported.channels} canais, ${r.imported.patterns} patterns, ${r.imported.notes} notas`);
  } catch (e) {
    toast(`Erro: ${(e as Error).message}`);
  }
}

async function analyze() {
  toast('Analisando a mix…');
  try {
    const r = await api('POST', '/api/render', { save: false, mode: state.project.clips.length ? 'song' : 'pattern', pattern: state.patternId });
    const a = r.analysis;
    toast(`${a.integratedLufs} LUFS · pico ${a.peakDb} dB · crest ${a.crestDb} dB · correlação ${a.stereoCorrelation}${a.notes.length ? ' · ' + a.notes.join(' ') : ''}`);
  } catch (e) {
    toast(`Erro: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- menus

type Item = { label: string; key?: string; run?: () => void; sub?: Item[]; sep?: boolean; on?: boolean; swatch?: string; hint?: string };

function menus(): Record<string, Item[] | (() => void)> {
  const s = state;
  const pat = s.project.patterns.find((x) => x.id === s.patternId);
  const addChannel = (args: any) => {
    const r = act(A.addChannel, args);
    if (r) {
      state.channelId = r.id;
      emit();
    }
  };
  return {
    Arquivo: [
      { label: 'Novo (com bateria)', key: 'Ctrl+N', run: () => newProject('kit') },
      { label: 'Novo vazio', run: () => newProject('empty') },
      { label: 'Abrir / importar .flp…', key: 'Ctrl+O', run: importPath },
      { sep: true, label: '' },
      { label: 'Salvar', key: 'Ctrl+S', run: () => saveProject() },
      { label: 'Salvar como…', key: 'Ctrl+Shift+S', run: () => saveProject(true) },
      { sep: true, label: '' },
      { label: 'Exportar WAV', key: 'Ctrl+R', run: exportWav },
    ],
    Editar: [
      { label: 'Desfazer', key: 'Ctrl+Z', run: undo },
      { label: 'Refazer', key: 'Ctrl+Y', run: redo },
    ],
    Adicionar: [
      ...(Object.keys(INSTRUMENTS) as InstrumentType[]).filter((t) => t !== 'audio').map((t) => ({ label: INSTRUMENTS[t].label, run: () => addChannel({ type: t }) })),
      { sep: true, label: '' },
      { label: 'Presets', sub: Object.keys(PRESETS).map((k) => ({ label: k, run: () => addChannel({ preset: k }) })) },
    ],
    Patterns: [
      { label: 'Novo pattern', key: 'F4', run: () => { const r = act(A.addPattern, {}); if (r) selectPattern(r.id); } },
      { label: 'Clonar pattern', run: () => { const r = pat && act(A.duplicatePattern, { pattern: pat.id }); if (r) selectPattern(r.id); } },
      { label: 'Renomear pattern…', key: 'F2', run: async () => { const n = pat && (await askText({ title: 'Renomear pattern', label: 'Nome', value: pat.name, ok: 'Renomear' })); if (n && pat) act(A.updatePattern, { pattern: pat.id, name: n }); } },
      { label: 'Excluir pattern', run: async () => pat && s.project.patterns.length > 1 && (await askConfirm({ title: `Excluir ${pat.name}?`, message: 'O pattern e os clips dele na playlist serão removidos.', ok: 'Excluir', danger: true })) && act(A.removePattern, { pattern: pat.id }) },
    ],
    Exibir: [
      { label: 'Playlist', key: 'F5', on: s.windows.playlist.open, run: () => openWindow('playlist', true) },
      { label: 'Rack de canais', key: 'F6', on: s.windows.rack.open, run: () => openWindow('rack', true) },
      { label: 'Piano roll', key: 'F7', on: s.windows.piano.open, run: () => openWindow('piano', true) },
      { label: 'Navegador', key: 'Alt+F8', on: s.windows.browser.open, run: () => openWindow('browser', true) },
      { label: 'Mixer', key: 'F9', on: s.windows.mixer.open, run: () => openWindow('mixer', true) },
      { label: 'Amp de guitarra', key: 'F10', on: s.windows.amp.open, run: () => openWindow('amp', true) },
      { label: 'Melodify', key: 'F11', on: s.windows.tune.open, run: () => openWindow('tune', true) },
      { label: 'Stitcher', key: 'F12', on: s.windows.stitch.open, run: () => openWindow('stitch', true) },
    ],
    Aparência: () => openSettings('aparencia'),
    Opções: [
      { label: 'Configurações…', key: 'Ctrl+,', run: () => openSettings('aparencia') },
      { sep: true, label: '' },
      { label: 'Seguir a reprodução', on: s.followPlay, run: () => ((state.followPlay = !state.followPlay), emit()) },
      { label: 'Ligar o áudio', run: () => audio.start().then(() => toast('Áudio ligado')) },
      { label: 'Pânico (cortar todas as notas)', run: () => audio.post({ type: 'panic' }) },
      { sep: true, label: '' },
      {
        label: 'Varrer bibliotecas de samples (DAWs instaladas)',
        run: () => api('POST', '/api/library/rescan', {}).then(() => toast('Procurando samples das DAWs instaladas…')),
      },
    ],
    Ferramentas: [
      { label: 'Analisar a mix', run: analyze },
      { label: 'Quantizar canal atual', key: 'Ctrl+Q', run: () => pat && s.channelId && act(A.transformNotes, { pattern: pat.id, channel: s.channelId, quantize: Math.max(1, s.snap) / PPQ }) },
    ],
    Ajuda: [
      { label: 'Atalhos: Espaço tocar · L pattern/song · F5–F9 janelas · Ctrl+Z/Y · Z…M e Q…P = teclado musical · - / = oitava', run: () => {} },
      { label: 'MCP: o Claude edita o projeto ao vivo (ferramentas "musiclabs")', run: () => {} },
    ],
  };
}

function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest('.menubar')) setOpen(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const m = menus();
  const run = (it: Item) => {
    if (it.sub) return;
    setOpen(null);
    it.run?.();
  };
  return (
    <div class="menubar">
      {Object.entries(m).map(([name, items]) => (
        <div class={`menu ${open === name ? 'open' : ''}`} onPointerEnter={() => open && setOpen(name)}>
          <button class="menu-btn" onClick={() => (typeof items === 'function' ? (setOpen(null), items()) : setOpen(open === name ? null : name))}>
            {name}
          </button>
          {open === name && typeof items !== 'function' && (
            <div class="menu-drop">
              {items.map((it) =>
                it.sep ? (
                  <div class="menu-sep" />
                ) : (
                  <div class={`menu-item ${it.sub ? 'has-sub' : ''}`} data-hint={it.hint} onClick={() => run(it)} onPointerEnter={() => setSub(it.sub ? it.label : null)}>
                    <span class="menu-check">{it.on ? '✓' : ''}</span>
                    {it.swatch && <span class="menu-swatch" style={{ background: it.swatch }} />}
                    <span class="menu-label">{it.label}</span>
                    {it.key && <span class="menu-key">{it.key}</span>}
                    {it.sub && <Icon name="chevron" size={10} />}
                    {it.sub && sub === it.label && (
                      <div class="menu-drop sub">
                        {it.sub.map((x) =>
                          x.sep ? (
                            <div class="menu-sep" />
                          ) : (
                            <div class="menu-item" data-hint={x.hint} onClick={(e) => (e.stopPropagation(), run(x))}>
                              <span class="menu-check">{x.on ? '✓' : ''}</span>
                              {x.swatch && <span class="menu-swatch" style={{ background: x.swatch }} />}
                              <span class="menu-label">{x.label}</span>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function HintBar() {
  const h = useHint();
  return <div class="hintbar">{h || ' '}</div>;
}

const mouse = { x: 0, y: 0 };
/** O mouse está numa área em que fica quase o tempo todo (a playlist): a dica vai para o canto. */
let mouseOnCanvas = false;
const CORNER = '.pl-canvas';
/** Espera antes do balão aparecer. */
const TIP_DELAY = 750;

/**
 * Dica em balão logo acima do mouse (Configurações → Aparência → Dicas em balão). Na
 * playlist, onde o mouse passa a maior parte do tempo, a dica fica parada no canto
 * inferior direito (como o endereço de um link no navegador), sem seguir o mouse.
 */
export function HintTooltip() {
  useApp();
  const h = useHint();
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [corner, setCorner] = useState(false);
  const place = () => {
    const el = ref.current;
    if (!el || mouseOnCanvas) return;
    const w = el.offsetWidth, hh = el.offsetHeight;
    let top = mouse.y - hh - 14;
    if (top < 4) top = mouse.y + 22; // sem espaço em cima: embaixo do mouse
    el.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, mouse.x - w / 2))}px`;
    el.style.top = `${top}px`;
  };
  useEffect(() => {
    const mv = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      const on = !!(e.target as Element | null)?.closest?.(CORNER);
      if (on !== mouseOnCanvas) {
        mouseOnCanvas = on;
        setCorner(on);
      }
      place();
    };
    const down = () => setShow(false);
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerdown', down);
    window.addEventListener('wheel', down);
    return () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('wheel', down);
    };
  }, []);
  // balão: aparece depois de um instante parado sobre a mesma coisa
  useEffect(() => {
    setShow(false);
    if (!h || !looks.tooltips || corner) return;
    const t = setTimeout(() => setShow(true), TIP_DELAY);
    return () => clearTimeout(t);
  }, [h, corner]);
  useEffect(() => {
    if (show) place();
  }, [show, h]);
  if (!looks.tooltips || !h) return null;
  if (corner) return <div class="hint-corner">{h}</div>;
  if (!show) return null;
  return (
    <div ref={ref} class="hint-tip">
      {h}
    </div>
  );
}

// ---------------------------------------------------------------- transporte

function Position() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onLive((s) => {
        if (!ref.current) return;
        const bar = ticksPerBar(state.project);
        const t = s.tick;
        const b = Math.floor(t / bar) + 1;
        const st = Math.floor((t % bar) / STEP) + 1;
        const tk = Math.floor(t % STEP);
        ref.current.textContent = `${String(b).padStart(3, ' ')}:${String(st).padStart(2, '0')}:${String(tk).padStart(2, '0')}`;
      }),
    [],
  );
  return (
    <span ref={ref} class="lcd pos" data-hint="Posição: compasso : step : tick">
      {'  1:01:00'}
    </span>
  );
}

/** Osciloscópio + medidor do master. */
function Scope() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const buf = new Float32Array(1024);
    let peakL = 0, peakR = 0;
    const off = onLive((s) => {
      const m = s.meters[0] ?? [0, 0];
      peakL = Math.max(m[0], peakL * 0.85);
      peakR = Math.max(m[1], peakR * 0.85);
    });
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      if (!c) return;
      const ctx = c.getContext('2d')!;
      const w = c.width, h = c.height;
      ctx.fillStyle = ui('#0c1012');
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = ui('#1f2a2f');
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w - 14, h / 2);
      ctx.stroke();
      const an = audio.analyser;
      if (an) {
        an.getFloatTimeDomainData(buf);
        ctx.strokeStyle = '#59d6a0';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        const n = 512;
        for (let i = 0; i < n; i++) {
          const x = (i / n) * (w - 16);
          const y = h / 2 - buf[i] * (h / 2 - 2);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      const bar = (v: number, x: number) => {
        const db = 20 * Math.log10(Math.max(v, 1e-5));
        const y = Math.max(0, Math.min(1, (db + 48) / 48)) * h;
        ctx.fillStyle = db > -0.5 ? '#ff5d5d' : db > -6 ? '#e8c547' : '#59d6a0';
        ctx.fillRect(x, h - y, 5, y);
      };
      bar(peakL, w - 13);
      bar(peakR, w - 6);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, []);
  return <canvas ref={ref} width={130} height={34} class="scope" data-hint="Osciloscópio e pico do master" />;
}

let taps: number[] = [];
let tapTimer = 0;
let tapFrom = 0;
/** Tap tempo: cada clique marca um tempo; o BPM segue a média dos cliques (um passo de desfazer). */
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > TAP_RESET_MS) taps = [];
  if (!taps.length) tapFrom = state.project.bpm;
  taps.push(now);
  const bpm = tapBpm(taps);
  clearTimeout(tapTimer);
  if (bpm === null) return toast('Tap tempo: continue clicando no ritmo');
  previewEdit([set(['bpm'], bpm)]);
  tapTimer = window.setTimeout(() => {
    taps = [];
    if (state.project.bpm !== tapFrom) {
      const b = state.project.bpm;
      previewEdit([set(['bpm'], tapFrom)]);
      edit([set(['bpm'], b)], 'Tap tempo');
      toast(`Tempo: ${b} BPM`);
    }
  }, TAP_RESET_MS);
}

function TapButton() {
  const [lit, setLit] = useState(false);
  return (
    <button
      class={`tr-tap ${lit ? 'on' : ''}`}
      data-hint="Tap tempo: clique no ritmo da música (4 ou mais vezes) e o BPM segue os cliques"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        tap();
        setLit(true);
        setTimeout(() => setLit(false), 90);
      }}
    >
      TAP
    </button>
  );
}

function BpmControl() {
  const s = state;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // tocando com automação de BPM: mostra o andamento do momento
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => onLive((st) => setLive(st.playing && st.bpm !== undefined && Math.abs(st.bpm - state.project.bpm) > 0.005 ? st.bpm : null)), []);
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, b0 = s.project.bpm;
    let last = b0;
    const move = (ev: PointerEvent) => {
      const step = ev.shiftKey ? 0.01 : 0.25;
      last = Math.max(20, Math.min(400, Math.round((b0 + (y0 - ev.clientY) * step) * 100) / 100));
      previewEdit([set(['bpm'], last)]);
    };
    const up = () => {
      el.removeEventListener('pointermove', move as any);
      el.removeEventListener('pointerup', up);
      if (last !== b0) edit([set(['bpm'], last)]);
    };
    el.addEventListener('pointermove', move as any);
    el.addEventListener('pointerup', up);
  };
  const bpm = s.project.bpm;
  return (
    <span
      class={`lcd bpmval ${live !== null ? 'auto' : ''}`}
      data-hint="Tempo: arraste para cima/baixo (Shift = fino), duplo clique para digitar · botão direito: automação"
      onPointerDown={onDown as any}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onDblClick={async () => {
        const v = await askText({ title: 'Tempo', label: 'BPM (20 a 400)', value: String(bpm), numeric: { min: 20, max: 400 }, ok: 'Aplicar' });
        if (v) edit([set(['bpm'], Number(v.replace(',', '.')))]);
      }}
    >
      {String(+(live ?? bpm).toFixed(live !== null ? 1 : 3)).padStart(3, ' ')}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[['Criar automação do BPM…', () => createAutomation(BPM_TARGET)]]} />}
    </span>
  );
}

interface FileDialogOpts {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

declare global {
  interface Window {
    mlabsWindow?: {
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      isMaximized(): Promise<boolean>;
      onState(cb: (max: boolean) => void): void;
      /** Arquivo passado ao abrir o app (ou null). */
      pendingFile?(): Promise<string | null>;
      /** Avisa quando o sistema pede para abrir um arquivo com o app já aberto. */
      onOpenFile?(cb: (path: string) => void): void;
      /** Explorador de arquivos do sistema (abrir / salvar como): caminho ou null. */
      openDialog?(o: FileDialogOpts): Promise<string | null>;
      saveDialog?(o: FileDialogOpts): Promise<string | null>;
      /** Mantém a tela ligada (true) ou deixa o sistema apagar (false). */
      keepAwake?(on: boolean): void;
    };
  }
}

/** Minimizar, maximizar e fechar (só no app desktop, onde a janela não tem borda nativa). */
function WindowControls() {
  const w = window.mlabsWindow;
  const [max, setMax] = useState(true);
  useEffect(() => {
    if (!w) return;
    w.isMaximized().then(setMax);
    w.onState(setMax);
  }, []);
  if (!w) return null;
  return (
    <div class="wctl">
      <button data-hint="Minimizar" onClick={() => w.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 5.5h8" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button data-hint={max ? 'Restaurar' : 'Maximizar'} onClick={() => w.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
          {max ? <path d="M2.5 3.5h5v5h-5zM3.5 1.5h5v5" /> : <path d="M1.5 1.5h7v7h-7z" />}
        </svg>
      </button>
      <button class="close" data-hint="Fechar" onClick={() => w.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </div>
  );
}

/** Barra de título: menus, nome do projeto, janelas e controles. Arrastar move a janela. */
export function TitleBar() {
  const s = useApp();
  const p = s.project;
  const winBtn = (id: WindowId, icon: string, label: string, key: string) => (
    <IconBtn icon={icon} size={15} class="wbtn" on={s.windows[id].open} hint={`${label} (${key})`} onClick={() => openWindow(id, true)} />
  );
  return (
    <div class={`titlebar ${window.mlabsWindow ? 'desktop' : ''}`} onDblClick={(e) => (e.target as Element).classList.contains('tb-drag') && window.mlabsWindow?.toggleMaximize()}>
      <MenuBar />
      <div class="tb-drag">
        <span class="pname" data-hint={s.path ?? 'Projeto ainda não salvo'}>
          {p.name}
          {s.dirty ? ' •' : ''}
        </span>
      </div>
      <div class="tb-wins">
        {winBtn('playlist', 'playlist', 'Playlist', 'F5')}
        {winBtn('rack', 'rack', 'Rack de canais', 'F6')}
        {winBtn('piano', 'piano', 'Piano roll', 'F7')}
        {winBtn('mixer', 'mixer', 'Mixer', 'F9')}
        {winBtn('amp', 'guitar', 'Amp de guitarra', 'F10')}
        {winBtn('tune', 'tune', 'Melodify (editar notas de uma gravação)', 'F11')}
        {winBtn('stitch', 'stitch', 'Stitcher (juntar os melhores takes)', 'F12')}
        {winBtn('browser', 'browser', 'Navegador', 'Alt+F8')}
      </div>
      <div class={`conn ${s.connected ? 'ok' : ''}`} data-hint={s.connected ? 'Conectado: o Claude pode editar via MCP' : 'Sem conexão com o servidor'}>
        <Icon name="sparkle" size={11} /> <span>{s.connected ? 'MCP' : 'offline'}</span>
      </div>
      <WindowControls />
    </div>
  );
}

export function Toolbar() {
  const s = useApp();
  const p = s.project;
  const playing = audio.status.playing;
  const tips = looks.tooltips;
  const mix = (
    <div class="tb-panel">
      <Knob
        size={26}
        value={p.mixer[0]?.volume ?? 0.8}
        min={0}
        max={1.25}
        def={0.8}
        label="Master"
        auto={{ path: ['mixer', 0, 'volume'], label: 'Master · volume' }}
        format={dbFmt}
        onInput={(v) => previewEdit([set(['mixer', 0, 'volume'], v)])}
        onCommit={(v) => edit([set(['mixer', 0, 'volume'], v)])}
        title="Volume do master"
      />
      <Knob
        size={26}
        value={p.swing}
        min={0}
        max={1}
        def={0}
        label="Swing"
        format={(v) => `${Math.round(v * 100)}%`}
        onInput={(v) => previewEdit([set(['swing'], v)])}
        onCommit={(v) => edit([set(['swing'], v)])}
        title="Swing global (atrasa os steps pares)"
      />
      <Scope />
    </div>
  );
  const pats = (
    <div class="tb-panel">
      <div class="patsel" data-hint="Pattern atual (o rack e o piano roll editam este pattern)">
        <select value={s.patternId ?? ''} onChange={(e) => selectPattern((e.target as HTMLSelectElement).value)}>
          {p.patterns.map((pt) => (
            <option value={pt.id}>{pt.name}</option>
          ))}
        </select>
        <IconBtn icon="plus" hint="Novo pattern (F4)" onClick={() => { const r = act(A.addPattern, {}); if (r) selectPattern(r.id); }} />
        <IconBtn icon="clone" hint="Clonar pattern" onClick={() => { const r = s.patternId && act(A.duplicatePattern, { pattern: s.patternId }); if (r) selectPattern(r.id); }} />
      </div>
      <IconBtn icon="undo" hint="Desfazer (Ctrl+Z)" onClick={undo} />
      <IconBtn icon="redo" hint="Refazer (Ctrl+Y)" onClick={redo} />
      <IconBtn icon="save" hint={`Salvar (Ctrl+S)${s.dirty ? ' · há alterações não salvas' : ''}`} class={s.dirty ? 'dirty' : ''} onClick={() => saveProject()} />
    </div>
  );
  return (
    <div class={`toolbar ${tips ? 'tips' : ''}`}>
      {tips ? <div class="tb-side" /> : <HintBar />}
      <div class="tb-panel transport">
        <div class="modepill" data-hint="Modo: pattern toca só o pattern atual; song toca a playlist (L)">
          <button class={s.mode === 'pattern' ? 'on pat' : ''} onClick={() => setMode('pattern')}>
            PAT
          </button>
          <button class={s.mode === 'song' ? 'on song' : ''} onClick={() => setMode('song')}>
            SONG
          </button>
        </div>
        <IconBtn icon={playing ? 'pause' : 'play'} class={`tbig play ${playing ? 'on' : ''}`} hint="Tocar / pausar (Espaço)" onClick={() => (playing ? stop() : play())} />
        <IconBtn icon="stop" class="tbig" hint="Parar e voltar ao início" onClick={() => stop()} />
        <IconBtn
          icon="record"
          class={`tbig rec ${audio.recording || midiRecording() ? 'on' : ''}`}
          hint={audio.recording || midiRecording() ? 'Parar a gravação' : 'Gravar notas (teclado do computador, teclado MIDI) e automações (knobs mexidos) a partir da seleção ou da posição atual. Voz e instrumentos de áudio: Amp, Melodify e Stitcher'}
          onClick={() => toggleRecord()}
        />
        <div class="tr-toggles">
          <button class={`tr-tog ${s.loopOn ? 'on' : ''}`} onClick={toggleLoop} data-hint="Loop: ao chegar no fim da área selecionada (ou da música), volta para o começo. Gravando, cada volta vira um pattern novo na track de baixo">
            <Icon name="loop" size={13} />
          </button>
          <button class={`tr-tog ${s.metronome ? 'on' : ''}`} onClick={toggleMetronome} data-hint="Metrônomo: um clique a cada tempo (mais agudo no começo do compasso)">
            <Icon name="metronome" size={13} />
          </button>
          <button class={`tr-tog ${s.countIn ? 'on' : ''}`} onClick={toggleCountIn} data-hint="Contagem: ao gravar, conta 4 tempos (um compasso) antes de começar">
            <span class="tr-count">321</span>
          </button>
        </div>
        <div class="lcdbox">
          <BpmControl />
          <span class="lcd-cap">BPM</span>
        </div>
        <TapButton />
        <div class="lcdbox">
          <Position />
          <span class="lcd-cap">B:S:T</span>
        </div>
      </div>
      {mix}
      {tips ? <div class="tb-side right">{pats}</div> : pats}
    </div>
  );
}
