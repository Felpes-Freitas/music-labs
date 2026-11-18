import { useEffect, useRef } from 'preact/hooks';
import { useApp, state, play, stop, setMode, selectPattern, act, edit, undo, redo, openWindow, api, toast, onLive, type WindowId } from '../state';
import { audio } from '../audio';
import * as A from '../../core/actions';
import { PPQ, STEP, ticksPerBar } from '../../core/model';
import { set } from '../../core/ops';
import { Knob } from './widgets';

function Position() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onLive((s) => {
        if (!ref.current) return;
        const bar = ticksPerBar(state.project);
        const t = s.tick;
        const b = Math.floor(t / bar) + 1;
        const beat = Math.floor((t % bar) / PPQ) + 1;
        const st = Math.floor((t % PPQ) / STEP) + 1;
        ref.current.textContent = `${String(b).padStart(3, ' ')}:${beat}:${st}`;
      }),
    [],
  );
  return <span ref={ref} class="lcd pos">  1:1:1</span>;
}

function MasterMeter() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let l = 0, r = 0;
    return onLive((s) => {
      const c = ref.current;
      if (!c) return;
      const m = s.meters[0] ?? [0, 0];
      l = Math.max(m[0], l * 0.85);
      r = Math.max(m[1], r * 0.85);
      const ctx = c.getContext('2d')!;
      const w = c.width, h = c.height;
      ctx.clearRect(0, 0, w, h);
      const bar = (v: number, y: number) => {
        const db = 20 * Math.log10(Math.max(v, 1e-5));
        const x = Math.max(0, Math.min(1, (db + 48) / 48)) * w;
        ctx.fillStyle = db > -0.5 ? '#ff4d4d' : db > -6 ? '#f0c040' : '#5fd17a';
        ctx.fillRect(0, y, x, h / 2 - 1);
      };
      bar(l, 0);
      bar(r, h / 2);
    });
  }, []);
  return <canvas ref={ref} width={120} height={14} class="master-meter" title="Saída master" />;
}

export function Toolbar() {
  const s = useApp();
  const p = s.project;
  const playing = audio.status.playing;
  const winBtn = (id: WindowId, label: string, key: string) => (
    <button class={`wbtn ${s.windows[id].open ? 'on' : ''}`} title={`${label} (${key})`} onClick={() => openWindow(id, true)}>
      {label}
    </button>
  );
  const saveAs = async () => {
    const name = prompt('Salvar como (nome do projeto):', p.name);
    if (!name) return;
    edit([set(['name'], name)]);
    const r = await api('POST', '/api/save', { path: `${name}.musiclabs` });
    toast(`Salvo em ${r.path}`);
  };
  const save = async () => {
    if (!s.path) return saveAs();
    const r = await api('POST', '/api/save', {});
    toast(`Salvo em ${r.path}`);
  };
  const exportWav = async () => {
    toast('Renderizando...');
    try {
      const r = await api('POST', '/api/render', { mode: p.clips.length ? 'song' : 'pattern', pattern: s.patternId });
      toast(`WAV: ${r.file} · ${r.analysis.integratedLufs} LUFS · pico ${r.analysis.peakDb} dB`);
    } catch (e) {
      toast(`Erro: ${(e as Error).message}`);
    }
  };
  return (
    <div class="toolbar">
      <div class="logo" title="Music Labs">
        <span class="logo-dot" />
        MUSICLABS
      </div>
      <div class="group">
        <button title="Novo projeto" onClick={() => confirm('Novo projeto? Alterações não salvas no atual serão perdidas.') && api('POST', '/api/new', {})}>
          Novo
        </button>
        <button title="Salvar (Ctrl+S)" onClick={save}>
          Salvar{s.dirty ? '*' : ''}
        </button>
        <button title="Salvar como" onClick={saveAs}>
          Como…
        </button>
        <button title="Exportar WAV" onClick={exportWav}>
          WAV
        </button>
        <button title="Desfazer (Ctrl+Z)" onClick={undo}>
          ↶
        </button>
        <button title="Refazer (Ctrl+Y)" onClick={redo}>
          ↷
        </button>
      </div>
      <div class="group transport">
        <button class={`mode ${s.mode === 'pattern' ? 'pat' : 'song'}`} title="Alternar modo pattern/song (L)" onClick={() => setMode(s.mode === 'pattern' ? 'song' : 'pattern')}>
          {s.mode === 'pattern' ? 'PAT' : 'SONG'}
        </button>
        <button class={`play ${playing ? 'on' : ''}`} title="Tocar/pausar (Espaço)" onClick={() => (playing ? stop() : play())}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button class="stop" title="Parar" onClick={() => stop()}>
          ■
        </button>
        <Position />
        <div class="bpm" title="Tempo (arraste ou duplo clique para digitar)">
          <BpmControl />
          <span class="unit">BPM</span>
        </div>
        <Knob
          size={24}
          value={p.swing}
          min={0}
          max={1}
          def={0}
          label="Swing"
          format={(v) => `${Math.round(v * 100)}%`}
          onInput={(v) => (state.project.swing = v)}
          onCommit={(v) => edit([set(['swing'], v)])}
        />
      </div>
      <div class="group">
        <select value={s.patternId ?? ''} onChange={(e) => selectPattern((e.target as HTMLSelectElement).value)} title="Pattern atual">
          {p.patterns.map((pt) => (
            <option value={pt.id}>{pt.name}</option>
          ))}
        </select>
        <button
          title="Novo pattern"
          onClick={() => {
            const r = act(A.addPattern, {});
            if (r) selectPattern(r.id);
          }}
        >
          +
        </button>
        <button
          title="Duplicar pattern"
          onClick={() => {
            const r = s.patternId && act(A.duplicatePattern, { pattern: s.patternId });
            if (r) selectPattern(r.id);
          }}
        >
          ⧉
        </button>
      </div>
      <div class="group windows">
        {winBtn('playlist', 'Playlist', 'F5')}
        {winBtn('rack', 'Rack', 'F6')}
        {winBtn('piano', 'Piano roll', 'F7')}
        {winBtn('browser', 'Navegador', 'F8')}
        {winBtn('mixer', 'Mixer', 'F9')}
      </div>
      <MasterMeter />
      <div class={`conn ${s.connected ? 'ok' : ''}`} title={s.connected ? 'Conectado ao servidor (MCP ativo)' : 'Sem conexão com o servidor'}>
        {s.connected ? '● MCP' : '○ offline'}
      </div>
      <div class="pname" title={s.path ?? 'não salvo'}>
        {p.name}
      </div>
    </div>
  );
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
      s.project.bpm = last;
      audio.setProject(s.project);
      el.textContent = last.toFixed(last % 1 ? 2 : 0);
    };
    const up = () => {
      el.removeEventListener('pointermove', move as any);
      el.removeEventListener('pointerup', up);
      if (last !== b0) edit([set(['bpm'], last)]);
    };
    el.addEventListener('pointermove', move as any);
    el.addEventListener('pointerup', up);
  };
  return (
    <span
      class="lcd bpmval"
      onPointerDown={onDown as any}
      onDblClick={() => {
        const v = Number(prompt('BPM:', String(s.project.bpm)));
        if (v >= 20 && v <= 400) edit([set(['bpm'], v)]);
      }}
    >
      {s.project.bpm.toFixed(s.project.bpm % 1 ? 2 : 0)}
    </span>
  );
}
