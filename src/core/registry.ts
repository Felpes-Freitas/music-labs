// Catálogo de instrumentos e efeitos: parâmetros, faixas e presets. A interface
// monta os knobs a partir daqui e o MCP usa a mesma descrição para validar.

import type { EffectType, InstrumentType, Params } from './model.js';

export interface ParamDef {
  key: string;
  label: string;
  kind: 'num' | 'enum' | 'bool' | 'text';
  min?: number;
  max?: number;
  def: number | string | boolean;
  unit?: string;
  curve?: 'lin' | 'log';
  options?: string[];
  step?: number;
}

const num = (key: string, label: string, min: number, max: number, def: number, unit = '', curve: 'lin' | 'log' = 'lin', step?: number): ParamDef =>
  ({ key, label, kind: 'num', min, max, def, unit, curve, step });
const en = (key: string, label: string, options: string[], def: string): ParamDef => ({ key, label, kind: 'enum', options, def });
const bool = (key: string, label: string, def: boolean): ParamDef => ({ key, label, kind: 'bool', def });

const WAVES = ['saw', 'square', 'sine', 'triangle', 'noise'];

export const INSTRUMENTS: Record<InstrumentType, { label: string; description: string; params: ParamDef[] }> = {
  synth: {
    label: 'Synth',
    description: 'Subtrativo: 2 osciladores + sub, unison, filtro com envelope, LFO e glide.',
    params: [
      en('osc1', 'Osc 1', WAVES, 'saw'),
      en('osc2', 'Osc 2', WAVES, 'square'),
      num('osc2Semi', 'Osc 2 semi', -24, 24, 0, 'st', 'lin', 1),
      num('osc2Fine', 'Osc 2 fino', -100, 100, 7, 'ct'),
      num('oscMix', 'Mix osc', 0, 1, 0.5),
      num('sub', 'Sub', 0, 1, 0),
      num('noise', 'Ruído', 0, 1, 0),
      num('unison', 'Unison', 1, 7, 1, 'vozes', 'lin', 1),
      num('detune', 'Detune', 0, 100, 15, 'ct'),
      num('spread', 'Abertura', 0, 1, 0.6),
      en('filter', 'Filtro', ['lowpass', 'highpass', 'bandpass', 'off'], 'lowpass'),
      num('cutoff', 'Cutoff', 20, 20000, 4000, 'Hz', 'log'),
      num('res', 'Resson.', 0, 1, 0.2),
      num('fenv', 'Env filtro', -1, 1, 0.3),
      num('fa', 'F ataque', 0.001, 4, 0.005, 's', 'log'),
      num('fd', 'F decay', 0.005, 4, 0.3, 's', 'log'),
      num('fs', 'F sustain', 0, 1, 0.2),
      num('fr', 'F release', 0.005, 6, 0.3, 's', 'log'),
      num('a', 'Ataque', 0.001, 4, 0.005, 's', 'log'),
      num('d', 'Decay', 0.005, 4, 0.3, 's', 'log'),
      num('s', 'Sustain', 0, 1, 0.8),
      num('r', 'Release', 0.005, 8, 0.2, 's', 'log'),
      num('lfoRate', 'LFO', 0.05, 20, 4, 'Hz', 'log'),
      num('lfoPitch', 'LFO→tom', 0, 1, 0, 'st'),
      num('lfoCutoff', 'LFO→filtro', 0, 1, 0),
      num('glide', 'Glide', 0, 1, 0, 's'),
      bool('mono', 'Mono', false),
      num('velSens', 'Sens. vel', 0, 1, 0.6),
      num('gain', 'Ganho', 0, 2, 0.5),
    ],
  },
  sampler: {
    label: 'Sampler',
    description: 'Toca um arquivo de áudio ou um instrumento multi-sample (pasta com um sample por região do teclado). One-shot toca o arquivo inteiro ao apertar (bateria); desligado, a nota dura enquanto a tecla estiver pressionada e solta com o release (instrumentos). Loop sustenta notas longas usando os pontos de loop do arquivo.',
    params: [
      { key: 'sample', label: 'Sample', kind: 'text', def: '' },
      num('root', 'Tom raiz', 0, 127, 60, '', 'lin', 1),
      bool('keytrack', 'Seguir tecla', true),
      num('start', 'Início', 0, 1, 0),
      bool('loop', 'Loop de sustentação', false),
      bool('reverse', 'Reverse', false),
      bool('oneshot', 'One-shot (ignora soltar)', true),
      num('cut', 'Grupo de corte', 0, 16, 0, '', 'lin', 1),
      num('a', 'Ataque', 0.0005, 4, 0.001, 's', 'log'),
      num('d', 'Decay', 0.005, 8, 1, 's', 'log'),
      num('s', 'Sustain', 0, 1, 1),
      num('r', 'Release', 0.005, 8, 0.05, 's', 'log'),
      num('cutoff', 'Cutoff', 20, 20000, 20000, 'Hz', 'log'),
      num('res', 'Resson.', 0, 1, 0),
      num('velSens', 'Sens. vel', 0, 1, 0.7),
      num('gain', 'Ganho', 0, 2, 1),
    ],
  },
  drum: {
    label: 'Drum Synth',
    description: 'Bateria sintetizada: kick, 808, snare, clap, hats, tom, rim e perc. Peça "kit" = bateria completa por tecla (mapa GM: C2 kick, D2 snare, D#2 clap, F#2 hat, A#2 aberto, toms...).',
    params: [
      en('kind', 'Peça', ['kick', '808', 'snare', 'clap', 'hat', 'openhat', 'tom', 'rim', 'perc', 'kit'], 'kick'),
      num('tune', 'Afinação', -24, 24, 0, 'st'),
      num('decay', 'Decay', 0.02, 3, 0.4, 's', 'log'),
      num('tone', 'Tom/cor', 0, 1, 0.5),
      num('punch', 'Punch', 0, 1, 0.5),
      num('snap', 'Snap/ruído', 0, 1, 0.5),
      num('drive', 'Drive', 0, 1, 0.1),
      bool('keytrack', 'Seguir tecla', false),
      num('cut', 'Grupo de corte', 0, 16, 0, '', 'lin', 1),
      num('velSens', 'Sens. vel', 0, 1, 0.7),
      num('gain', 'Ganho', 0, 2, 0.9),
    ],
  },
  pluck: {
    label: 'Pluck',
    description: 'Corda física (Karplus-Strong): violão, harpa, pluck eletrônico.',
    params: [
      num('damp', 'Abafamento', 0, 1, 0.4),
      num('decay', 'Sustentação', 0.5, 0.9999, 0.996, '', 'lin'),
      num('bright', 'Brilho', 0, 1, 0.7),
      num('body', 'Corpo', 0, 1, 0.3),
      num('r', 'Release', 0.005, 4, 0.15, 's', 'log'),
      num('velSens', 'Sens. vel', 0, 1, 0.6),
      num('gain', 'Ganho', 0, 2, 0.8),
    ],
  },
  fm: {
    label: 'FM',
    description: 'FM de 2 operadores: e-piano, sinos, baixos metálicos.',
    params: [
      num('ratio', 'Razão', 0.25, 16, 2, '', 'log'),
      num('index', 'Índice', 0, 20, 3),
      num('indexDecay', 'Decay índice', 0.01, 6, 0.6, 's', 'log'),
      num('feedback', 'Feedback', 0, 1, 0),
      num('a', 'Ataque', 0.001, 4, 0.002, 's', 'log'),
      num('d', 'Decay', 0.005, 8, 1.2, 's', 'log'),
      num('s', 'Sustain', 0, 1, 0.3),
      num('r', 'Release', 0.005, 8, 0.5, 's', 'log'),
      num('velSens', 'Sens. vel', 0, 1, 0.7),
      num('gain', 'Ganho', 0, 2, 0.6),
    ],
  },
};

