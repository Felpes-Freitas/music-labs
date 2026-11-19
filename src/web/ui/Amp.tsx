// Amp de guitarra: entrada de áudio → cadeia de efeitos (reordenável) → ouvir e
// gravar direto na playlist, já com os efeitos. A configuração (cadeia, entrada,
// presets do usuário) fica salva no computador, não no projeto.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { useApp, state, toggleRecord, toast, emit, onLive } from '../state';
import { audio, type RecChannels } from '../audio';
import { EFFECTS, GUITAR_FX, type ParamDef } from '../../core/registry';
import type { EffectType, Params } from '../../core/model';
import { uid } from '../../core/model';
import { getPref, setPref, usePref } from '../prefs';
import { Win, Knob, ContextMenu, fmt } from './widgets';
import { Icon } from './icons';
import { askText, askConfirm } from './Dialog';
import { accent, ui, onTheme } from '../theme';

interface AmpFx {
  id: string;
  type: EffectType;
  enabled: boolean;
  mix: number;
  params: Params;
}
interface AmpPrefs {
  chain: AmpFx[];
  inGain: number;
  outGain: number;
  monitor: boolean;
  device: string;
  pick: RecChannels;
  preset: string;
  smart: boolean;
  thresholdDb: number;
  marginDb: number;
  holdSec: number;
}

const fx = (type: EffectType, params: Params = {}, mix = 1): AmpFx => ({ id: uid('a'), type, enabled: true, mix, params });

/** Presets de fábrica: cada um devolve uma cadeia nova. */
const PRESETS: Record<string, () => AmpFx[]> = {
  'Clean cristalino': () => [
    fx('gate', { threshold: -60 }),
    fx('compressor', { threshold: -24, ratio: 3, attack: 8, release: 120, makeup: 4 }),
    fx('amp', { channel: 'clean', gain: 0.35, bass: 0.5, mid: 0.45, treble: 0.6, presence: 0.55, master: -6 }),
    fx('cab', { cab: '2x12 aberta', mic: 0.3 }),
    fx('chorus', { rate: 0.6, depth: 0.35, delay: 10 }, 0.35),
    fx('reverb', { size: 0.55, damp: 0.4 }, 0.22),
  ],
  'Blues crunch': () => [
    fx('gate', { threshold: -58 }),
    fx('overdrive', { drive: 0.35, tone: 0.55, level: 2 }),
    fx('amp', { channel: 'crunch', gain: 0.4, bass: 0.45, mid: 0.6, treble: 0.55, presence: 0.5, master: -8 }),
    fx('cab', { cab: '1x12 combo', mic: 0.4 }),
    fx('reverb', { size: 0.45, damp: 0.5 }, 0.18),
  ],
  'Rock clássico': () => [
    fx('gate', { threshold: -55 }),
    fx('amp', { channel: 'crunch', gain: 0.75, bass: 0.55, mid: 0.65, treble: 0.6, presence: 0.6, master: -9 }),
    fx('cab', { cab: '4x12 britânica', mic: 0.35 }),
    fx('delay', { time: '1/8D', feedback: 0.25 }, 0.18),
    fx('reverb', { size: 0.5 }, 0.12),
  ],
  'Metal moderno': () => [
    fx('gate', { threshold: -48, release: 40 }),
    fx('overdrive', { drive: 0.05, tone: 0.6, level: 6 }),
    fx('amp', { channel: 'lead', gain: 0.7, bass: 0.6, mid: 0.35, treble: 0.6, presence: 0.65, master: -12 }),
    fx('cab', { cab: '4x12 moderna', mic: 0.3, low: 0.6 }),
    fx('eq', { hpf: 70, m1Freq: 400, m1Gain: -3, m1Q: 1.2 }),
  ],
  'Fuzz vintage': () => [
    fx('fuzz', { fuzz: 0.75, tone: 0.45, level: -8 }),
    fx('amp', { channel: 'clean', gain: 0.55, bass: 0.55, mid: 0.55, treble: 0.5, master: -6 }),
    fx('cab', { cab: '2x12 aberta', mic: 0.5 }),
    fx('reverb', { size: 0.4 }, 0.15),
  ],
  'Funk': () => [
    fx('compressor', { threshold: -26, ratio: 5, attack: 3, release: 90, makeup: 6 }),
    fx('wah', { mode: 'auto', sens: 0.65, q: 0.8 }),
    fx('amp', { channel: 'clean', gain: 0.4, bass: 0.4, mid: 0.5, treble: 0.65, master: -6 }),
    fx('cab', { cab: '2x12 aberta', mic: 0.25 }),
  ],
  'Ambiente': () => [
    fx('gate', { threshold: -62 }),
    fx('amp', { channel: 'clean', gain: 0.3, bass: 0.45, mid: 0.4, treble: 0.6, master: -6 }),
    fx('cab', { cab: '2x12 aberta', mic: 0.35 }),
    fx('chorus', { rate: 0.3, depth: 0.5 }, 0.4),
    fx('delay', { time: '1/4D', feedback: 0.55 }, 0.35),
    fx('reverb', { size: 0.92, damp: 0.3 }, 0.45),
  ],
  'Surf': () => [
    fx('amp', { channel: 'clean', gain: 0.5, bass: 0.4, mid: 0.5, treble: 0.7, master: -6 }),
    fx('cab', { cab: '1x12 combo', mic: 0.2 }),
    fx('tremolo', { rate: 6, depth: 0.55 }),
    fx('reverb', { size: 0.7, damp: 0.2 }, 0.4),
  ],
};
const FIRST = 'Blues crunch';

