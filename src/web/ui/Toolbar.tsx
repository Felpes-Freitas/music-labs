import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, useHint, state, play, stop, setMode, selectPattern, act, edit, previewEdit, undo, redo, openWindow, api, toast, onLive, emit, type WindowId } from '../state';
import { audio } from '../audio';
import * as A from '../../core/actions';
import { INSTRUMENTS, PRESETS } from '../../core/registry';
import { PPQ, STEP, ticksPerBar, type InstrumentType } from '../../core/model';
import { set } from '../../core/ops';
import { Knob, IconBtn, dbFmt } from './widgets';
import { Icon } from './icons';

// ---------------------------------------------------------------- ações de arquivo

export async function saveProject(as = false) {
  const s = state;
  if (as || !s.path) {
    const name = prompt('Salvar como (nome do projeto):', s.project.name);
    if (!name) return;
    edit([set(['name'], name)]);
    const r = await api('POST', '/api/save', { path: `${name}.batuque` });
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
  if (state.dirty && !confirm('Criar projeto novo? Alterações não salvas serão perdidas.')) return;
  await api('POST', '/api/new', { template });
}

async function importPath() {
  const path = prompt('Caminho do arquivo (.batuque ou .flp):');
  if (!path) return;
  try {
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

type Item = { label: string; key?: string; run?: () => void; sub?: Item[]; sep?: boolean; on?: boolean };

function menus(): Record<string, Item[]> {
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
      ...(Object.keys(INSTRUMENTS) as InstrumentType[]).map((t) => ({ label: INSTRUMENTS[t].label, run: () => addChannel({ type: t }) })),
      { sep: true, label: '' },
      { label: 'Presets', sub: Object.keys(PRESETS).map((k) => ({ label: k, run: () => addChannel({ preset: k }) })) },
    ],
    Patterns: [
      { label: 'Novo pattern', key: 'F4', run: () => { const r = act(A.addPattern, {}); if (r) selectPattern(r.id); } },
      { label: 'Clonar pattern', run: () => { const r = pat && act(A.duplicatePattern, { pattern: pat.id }); if (r) selectPattern(r.id); } },
      { label: 'Renomear pattern…', key: 'F2', run: () => { const n = pat && prompt('Nome do pattern:', pat.name); if (n && pat) act(A.updatePattern, { pattern: pat.id, name: n }); } },
      { label: 'Excluir pattern', run: () => pat && s.project.patterns.length > 1 && confirm(`Excluir ${pat.name}?`) && act(A.removePattern, { pattern: pat.id }) },
    ],
    Exibir: [
      { label: 'Playlist', key: 'F5', on: s.windows.playlist.open, run: () => openWindow('playlist', true) },
      { label: 'Rack de canais', key: 'F6', on: s.windows.rack.open, run: () => openWindow('rack', true) },
      { label: 'Piano roll', key: 'F7', on: s.windows.piano.open, run: () => openWindow('piano', true) },
      { label: 'Navegador', key: 'Alt+F8', on: s.windows.browser.open, run: () => openWindow('browser', true) },
      { label: 'Mixer', key: 'F9', on: s.windows.mixer.open, run: () => openWindow('mixer', true) },
    ],
    Opções: [
      { label: 'Seguir a reprodução', on: s.followPlay, run: () => ((state.followPlay = !state.followPlay), emit()) },
      { label: 'Ligar o áudio', run: () => audio.start().then(() => toast('Áudio ligado')) },
      { label: 'Pânico (cortar todas as notas)', run: () => audio.post({ type: 'panic' }) },
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
          <button class="menu-btn" onClick={() => setOpen(open === name ? null : name)}>
            {name}
          </button>
          {open === name && (
            <div class="menu-drop">
              {items.map((it) =>
                it.sep ? (
                  <div class="menu-sep" />
                ) : (
                  <div class={`menu-item ${it.sub ? 'has-sub' : ''}`} onClick={() => run(it)} onPointerEnter={() => setSub(it.sub ? it.label : null)}>
                    <span class="menu-check">{it.on ? '✓' : ''}</span>
                    <span class="menu-label">{it.label}</span>
                    {it.key && <span class="menu-key">{it.key}</span>}
                    {it.sub && <Icon name="chevron" size={10} />}
                    {it.sub && sub === it.label && (
                      <div class="menu-drop sub">
                        {it.sub.map((x) => (
                          <div class="menu-item" onClick={(e) => (e.stopPropagation(), run(x))}>
                            <span class="menu-check" />
                            <span class="menu-label">{x.label}</span>
                          </div>
                        ))}
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
      ctx.fillStyle = '#0c1012';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#1f2a2f';
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

function BpmControl() {
  const s = state;
  const onDown = (e: PointerEvent) => {
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
      class="lcd bpmval"
      data-hint="Tempo: arraste para cima/baixo (Shift = fino), duplo clique para digitar"
      onPointerDown={onDown as any}
      onDblClick={() => {
        const v = Number(prompt('BPM:', String(bpm)));
        if (v >= 20 && v <= 400) edit([set(['bpm'], v)]);
      }}
    >
      {String(+bpm.toFixed(3)).padStart(3, ' ')}
    </span>
  );
}

export function Toolbar() {
  const s = useApp();
  const p = s.project;
  const playing = audio.status.playing;
  const winBtn = (id: WindowId, icon: string, label: string, key: string) => (
    <IconBtn icon={icon} size={16} class="wbtn" on={s.windows[id].open} hint={`${label} (${key})`} onClick={() => openWindow(id, true)} />
  );
  return (
    <div class="toolbar">
      <div class="tb-left">
        <MenuBar />
        <HintBar />
      </div>
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
        <div class="lcdbox">
          <BpmControl />
          <span class="lcd-cap">BPM</span>
        </div>
        <div class="lcdbox">
          <Position />
          <span class="lcd-cap">B:S:T</span>
        </div>
      </div>
      <div class="tb-panel">
        <Knob
          size={26}
          value={p.mixer[0]?.volume ?? 0.8}
          min={0}
          max={1.25}
          def={0.8}
          label="Master"
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
      <div class="tb-panel windows">
        {winBtn('playlist', 'playlist', 'Playlist', 'F5')}
        {winBtn('rack', 'rack', 'Rack de canais', 'F6')}
        {winBtn('piano', 'piano', 'Piano roll', 'F7')}
        {winBtn('mixer', 'mixer', 'Mixer', 'F9')}
        {winBtn('browser', 'browser', 'Navegador', 'Alt+F8')}
      </div>
      <div class="tb-right">
        <div class="pname" data-hint={s.path ?? 'Projeto ainda não salvo'}>
          {p.name}
          {s.dirty ? ' •' : ''}
        </div>
        <div class={`conn ${s.connected ? 'ok' : ''}`} data-hint={s.connected ? 'Conectado: o Claude pode editar via MCP' : 'Sem conexão com o servidor'}>
          <Icon name="sparkle" size={11} /> {s.connected ? 'MCP' : 'offline'}
        </div>
      </div>
    </div>
  );
}
