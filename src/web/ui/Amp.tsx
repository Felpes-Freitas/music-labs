// Amp de guitarra: entrada de áudio → cadeia de efeitos (reordenável) → ouvir e
// gravar direto na playlist, já com os efeitos. A configuração (cadeia, entrada,
// presets do usuário) fica salva no computador, não no projeto.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { useApp, state, toggleRecord, toast, emit, onLive } from '../state';
import { audio, type RecChannels } from '../audio';
import { EFFECTS, GUITAR_FX, type ParamDef } from '../../core/registry';
import type { EffectType, Params } from '../../core/model';
import { noteName } from '../../core/model';
import { trackPitch } from '../../core/pitchtrack';
import { uid } from '../../core/model';
import { getPref, setPref, usePref } from '../prefs';
import { Win, Knob, ContextMenu, fmt } from './widgets';
import { Icon } from './icons';
import { reampChannel, reampBusy, closeAmpReamp } from '../reamp';
import { ampSig, ampAutomated, ampParamPath } from '../../core/reamp';
import { set as setOp } from '../../core/ops';
import { edit, previewEdit } from '../state';
import type { Channel } from '../../core/model';
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
  /** Retorno nativo (fora do navegador, baixa latência) e o tamanho do bloco dele. */
  native: boolean;
  buffer: number;
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
    native: p.native ?? true,
    buffer: p.buffer ?? 128,
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
/**
 * Preset do usuário: a cadeia e também os ajustes de entrada/saída e da gravação
 * inteligente (o que entra e o que não entra na gravação). Presets antigos eram só a cadeia.
 */
interface UserPreset {
  chain: AmpFx[];
  inGain?: number;
  outGain?: number;
  smart?: boolean;
  thresholdDb?: number;
  marginDb?: number;
  holdSec?: number;
}
const userPresets = () => {
  const raw = getPref<Record<string, AmpFx[] | UserPreset>>('amp.presets', {});
  const out: Record<string, UserPreset> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? { chain: v } : v;
  return out;
};

const listeners = new Set<() => void>();
/** Grava as preferências, manda a cadeia para o áudio e redesenha. */
/** Melodify aberto: o retorno toca a guitarra limpa (sem nenhum efeito). */
let tunerOpen = false;
const liveChain = () => (tunerOpen ? [] : amp.chain);