const load = (): AmpPrefs => {
  const p = getPref<Partial<AmpPrefs>>('amp', {});
  return {
    chain: p.chain ?? PRESETS[FIRST](),
    inGain: p.inGain ?? 0,
    outGain: p.outGain ?? 0,
    monitor: p.monitor ?? true,
    device: p.device ?? '',
    pick: p.pick ?? 'left',
    preset: p.preset ?? FIRST,
    smart: p.smart ?? true,
    thresholdDb: p.thresholdDb ?? -45,
    marginDb: p.marginDb ?? 10,
    holdSec: p.holdSec ?? 1.5,
  };
};
const amp = load();
const userPresets = () => getPref<Record<string, AmpFx[]>>('amp.presets', {});

const listeners = new Set<() => void>();
/** Grava as preferências, manda a cadeia para o áudio e redesenha. */
function commit() {
  setPref('amp', amp);
  audio.configAmp({ chain: amp.chain, inGain: amp.inGain, outGain: amp.outGain, pick: amp.pick, bpm: state.project.bpm });
  audio.setAmpMonitor(amp.monitor);
  listeners.forEach((l) => l());
}

let recFromAmp = false;

export function AmpWindow() {
  const s = useApp();
  const open = s.windows.amp.open;
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [on, setOn] = useState(false);
  useEffect(() => {
    listeners.add(force as () => void);
    return () => void listeners.delete(force as () => void);
  }, []);
  // liga a entrada quando a janela abre (e quando muda a entrada); desliga ao fechar
  useEffect(() => {
    if (!open) {
      audio.stopAmp();
      setOn(false);
      return;
    }
    let dead = false;
    audio
      .startAmp(amp.device)
      .then(() => {
        if (dead) return;
        setOn(true);
        commit();
        audio.inputDevices().then(setDevices);
      })
      .catch((e) => {
        setOn(false);
        toast(`Amp: não consegui abrir a entrada de áudio (${(e as Error).message})`);
      });
    return () => void (dead = true);
  }, [open, amp.device]);
  useEffect(() => {
    if (on) commit();
  }, [s.project.bpm]);

  const recording = !!audio.liveRecording && recFromAmp;
  const rec = () => {
    if (audio.recording) {
      toggleRecord();
      recFromAmp = false;
      return;
    }
    recFromAmp = true;
    toggleRecord({
      chain: amp.chain.map(({ type, enabled, mix, params }) => ({ type, enabled, mix, params: { ...params } })),
      inGainDb: amp.inGain,
      outGainDb: amp.outGain,
      pick: amp.pick,
      smart: amp.smart ? { marginDb: amp.marginDb, holdSec: amp.holdSec, thresholdDb: amp.thresholdDb, deviceId: amp.device || undefined } : null,
    }).then(() => emit());
  };
  const presetNames = [...Object.keys(PRESETS), ...Object.keys(userPresets())];
  const loadPreset = (name: string) => {
    const u = userPresets()[name];
    amp.chain = u ? u.map((x) => ({ ...x, id: uid('a'), params: { ...x.params } })) : PRESETS[name]?.() ?? amp.chain;
    amp.preset = name;
    commit();
  };
  const savePreset = async () => {
    const name = await askText({ title: 'Salvar preset do amp', label: 'Nome', value: PRESETS[amp.preset] ? '' : amp.preset, placeholder: 'Meu timbre', ok: 'Salvar' });
    if (!name) return;
    if (PRESETS[name]) return toast('Esse nome é de um preset de fábrica; escolha outro.');
    setPref('amp.presets', { ...userPresets(), [name]: amp.chain });
    amp.preset = name;
    commit();
    toast(`Preset "${name}" salvo`);
  };
  const deletePreset = async () => {
    const all = userPresets();
    if (!all[amp.preset]) return;
    if (!(await askConfirm({ title: `Apagar o preset "${amp.preset}"?`, ok: 'Apagar', danger: true }))) return;
    delete all[amp.preset];
    setPref('amp.presets', all);
    amp.preset = FIRST;
    commit();
  };

  const tools = (
    <div class="amp-input nodrag">
      <Icon name="guitar" size={13} />
      <select
        class="amp-dev"
        value={amp.device}
        data-hint="Entrada de áudio do amp (pode ser outra, só para a guitarra)"
        onChange={(e) => {
          amp.device = (e.target as HTMLSelectElement).value;
          commit();
        }}
      >
        <option value="">Entrada padrão</option>
        {devices.filter((d) => d.id && d.id !== 'default').map((d) => (
          <option value={d.id}>{d.label}</option>
        ))}
      </select>
      <select
        class="amp-pick"
        value={amp.pick}
        data-hint="Qual canal da interface usar (a guitarra costuma estar numa entrada só)"
        onChange={(e) => {
          amp.pick = (e.target as HTMLSelectElement).value as RecChannels;
          commit();
        }}
      >
        <option value="left">Entrada 1</option>
        <option value="right">Entrada 2</option>
        <option value="stereo">Estéreo</option>
      </select>
    </div>
  );

  return (
    <Win id="amp" title="Amp" icon="guitar" tools={tools} minW={560} minH={300}>
      <div class="amp">
        <div class="amp-top">
          <button class={`amp-rec ${recording ? 'on' : ''}`} disabled={!on && !recording} onClick={rec} data-hint="Grava a guitarra direto na playlist, a partir da posição atual; os efeitos entram na gravação em alta qualidade">
            <Icon name="record" size={14} />
            {recording ? 'Parar' : 'Gravar'}
          </button>
          <div class="amp-smart">
            <label class="amp-smart-on" data-hint="Só grava quando você toca: cada trecho tocado vira um clipe onde a música estava; o silêncio fica de fora">
              <input type="checkbox" checked={amp.smart} disabled={recording} onChange={() => ((amp.smart = !amp.smart), commit())} />
              Só quando tocar
            </label>
            {amp.smart && (
              <>
                <Knob size={24} value={amp.thresholdDb} min={-70} max={-6} def={-45} color="#ff7070" label="Limiar" title={`Volume mínimo para virar gravação: ${amp.thresholdDb.toFixed(0)} dB. Abaixo disso nada entra (veja a linha vermelha no visualizador)`} format={(v) => `${v.toFixed(0)} dB`} onInput={(v) => ((amp.thresholdDb = v), force(undefined))} onCommit={(v) => ((amp.thresholdDb = v), commit())} />
                <Knob size={24} value={amp.marginDb} min={3} max={30} def={10} label="Margem" title={`Quanto acima do ruído de fundo o som precisa estar para abrir um take: ${amp.marginDb.toFixed(0)} dB (menos = pega notas mais fracas; mais = ignora barulhos do ambiente)`} format={(v) => `${v.toFixed(0)} dB acima do ruído`} onInput={(v) => ((amp.marginDb = v), force(undefined))} onCommit={(v) => ((amp.marginDb = v), commit())} />
                <Knob size={24} value={amp.holdSec} min={0.3} max={5} def={1.5} log label="Pausa" title={`Depois de ${amp.holdSec.toFixed(1)} s sem tocar, o take fecha (inclui a cauda dos efeitos)`} format={(v) => `${v.toFixed(1)} s`} onInput={(v) => ((amp.holdSec = v), force(undefined))} onCommit={(v) => ((amp.holdSec = v), commit())} />
              </>
            )}
            {recording && <RecStatus />}
          </div>
          <button class={`amp-mon ${amp.monitor ? 'on' : ''}`} onClick={() => ((amp.monitor = !amp.monitor), commit())} data-hint="Ouvir o amp enquanto toca (desligue se o microfone captar os alto-falantes)">
            Ouvir
          </button>
          <Knob size={28} value={amp.inGain} min={-24} max={24} def={0} bipolar label="Entrada" format={(v) => `${v.toFixed(1)} dB`} onInput={(v) => ((amp.inGain = v), commit())} onCommit={(v) => ((amp.inGain = v), commit())} />
          <Knob size={28} value={amp.outGain} min={-36} max={12} def={0} label="Saída" format={(v) => `${v.toFixed(1)} dB`} onInput={(v) => ((amp.outGain = v), commit())} onCommit={(v) => ((amp.outGain = v), commit())} />
          <div class="amp-presets">
            <span>Preset</span>
            <select value={presetNames.includes(amp.preset) ? amp.preset : ''} onChange={(e) => loadPreset((e.target as HTMLSelectElement).value)}>
              {!presetNames.includes(amp.preset) && <option value="">(personalizado)</option>}
              <optgroup label="De fábrica">
                {Object.keys(PRESETS).map((n) => (
                  <option value={n}>{n}</option>
                ))}
              </optgroup>
              {Object.keys(userPresets()).length > 0 && (
                <optgroup label="Meus presets">
                  {Object.keys(userPresets()).map((n) => (
                    <option value={n}>{n}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <button onClick={savePreset} data-hint="Salvar a cadeia atual como preset">
              <Icon name="save" size={13} />
            </button>
            {userPresets()[amp.preset] && (
              <button onClick={deletePreset} data-hint="Apagar este preset">
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          {!on ? <span class="amp-off">Entrada desligada</span> : <span class="amp-lat" data-hint="Atraso do retorno (o que você ouve tocando). A gravação usa o sinal cru e reaplica os efeitos em alta qualidade, sem esse atraso.">retorno {audio.monitorLatencyMs ?? '–'} ms</span>}
        </div>
        <Visualizer />
        <Chain />
      </div>
    </Win>
  );
}

/** Situação da gravação inteligente: esperando, ou qual take está entrando. */
function RecStatus() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => onLive(() => force(undefined)), []);
  const r = audio.liveRecording;
  if (!r) return null;
  const live = r.takes.length > 0 && r.takes[r.takes.length - 1].c1 >= r.frames;
  if (!r.smart) return <span class="amp-status rec">gravando</span>;
  const noise = r.noiseDb !== null && <small class="amp-noise" data-hint="Ruído de fundo aprendido (chiado, ambiente). Ele só é usado para decidir os cortes dos takes; não muda o som gravado.">ruído {Math.round(r.noiseDb)} dB{r.echoCancel ? ' · sem eco' : ''}</small>;
  return (
    <span class="amp-status-box">
      {live ? <span class="amp-status rec">● take {r.takes.length}</span> : <span class="amp-status">esperando você tocar{r.takes.length ? ` · ${r.takes.length} ${r.takes.length > 1 ? 'takes' : 'take'}` : ''}</span>}
      {noise}
    </span>
  );
}

// ---------------------------------------------------------------- visualizador

function Visualizer() {
  const [open, setOpen] = usePref('amp.viz', true);
  const ref = useRef<HTMLCanvasElement>(null);
  const hist = useRef<{ inp: number[]; out: number[]; inPk: number; outPk: number }>({ inp: [], out: [], inPk: 0, outPk: 0 });
  useEffect(() => {
    let raf = 0;
    const h = hist.current;
    audio.onAmpMeter = (inp, out) => {
      h.inp.push(...inp);
      h.out.push(...out);
      if (h.inp.length > 2000) {
        h.inp.splice(0, h.inp.length - 2000);
        h.out.splice(0, h.out.length - 2000);
      }
      h.inPk = Math.max(h.inPk * 0.85, ...inp);
      h.outPk = Math.max(h.outPk * 0.85, ...out);
      if (!raf && open) raf = requestAnimationFrame(draw);
    };
    const draw = () => {
      raf = 0;
      const c = ref.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (!W) return;
      if (c.width !== Math.round(W * dpr)) c.width = Math.round(W * dpr);
      if (c.height !== Math.round(H * dpr)) c.height = Math.round(H * dpr);
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = ui('#0f1416');
      ctx.fillRect(0, 0, W, H);
      const meterW = 34;
      const ww = W - meterW - 8;
      const mid = H / 2;
      ctx.fillStyle = ui('#1f282d');
      ctx.fillRect(0, mid, ww, 1);
      const n = Math.min(h.out.length, Math.floor(ww / 2));
      // escala em dB (−60 a 0): sons fracos e o limiar ficam visíveis
      const sc = (v: number) => Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-9) + 60) / 60)) * (mid - 4);
      const thr = amp.smart ? Math.pow(10, amp.thresholdDb / 20) : 0;
      // entrada (contorno: claro acima do limiar) e saída (cor de destaque), rolando da direita para a esquerda
      for (let i = 0; i < n; i++) {
        const x = ww - (n - i) * 2;
        const vin = h.inp[h.inp.length - n + i];
        const a = sc(vin);
        const b = sc(h.out[h.out.length - n + i]);
        ctx.fillStyle = accent();
        ctx.globalAlpha = 0.3;
        ctx.fillRect(x, mid - b, 1.5, Math.max(1, b * 2));
        ctx.globalAlpha = 1;
        ctx.fillStyle = !thr ? 'rgba(255,255,255,0.7)' : vin > thr ? '#fff' : 'rgba(255,255,255,0.3)';
        ctx.fillRect(x, mid - a, 1.5, Math.max(1, a * 2)); // entrada como barra cheia, por cima da saída
      }
      if (thr) {
        // linha do limiar de volume da gravação inteligente
        const ty = sc(thr);
        ctx.fillStyle = 'rgba(255,90,90,0.75)';
        for (let x = 0; x < ww; x += 6) {
          ctx.fillRect(x, mid - ty, 3, 1);
          ctx.fillRect(x, mid + ty, 3, 1);
        }
        ctx.font = '9px sans-serif';
        ctx.fillText(`limiar ${amp.thresholdDb.toFixed(0)} dB`, 6, mid - ty - 3);
      }
      // medidores
      const bar = (x: number, v: number, label: string) => {
        const db = 20 * Math.log10(v + 1e-9);
        const f = Math.max(0, Math.min(1, (db + 60) / 60));
        ctx.fillStyle = ui('#1a2226');
        ctx.fillRect(x, 4, 12, H - 18);
        ctx.fillStyle = db > -1 ? '#ff5d5d' : db > -9 ? '#e8c547' : '#59d6a0';
        ctx.fillRect(x, 4 + (H - 18) * (1 - f), 12, (H - 18) * f);
        ctx.fillStyle = ui('#8e9aa1');
        ctx.font = '9px sans-serif';
        ctx.fillText(label, x + 1, H - 3);
      };
      bar(W - meterW, h.inPk, 'in');
      if (thr) {
        const f = Math.max(0, Math.min(1, (amp.thresholdDb + 60) / 60));
        ctx.fillStyle = '#ff5a5a';
        ctx.fillRect(W - meterW - 2, 4 + (H - 18) * (1 - f), 16, 1.5);
      }
      bar(W - meterW + 17, h.outPk, 'out');
    };
    const off = onTheme(() => draw());
    return () => {
      audio.onAmpMeter = () => {};
      cancelAnimationFrame(raf);
      off();
    };
  }, [open]);
  return (
    <div class={`amp-viz ${open ? '' : 'closed'}`}>
      <button class="fold" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'chevron'} size={10} /> Visualizador
      </button>
      {open && <canvas ref={ref} class="amp-wave" />}
    </div>
  );
}