export const EFFECTS: Record<EffectType, { label: string; description: string; params: ParamDef[] }> = {
  eq: {
    label: 'EQ 4 bandas',
    description: 'Low shelf, dois peaks e high shelf, mais corte de graves (HPF).',
    params: [
      num('hpf', 'HPF', 10, 1000, 10, 'Hz', 'log'),
      num('lowFreq', 'Grave Hz', 30, 500, 100, 'Hz', 'log'),
      num('lowGain', 'Grave', -18, 18, 0, 'dB'),
      num('m1Freq', 'Médio 1 Hz', 100, 4000, 500, 'Hz', 'log'),
      num('m1Gain', 'Médio 1', -18, 18, 0, 'dB'),
      num('m1Q', 'Q 1', 0.2, 10, 1, '', 'log'),
      num('m2Freq', 'Médio 2 Hz', 500, 12000, 3000, 'Hz', 'log'),
      num('m2Gain', 'Médio 2', -18, 18, 0, 'dB'),
      num('m2Q', 'Q 2', 0.2, 10, 1, '', 'log'),
      num('highFreq', 'Agudo Hz', 2000, 18000, 8000, 'Hz', 'log'),
      num('highGain', 'Agudo', -18, 18, 0, 'dB'),
    ],
  },
  filter: {
    label: 'Filtro',
    description: 'Filtro ressonante com LFO sincronizável (wobble, sweeps).',
    params: [
      en('mode', 'Modo', ['lowpass', 'highpass', 'bandpass'], 'lowpass'),
      num('cutoff', 'Cutoff', 20, 20000, 2000, 'Hz', 'log'),
      num('res', 'Resson.', 0, 1, 0.3),
      num('lfoDepth', 'LFO prof.', 0, 1, 0),
      en('lfoSync', 'LFO ritmo', ['1/1', '1/2', '1/4', '1/8', '1/16', '1/4T', '1/8T'], '1/4'),
    ],
  },
  compressor: {
    label: 'Compressor',
    description: 'Compressor com knee suave e sidechain de outro insert (ducking).',
    params: [
      num('threshold', 'Threshold', -60, 0, -18, 'dB'),
      num('ratio', 'Ratio', 1, 20, 4, ':1', 'log'),
      num('attack', 'Ataque', 0.1, 200, 10, 'ms', 'log'),
      num('release', 'Release', 10, 1500, 120, 'ms', 'log'),
      num('knee', 'Knee', 0, 24, 6, 'dB'),
      num('makeup', 'Makeup', 0, 24, 0, 'dB'),
      num('sidechain', 'Sidechain (insert)', -1, 16, -1, '', 'lin', 1),
    ],
  },
  delay: {
    label: 'Delay',
    description: 'Delay estéreo sincronizado ao BPM, com ping-pong e filtro no feedback.',
    params: [
      en('time', 'Tempo', ['1/32', '1/16', '1/16D', '1/8T', '1/8', '1/8D', '1/4T', '1/4', '1/4D', '1/2', '1/1'], '1/8D'),
      num('feedback', 'Feedback', 0, 0.95, 0.4),
      bool('pingpong', 'Ping-pong', true),
      num('tone', 'Tom', 500, 16000, 5000, 'Hz', 'log'),
    ],
  },
  reverb: {
    label: 'Reverb',
    description: 'Reverb algorítmico (rede de combs + allpass) com pré-delay e damping.',
    params: [
      num('size', 'Tamanho', 0, 1, 0.7),
      num('damp', 'Damping', 0, 1, 0.4),
      num('predelay', 'Pré-delay', 0, 200, 15, 'ms'),
      num('width', 'Largura', 0, 1, 1),
      num('lowcut', 'Corte grave', 20, 1000, 150, 'Hz', 'log'),
    ],
  },
  chorus: {
    label: 'Chorus',
    description: 'Chorus/flanger estéreo.',
    params: [
      num('rate', 'Rate', 0.05, 8, 0.8, 'Hz', 'log'),
      num('depth', 'Profund.', 0, 1, 0.5),
      num('delay', 'Delay', 1, 30, 12, 'ms'),
      num('feedback', 'Feedback', 0, 0.9, 0.1),
    ],
  },
  distortion: {
    label: 'Saturação',
    description: 'Saturação/distorção com vários tipos de curva e tom.',
    params: [
      en('mode', 'Tipo', ['soft', 'hard', 'tube', 'fold'], 'soft'),
      num('drive', 'Drive', 0, 36, 6, 'dB'),
      num('tone', 'Tom', 500, 20000, 12000, 'Hz', 'log'),
      num('output', 'Saída', -24, 6, -3, 'dB'),
    ],
  },
  bitcrusher: {
    label: 'Bitcrusher',
    description: 'Redução de bits e de taxa de amostragem.',
    params: [num('bits', 'Bits', 1, 16, 8, '', 'lin', 1), num('downsample', 'Downsample', 1, 32, 4, 'x', 'log')],
  },
  stereo: {
    label: 'Imagem estéreo',
    description: 'Largura estéreo (M/S), mono abaixo de uma frequência e ganho.',
    params: [
      num('width', 'Largura', 0, 2, 1),
      num('monoBelow', 'Mono abaixo de', 10, 500, 10, 'Hz', 'log'),
      num('gain', 'Ganho', -24, 12, 0, 'dB'),
    ],
  },
  limiter: {
    label: 'Limiter',
    description: 'Limiter com lookahead para o master.',
    params: [num('gain', 'Ganho', 0, 24, 0, 'dB'), num('ceiling', 'Teto', -12, 0, -0.3, 'dBFS'), num('release', 'Release', 10, 1000, 80, 'ms', 'log')],
  },
};