function commit() {
  setPref('amp', amp);
  audio.configAmp({ chain: liveChain(), inGain: amp.inGain, outGain: amp.outGain, pick: amp.pick, bpm: state.project.bpm });
  // com o retorno nativo, o do navegador fica mudo (só serve para o visualizador)
  audio.setAmpMonitor(amp.monitor && !(amp.native && nativeOk));
  syncNative();
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- retorno nativo (servidor, PipeWire)

let nativeOk = false; // o servidor consegue fazer o retorno nativo (Linux + PipeWire)
let ampOpen = false;
let nativeTimer = 0;
let nativeLast = '';
let sourcesCache: { name: string; description: string }[] = [];
/** Entrada do PipeWire com o mesmo nome da entrada escolhida no amp (ou a padrão). */
function nativeSource(devices: { id: string; label: string }[]) {
  const label = devices.find((d) => d.id === amp.device)?.label ?? '';
  return sourcesCache.find((s) => s.description === label)?.name ?? '';
}
let devicesNow: { id: string; label: string }[] = [];
/** Manda a cadeia e o estado para o retorno nativo (no máximo ~30 vezes por segundo). */
function syncNative() {
  clearTimeout(nativeTimer);
  nativeTimer = window.setTimeout(() => {
    const on = nativeOk && ampOpen && amp.native && amp.monitor;
    const body = on
      ? { on: true, buffer: amp.buffer, source: nativeSource(devicesNow), pick: amp.pick, inGain: amp.inGain, outGain: amp.outGain, bpm: state.project.bpm, chain: liveChain() }
      : { on: false };
    const json = JSON.stringify(body);
    if (json === nativeLast) return;
    nativeLast = json;
    fetch('/api/monitor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json }).catch(() => {});
  }, 30);
}

let recFromAmp = false;

export function AmpWindow() {
  const s = useApp();
  const open = s.windows.amp.open;
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [on, setOn] = useState(false);
  const [tuner, setTunerState] = useState(false);
  const setTuner = (v: boolean) => {
    tunerOpen = v;
    setTunerState(v);
    commit();
  };
  useEffect(() => {
    listeners.add(force as () => void);
    return () => void listeners.delete(force as () => void);
  }, []);
  // liga a entrada quando a janela abre (e quando muda a entrada); desliga ao fechar
  // editando os pedais de uma gravação (reamp)
  const rch = reampChannel ? s.project.channels.find((c) => c.id === reampChannel && c.amp) : undefined;
  useEffect(() => {
    ampOpen = open;
    if (!open) {
      if (reampChannel) closeAmpReamp();
      audio.stopAmp();
      setOn(false);
      syncNative();
      return;
    }
    // editando uma gravação: a entrada da guitarra fica desligada
    if (reampChannel) {
      audio.stopAmp();
      setOn(false);
      return;
    }
    fetch('/api/monitor')
      .then((r) => r.json())
      .then((st) => {
        nativeOk = !!st.available;
        return nativeOk ? fetch('/api/monitor/sources').then((r) => r.json()) : [];
      })
      .then((list) => {
        sourcesCache = list;
        commit();
      })
      .catch(() => {});
    let dead = false;
    audio
      .startAmp(amp.device)
      .then(() => {
        if (dead) return;
        setOn(true);
        commit();
        audio.inputDevices().then((d) => {
          devicesNow = d;
          setDevices(d);
          syncNative();
        });
      })
      .catch((e) => {
        setOn(false);
        toast(`Amp: não consegui abrir a entrada de áudio (${(e as Error).message})`);
      });
    return () => void (dead = true);
  }, [open, amp.device, !!rch]);
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
    amp.chain = u ? u.chain.map((x) => ({ ...x, id: uid('a'), params: { ...x.params } })) : PRESETS[name]?.() ?? amp.chain;
    if (u) {
      // os ajustes guardados com o preset (presets antigos não têm: ficam como estão)
      if (u.inGain !== undefined) amp.inGain = u.inGain;
      if (u.outGain !== undefined) amp.outGain = u.outGain;
      if (u.smart !== undefined) amp.smart = u.smart;
      if (u.thresholdDb !== undefined) amp.thresholdDb = u.thresholdDb;
      if (u.marginDb !== undefined) amp.marginDb = u.marginDb;
      if (u.holdSec !== undefined) amp.holdSec = u.holdSec;
    }
    amp.preset = name;
    commit();
  };
  const savePreset = async () => {
    const name = await askText({ title: 'Salvar preset do amp', label: 'Nome', value: PRESETS[amp.preset] ? '' : amp.preset, placeholder: 'Meu timbre', ok: 'Salvar' });
    if (!name) return;
    if (PRESETS[name]) return toast('Esse nome é de um preset de fábrica; escolha outro.');
    const preset: UserPreset = { chain: amp.chain, inGain: amp.inGain, outGain: amp.outGain, smart: amp.smart, thresholdDb: amp.thresholdDb, marginDb: amp.marginDb, holdSec: amp.holdSec };
    setPref('amp.presets', { ...userPresets(), [name]: preset });
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

  if (rch) return <ReampView ch={rch} />;
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
          <button class="amp-tune-btn" disabled={!on} onClick={() => setTuner(true)} data-hint="Afinador de guitarra: enquanto estiver aberto, o retorno toca a guitarra limpa, sem efeitos">
            <Icon name="tune" size={13} /> Afinar
          </button>
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
            <button onClick={savePreset} data-hint="Salvar como preset: os efeitos, a entrada e a saída e os ajustes da gravação (só quando tocar, limiar, margem, pausa)">
              <Icon name="save" size={13} />
            </button>
            {userPresets()[amp.preset] && (
              <button onClick={deletePreset} data-hint="Apagar este preset">
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          {!on ? (
            <span class="amp-off">Entrada desligada</span>
          ) : (
            <div class="amp-ret" data-hint="Retorno: o som que você ouve enquanto toca. Nativo = direto pelo sistema (PipeWire), bem mais rápido; Navegador = pelo app, mais atrasado. A gravação usa o sinal cru e reaplica os efeitos em alta qualidade, nos dois casos.">
              {nativeOk && (
                <div class="seg">
                  <button class={amp.native ? 'on' : ''} onClick={() => ((amp.native = true), commit())}>
                    Nativo
                  </button>
                  <button class={!amp.native ? 'on' : ''} onClick={() => ((amp.native = false), commit())}>
                    Navegador
                  </button>
                </div>
              )}
              {nativeOk && amp.native ? (
                <label class="amp-buf" data-hint="Tamanho do bloco do retorno, em amostras. Menor = menos atraso; se estalar, aumente. 128 costuma ser seguro; 64 é o mínimo, mas pode estalar.">
                  <span>Bloco</span>
                  <input
                    type="number"
                    min={32}
                    max={1024}
                    step={32}
                    value={amp.buffer}
                    onChange={(e) => {
                      const v = Math.max(32, Math.min(1024, Math.round(Number((e.target as HTMLInputElement).value) || 128)));
                      amp.buffer = v;
                      commit();
                    }}
                  />
                  <small>
                    ≈ {((amp.buffer / 48000) * 1000 * 3).toFixed(1)} ms
                  </small>
                </label>
              ) : (
                <span class="amp-lat">retorno {audio.monitorLatencyMs ?? '–'} ms</span>
              )}
            </div>
          )}
        </div>
        <Visualizer />
        <Chain {...liveChainProps()} />
        {tuner && on && <GuitarTuner onClose={() => setTuner(false)} />}
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

// ---------------------------------------------------------------- afinador de guitarra

const STRINGS: { name: string; midi: number }[] = [
  { name: 'E', midi: 40 },
  { name: 'A', midi: 45 },
  { name: 'D', midi: 50 },
  { name: 'G', midi: 55 },
  { name: 'B', midi: 59 },
  { name: 'e', midi: 64 },
];

/** Janelinha de afinação: lê a entrada crua e mostra a nota e quantos cents falta. */
function GuitarTuner(p: { onClose: () => void }) {
  const [read, setRead] = useState<{ midi: number; freq: number } | null>(null);
  useEffect(() => {
    const tap = audio.ampTap();
    if (!tap) return;
    const buf = new Float32Array(tap.an.fftSize);
    const hist: number[] = [];
    let raf = 0, last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 70) return;
      last = t;
      tap.an.getFloatTimeDomainData(buf);
      let pk = 0;
      for (const v of buf) pk = Math.max(pk, Math.abs(v));
      if (pk < 0.004) {
        // silêncio: mantém a última leitura um pouco e depois apaga
        if (hist.length) hist.shift();
        if (!hist.length) setRead(null);
        return;
      }
      const tr = trackPitch(buf, tap.sr, 60, 1200);
      const v = Array.from(tr.midi).filter((m) => !Number.isNaN(m));
      if (v.length < 3) return;
      v.sort((a, b) => a - b);
      hist.push(v[v.length >> 1]);
      if (hist.length > 5) hist.shift();
      const sm = [...hist].sort((a, b) => a - b)[hist.length >> 1];
      setRead({ midi: sm, freq: 440 * Math.pow(2, (sm - 69) / 12) });
    };
    raf = requestAnimationFrame(tick);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    window.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(raf);
      tap.off();
      window.removeEventListener('keydown', key);
    };
  }, []);
  const near = read ? Math.round(read.midi) : null;
  const cents = read ? Math.round((read.midi - near!) * 100) : 0;
  const inTune = read !== null && Math.abs(cents) <= 4;
  const str = read ? STRINGS.reduce((b, s) => (Math.abs(s.midi - read.midi) < Math.abs(b.midi - read.midi) ? s : b)) : null;
  return (
    <div class="gtuner-back" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="gtuner">
        <div class="gtuner-head">
          <b>Afinar guitarra</b>
          <span class="dim small">ouvindo a entrada limpa, sem efeitos</span>
          <button class="win-btn win-close" onClick={p.onClose} data-hint="Fechar (Esc)">
            <Icon name="close" size={12} />
          </button>
        </div>
        <div class={`gtuner-note ${inTune ? 'ok' : ''}`}>{near !== null ? noteName(near).replace(/-?\d+$/, '') : '–'}</div>
        <div class="gtuner-sub">{read ? `${noteName(near!)} · ${read.freq.toFixed(1)} Hz` : 'Toque uma corda solta'}</div>
        <div class="gtuner-meter">
          {[-50, -25, 0, 25, 50].map((c) => (
            <span class="gtuner-tick" style={{ left: `${50 + c}%` }}>
              {c > 0 ? `+${c}` : c}
            </span>
          ))}
          <div class="gtuner-zone" />
          {read && <div class={`gtuner-needle ${inTune ? 'ok' : Math.abs(cents) < 15 ? 'near' : ''}`} style={{ left: `${50 + Math.max(-50, Math.min(50, cents))}%` }} />}
        </div>
        <div class="gtuner-hint">{!read ? '' : inTune ? 'Afinada ✓' : cents < 0 ? `Baixa ${-cents} cents — aperte a tarraxa` : `Alta ${cents} cents — afrouxe a tarraxa`}</div>
        <div class="gtuner-strings">
          {STRINGS.map((s) => (
            <span class={str?.midi === s.midi ? 'on' : ''}>{s.name}</span>
          ))}
        </div>
      </div>
    </div>
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
const WET: EffectType[] = ['delay', 'reverb', 'chorus', 'phaser', 'capo'];

/** Oitava do capotraste em um clique (−1 = guitarra soando como baixo). */
function CapoOctave({ f, set }: { f: AmpFx; set: (o: number) => void }) {
  const o = Number(f.params.octave ?? 0);
  const total = Number(f.params.semis ?? 0) + 12 * o;
  return (
    <div class="capo-oct">
      <div class="seg">
        {[-2, -1, 0, 1, 2].map((x) => (
          <button class={o === x ? 'on' : ''} data-hint={x === -1 ? 'Uma oitava abaixo: a guitarra soa como baixo' : x === 0 ? 'Oitava original' : `${x > 0 ? '+' : ''}${x} oitava${Math.abs(x) > 1 ? 's' : ''}`} onClick={() => set(x)}>
            {x > 0 ? `+${x}` : x}
          </button>
        ))}
      </div>
      <span>Oitava · total {total > 0 ? '+' : ''}{total} st</span>
    </div>
  );
}

/** Cadeia do amp ao vivo (preferências do computador). */
const liveChainProps = (): ChainProps => ({
  chain: amp.chain,
  update: (next, final) => {
    amp.chain = next;
    amp.preset = '';
    if (final) commit();
    else {
      audio.configAmp({ chain: liveChain(), inGain: amp.inGain, outGain: amp.outGain, pick: amp.pick, bpm: state.project.bpm });
      syncNative();
    }
  },
});

interface ChainProps {
  chain: AmpFx[];
  /** Nova cadeia; final = soltou o controle (grava); senão é só prévia (arrastando). */
  update: (next: AmpFx[], final: boolean) => void;
  /** Automação de um parâmetro (só nas gravações: o bruto passa pelos pedais na hora). */
  auto?: (f: AmpFx, key: string, label: string) => { path: (string | number)[]; label: string };
}

function Chain(props: ChainProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDragState] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number } | null>(null);
  const setDrag = (d: { from: number; to: number } | null) => ((dragRef.current = d), setDragState(d));
  const chain = props.chain;
  const set = (i: number, patch: Partial<AmpFx>, final = true) => props.update(chain.map((x, j) => (j === i ? { ...x, ...patch } : x)), final);
  const add = (type: EffectType) => {
    // o capotraste vai no começo: mudar o tom do sinal limpo soa bem melhor que do distorcido
    props.update(type === 'capo' ? [fx(type, {}, 1), ...chain] : [...chain, fx(type, {}, WET.includes(type) ? 0.3 : 1)], true);
  };
  const move = (from: number, to: number) => {
    if (to === from || to === from + 1) return;
    const next = [...chain];
    const [x] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, x);
    props.update(next, true);
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
              <button class="pedal-x" data-hint="Remover da cadeia" onClick={() => props.update(chain.filter((_, j) => j !== i), true)}>
                <Icon name="close" size={10} />
              </button>
            </div>
            <div class="pedal-body">
              {f.type === 'capo' && <CapoOctave f={f} set={(o) => set(i, { params: { ...f.params, octave: o } })} />}
              {def.params.map((d) => {
                const v = f.params[d.key] ?? d.def;
                if (f.type === 'capo' && d.key === 'octave') return null;
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
                    auto={props.auto?.(f, d.key, `${def.label} · ${d.label}`)}
                    onInput={(x) => set(i, { params: { ...f.params, [d.key]: x } }, false)}
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

// ---------------------------------------------------------------- reamp de uma gravação

/**
 * Pedais de uma gravação do amp: a mesma cadeia, mas guardada no canal da gravação. Mudar
 * refaz o áudio a partir do bruto (em segundo plano); enquanto isso, e com automação nos
 * pedais, a gravação toca o bruto pelos pedais em tempo real.
 */
function ReampView({ ch }: { ch: Channel }) {
  const s = useApp();
  const a = ch.amp!;
  const path = ['channels', ch.id, 'amp'];
  const busy = reampBusy.has(ch.id);
  const automated = ampAutomated(s.project, ch.id);
  const fresh = a.sig === ampSig(a);
  const takes = (s.project.audios ?? []).filter((x) => x.channel === ch.id && x.raw).length;
  const update = (next: AmpFx[], final: boolean) => (final ? edit : previewEdit)([setOp([...path, 'chain'], next)]);
  const presetNames = [...Object.keys(PRESETS), ...Object.keys(userPresets())];
  const status = automated
    ? 'Com automação nos pedais: toca o áudio bruto pelos pedais em tempo real'
    : busy
      ? 'Refazendo o áudio com os pedais novos… (enquanto isso ele toca em tempo real)'
      : fresh
        ? 'Em dia: toca a versão já processada (alta qualidade, sem custo)'
        : 'Mudou: toca em tempo real até refazer o áudio';
  return (
    <Win id="amp" title={<>Amp · <span class="dim">{ch.name}</span></>} icon="guitar" minW={560} minH={300}>
      <div class="amp">
        <div class="amp-top reamp-top">
          <div class="reamp-info">
            <b>Reamp: {ch.name}</b>
            <span class="dim">
              {takes} take{takes > 1 ? 's' : ''} · o áudio bruto fica guardado; mudar os pedais refaz a gravação
            </span>
            <span class={`reamp-st ${automated || !fresh ? 'live' : ''}`}>{status}</span>
          </div>
          <Knob size={28} value={a.outGainDb ?? 0} min={-36} max={12} def={0} label="Saída" format={(v) => `${v.toFixed(1)} dB`} onInput={(v) => previewEdit([setOp([...path, 'outGainDb'], v)])} onCommit={(v) => edit([setOp([...path, 'outGainDb'], v)])} />
          <div class="amp-presets">
            <span>Preset</span>
            <select
              value=""
              onChange={(e) => {
                const name = (e.target as HTMLSelectElement).value;
                const u = userPresets()[name];
                const chain = u ? u.chain.map((x) => ({ ...x, id: uid('a'), params: { ...x.params } })) : PRESETS[name]?.();
                if (chain) edit([setOp([...path, 'chain'], chain)]);
              }}
            >
              <option value="">trocar a cadeia…</option>
              {presetNames.map((n) => (
                <option value={n}>{n}</option>
              ))}
            </select>
            <button onClick={() => edit([setOp([...path, 'chain'], amp.chain.map((x) => ({ ...x, id: uid('a'), params: { ...x.params } })))])} data-hint="Usar nesta gravação os pedais do amp ao vivo">
              Usar os do amp ao vivo
            </button>
          </div>
          <button onClick={closeAmpReamp} data-hint="Voltar ao amp ao vivo (tocar e gravar)">
            <Icon name="guitar" size={13} /> Amp ao vivo
          </button>
        </div>
        <Chain chain={a.chain} update={update} auto={(f, key, label) => ({ path: ampParamPath(ch.id, f.id, key), label: `${ch.name} · ${label}` })} />
      </div>
    </Win>
  );
}