// ---------------------------------------------------------------- cadeia de efeitos

const fmtParam = (d: ParamDef) => (x: number) => {
  if (d.unit === 'Hz') return x >= 1000 ? `${(x / 1000).toFixed(2)} kHz` : `${Math.round(x)} Hz`;
  if (d.unit) return `${fmt(x)} ${d.unit}`;
  if (d.min === 0 && d.max === 1) return (x * 10).toFixed(1); // escala 0–10, como nos amps
  return fmt(x);
};
const WET: EffectType[] = ['delay', 'reverb', 'chorus', 'phaser'];

function Chain() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDragState] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number } | null>(null);
  const setDrag = (d: { from: number; to: number } | null) => ((dragRef.current = d), setDragState(d));
  const chain = amp.chain;
  const set = (i: number, patch: Partial<AmpFx>) => {
    chain[i] = { ...chain[i], ...patch };
    amp.preset = '';
    commit();
  };
  const add = (type: EffectType) => {
    chain.push(fx(type, {}, WET.includes(type) ? 0.3 : 1));
    amp.preset = '';
    commit();
  };
  const move = (from: number, to: number) => {
    if (to === from || to === from + 1) return;
    const [x] = chain.splice(from, 1);
    chain.splice(to > from ? to - 1 : to, 0, x);
    amp.preset = '';
    commit();
  };
  const others = (Object.keys(EFFECTS) as EffectType[]).filter((t) => !GUITAR_FX.includes(t));
  return (
    <div class="amp-chain" onDragOver={(e) => dragRef.current && e.preventDefault()}>
      {chain.map((f, i) => {
        const def = EFFECTS[f.type];
        return (
          <div
            class={`pedal ${f.enabled ? '' : 'off'} ${drag?.to === i && drag.from !== i ? 'drop-before' : ''} ${drag?.to === i + 1 && i === chain.length - 1 ? 'drop-after' : ''} ${drag?.from === i ? 'dragging' : ''}`}
            key={f.id}
            onDragOver={(e) => {
              const d = dragRef.current;
              if (!d) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const to = e.clientX < r.left + r.width / 2 ? i : i + 1;
              if (to !== d.to) setDrag({ ...d, to });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const d = dragRef.current;
              if (d) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                move(d.from, e.clientX < r.left + r.width / 2 ? i : i + 1);
              }
              setDrag(null);
            }}
          >
            <div
              class="pedal-head"
              draggable
              data-hint="Arraste para mudar a ordem do efeito na cadeia"
              onDragStart={(e) => {
                e.dataTransfer!.effectAllowed = 'move';
                e.dataTransfer!.setData('text/plain', f.id);
                const card = (e.currentTarget as HTMLElement).parentElement!;
                e.dataTransfer!.setDragImage(card, 20, 12);
                setDrag({ from: i, to: i });
              }}
              onDragEnd={() => setDrag(null)}
            >
              <Icon name="grip" size={12} class="pedal-grip" />
              <button class={`led ${f.enabled ? 'on' : ''}`} data-hint={f.enabled ? 'Desligar (bypass)' : 'Ligar'} onClick={() => set(i, { enabled: !f.enabled })} />
              <span class="pedal-name" data-hint={def.description}>
                {def.label}
              </span>
              <button class="pedal-x" data-hint="Remover da cadeia" onClick={() => (chain.splice(i, 1), (amp.preset = ''), commit())}>
                <Icon name="close" size={10} />
              </button>
            </div>
            <div class="pedal-body">
              {def.params.map((d) => {
                const v = f.params[d.key] ?? d.def;
                if (d.kind === 'enum')
                  return (
                    <label class="pedal-enum">
                      <select value={String(v)} onChange={(e) => set(i, { params: { ...f.params, [d.key]: (e.target as HTMLSelectElement).value } })}>
                        {d.options!.map((o) => (
                          <option>{o}</option>
                        ))}
                      </select>
                      <span>{d.label}</span>
                    </label>
                  );
                if (d.kind !== 'num' || d.key === 'sidechain') return null;
                return (
                  <Knob
                    size={30}
                    value={Number(v)}
                    min={d.min!}
                    max={d.max!}
                    def={Number(d.def)}
                    log={d.curve === 'log' && d.min! > 0}
                    step={d.step}
                    bipolar={d.min! < 0 && d.max! > 0}
                    label={d.label}
                    format={fmtParam(d)}
                    onInput={(x) => {
                      f.params = { ...f.params, [d.key]: x };
                      audio.configAmp({ chain, inGain: amp.inGain, outGain: amp.outGain, pick: amp.pick, bpm: state.project.bpm });
                    }}
                    onCommit={(x) => set(i, { params: { ...f.params, [d.key]: x } })}
                  />
                );
              })}
              {WET.includes(f.type) && (
                <Knob size={30} value={f.mix} min={0} max={1} def={0.3} color="#6fdc8c" label="Mix" format={(x) => `${Math.round(x * 100)}%`} onInput={(x) => set(i, { mix: x })} onCommit={(x) => set(i, { mix: x })} />
              )}
            </div>
          </div>
        );
      })}
      <button class="pedal-add" data-hint="Adicionar efeito no fim da cadeia" onClick={(e) => setMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY })}>
        <Icon name="plus" size={18} />
        <span>Efeito</span>
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={Math.max(8, Math.min(menu.y, window.innerHeight - 440))}
          onClose={() => setMenu(null)}
          items={[...GUITAR_FX.map((t) => [EFFECTS[t].label, () => add(t)] as [string, () => void]), ...others.map((t) => [EFFECTS[t].label, () => add(t)] as [string, () => void])]}
        />
      )}
    </div>
  );
}