export function defaults(defs: ParamDef[]): Params {
  const o: Params = {};
  for (const d of defs) o[d.key] = d.def;
  return o;
}

/** Corrige e limita valores segundo a definição. Lança erro em chave desconhecida. */
export function sanitizeParams(defs: ParamDef[], input: Record<string, unknown>): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(input)) {
    const d = defs.find((x) => x.key === k);
    if (!d) throw new Error(`Parâmetro desconhecido "${k}". Válidos: ${defs.map((x) => x.key).join(', ')}`);
    if (d.kind === 'num') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} precisa ser número`);
      out[k] = Math.min(d.max!, Math.max(d.min!, n));
    } else if (d.kind === 'bool') out[k] = v === true || v === 'true' || v === 1;
    else if (d.kind === 'enum') {
      if (!d.options!.includes(String(v))) throw new Error(`${k} deve ser um de: ${d.options!.join(', ')}`);
      out[k] = String(v);
    } else out[k] = String(v);
  }
  return out;
}

// Presets de instrumento: ponto de partida para o produtor e para o MCP.
export const PRESETS: Record<string, { type: InstrumentType; params: Params; description: string }> = {
  'Kick': { type: 'drum', params: { kind: 'kick', decay: 0.45, punch: 0.6, tone: 0.4 }, description: 'Kick encorpado' },
  'Kick Hard': { type: 'drum', params: { kind: 'kick', decay: 0.3, punch: 0.9, tone: 0.7, drive: 0.5 }, description: 'Kick seco e agressivo (EDM/techno)' },
  '808': { type: 'drum', params: { kind: '808', decay: 1.4, punch: 0.4, keytrack: true, drive: 0.25 }, description: '808 longo que segue a tecla (trap/funk)' },
  'Snare': { type: 'drum', params: { kind: 'snare', decay: 0.25, tone: 0.5, snap: 0.6 }, description: 'Caixa' },
  'Clap': { type: 'drum', params: { kind: 'clap', decay: 0.3, tone: 0.6 }, description: 'Palma' },
  'Hat': { type: 'drum', params: { kind: 'hat', decay: 0.05, tone: 0.7, cut: 1 }, description: 'Chimbal fechado' },
  'Open Hat': { type: 'drum', params: { kind: 'openhat', decay: 0.35, tone: 0.7, cut: 1 }, description: 'Chimbal aberto (corta com o fechado)' },
  'Drum Kit': { type: 'drum', params: { kind: 'kit', decay: 0.4, gain: 0.85 }, description: 'Bateria completa num canal só, por tecla (mapa GM: C2 kick, D2 snare, D#2 clap, F#2 hat, A#2 aberto)' },
  'Tom': { type: 'drum', params: { kind: 'tom', decay: 0.4, keytrack: true }, description: 'Tom' },
  'Rim': { type: 'drum', params: { kind: 'rim', decay: 0.08 }, description: 'Aro' },
  'Perc': { type: 'drum', params: { kind: 'perc', decay: 0.15, tone: 0.6 }, description: 'Percussão (conga/tamborim)' },
  'Supersaw': { type: 'synth', params: { osc1: 'saw', osc2: 'saw', osc2Fine: 12, unison: 7, detune: 25, spread: 1, cutoff: 9000, fenv: 0.1, a: 0.01, r: 0.35, gain: 0.5 }, description: 'Lead/acordes largos de EDM' },
  'Sub Bass': { type: 'synth', params: { osc1: 'sine', osc2: 'triangle', oscMix: 0.15, cutoff: 600, fenv: 0, mono: true, glide: 0.03, a: 0.003, r: 0.08, gain: 0.7 }, description: 'Sub limpo' },
  'Reese Bass': { type: 'synth', params: { osc1: 'saw', osc2: 'saw', osc2Fine: 18, unison: 3, detune: 20, cutoff: 900, res: 0.3, fenv: 0.15, mono: true, gain: 0.45 }, description: 'Baixo reese (DnB)' },
  'Acid Bass': { type: 'synth', params: { osc1: 'saw', oscMix: 0, cutoff: 300, res: 0.8, fenv: 0.7, fd: 0.18, fs: 0, mono: true, glide: 0.06, gain: 0.5 }, description: 'Baixo ácido estilo 303' },
  'Pluck Lead': { type: 'synth', params: { osc1: 'saw', osc2: 'square', osc2Fine: 5, unison: 3, cutoff: 600, res: 0.3, fenv: 0.8, fd: 0.2, fs: 0, d: 0.35, s: 0, r: 0.3, gain: 0.4 }, description: 'Pluck sintético (house/future)' },
  'Warm Pad': { type: 'synth', params: { osc1: 'saw', osc2: 'triangle', osc2Fine: 9, unison: 5, detune: 18, cutoff: 1800, res: 0.1, fenv: 0.1, a: 0.6, d: 1, s: 0.8, r: 1.6, lfoRate: 0.3, lfoCutoff: 0.2, gain: 0.6 }, description: 'Pad quente' },
  'Brass': { type: 'synth', params: { osc1: 'saw', osc2: 'saw', osc2Fine: 6, cutoff: 900, fenv: 0.6, fa: 0.06, fd: 0.4, fs: 0.5, a: 0.04, s: 0.9, r: 0.2, gain: 0.4 }, description: 'Metais sintetizados' },
  'Square Lead': { type: 'synth', params: { osc1: 'square', osc2: 'square', osc2Semi: 12, oscMix: 0.3, cutoff: 5000, mono: true, glide: 0.05, lfoRate: 5.5, lfoPitch: 0.15, gain: 0.35 }, description: 'Lead quadrado com vibrato' },
  'E-Piano': { type: 'fm', params: { ratio: 1, index: 2.2, indexDecay: 0.8, d: 2.5, s: 0.15, r: 0.6 }, description: 'Piano elétrico (FM)' },
  'Bell': { type: 'fm', params: { ratio: 3.5, index: 5, indexDecay: 1.5, a: 0.001, d: 3, s: 0, r: 2 }, description: 'Sino' },
  'FM Bass': { type: 'fm', params: { ratio: 1, index: 4, indexDecay: 0.2, feedback: 0.2, d: 0.6, s: 0.6, r: 0.1, gain: 0.7 }, description: 'Baixo FM' },
  'Guitar Pluck': { type: 'pluck', params: { damp: 0.35, decay: 0.997, bright: 0.6, body: 0.4 }, description: 'Corda dedilhada' },
  'Harp': { type: 'pluck', params: { damp: 0.15, decay: 0.998, bright: 0.85, body: 0.2 }, description: 'Harpa' },
};

export function presetParams(name: string): { type: InstrumentType; params: Params } | undefined {
  const pr = PRESETS[name] ?? Object.entries(PRESETS).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  if (!pr) return undefined;
  return { type: pr.type, params: { ...defaults(INSTRUMENTS[pr.type].params), ...pr.params } };
}
