// Soundpad: instrumento de 16 pads (4×4). Cada pad é um som próprio — um sample (ou
// instrumento multi-sample) ou um instrumento nativo/preset — e toca numa nota fixa:
// pad 1 (embaixo à esquerda) = C2, como nas baterias eletrônicas. A configuração fica em
// params.pads (texto JSON), então passa por desfazer, MCP e projeto salvo sem mudar o modelo.

import type { InstrumentType, Params } from './model.js';

export const PAD_COUNT = 16;
/** Nota do pad 1 (embaixo à esquerda). */
export const PAD_BASE = 36;
/** Cores clássicas por linha, de cima para baixo. */
export const PAD_ROW_COLORS = ['#e5484d', '#f5a524', '#46a758', '#3e8ed0'];
/** Teclado do computador em grade 4×4 (linha de cima → de baixo), igual aos pads na tela. */
export const PAD_KEYS = ['1234', 'qwer', 'asdf', 'zxcv'];

export interface PadSlot {
  name: string;
  /** Arquivo de áudio ou pasta de instrumento multi-sample. */
  sample?: string;
  /** Ou um instrumento do Music Labs (com params; preset já vem expandido em params). */
  type?: InstrumentType;
  params?: Params;
  /** Nota tocada no som do pad (padrão C4 = altura original do sample). */
  note?: number;
  /** Ganho do pad em dB. */
  gain?: number;
  /** Afinação em semitons. */
  tune?: number;
}

/** Índice do pad (0 = embaixo à esquerda) para a linha/coluna na tela (linha 0 = de cima). */
export const padIndex = (row: number, col: number) => (3 - row) * 4 + col;
export const padRow = (i: number) => 3 - Math.floor(i / 4);
export const padColor = (i: number) => PAD_ROW_COLORS[padRow(i)];
export const padNote = (i: number) => PAD_BASE + i;
/** Tecla do computador do pad. */
export const padKey = (i: number) => PAD_KEYS[padRow(i)][i % 4];

export function parsePads(s: unknown): (PadSlot | null)[] {
  let list: unknown = [];
  try {
    list = typeof s === 'string' && s ? JSON.parse(s) : [];
  } catch {
    list = [];
  }
  const out: (PadSlot | null)[] = [];
  for (let i = 0; i < PAD_COUNT; i++) {
    const x = Array.isArray(list) ? list[i] : null;
    out.push(x && typeof x === 'object' && (x as PadSlot).name !== undefined ? (x as PadSlot) : null);
  }
  return out;
}

export const stringifyPads = (pads: (PadSlot | null)[]) => JSON.stringify(Array.from({ length: PAD_COUNT }, (_, i) => pads[i] ?? null));

/** Peça do Drum Synth nativo (o kit básico funciona sem nenhum sample instalado). */
const synth = (name: string, kind: string, extra: Params = {}): PadSlot => ({ name, type: 'drum', params: { kind, ...extra } });

/** Kits prontos (só instrumentos nativos; os de samples são montados na interface a partir da biblioteca). */
export const PAD_KITS: { id: string; label: string; pads: (PadSlot | null)[] }[] = [
  {
    id: 'basico',
    label: 'Básico (sintetizado)',
    // ordem dos índices: de baixo para cima, da esquerda para a direita
    pads: [
      synth('Kick', 'kick'),
      synth('Snare', 'snare'),
      synth('Clap', 'clap'),
      synth('Hat', 'hat'),
      synth('808', '808'),
      synth('Rim', 'rim'),
      synth('Hat aberto', 'openhat'),
      synth('Perc', 'perc'),
      synth('Tom grave', 'tom', { tune: -5 }),
      synth('Tom médio', 'tom'),
      synth('Tom agudo', 'tom', { tune: 5 }),
      synth('Kick seco', 'kick', { decay: 0.18, punch: 0.9 }),
      synth('Snare 2', 'snare', { tone: 0.75, snap: 0.8 }),
      synth('Clap longo', 'clap', { decay: 0.8 }),
      synth('Perc 2', 'perc', { tune: 7 }),
      synth('808 longo', '808', { decay: 1.6 }),
    ],
  },
  {
    id: 'break',
    label: 'Break (sintetizado)',
    pads: [
      synth('Kick', 'kick', { punch: 0.8, drive: 0.4 }),
      synth('Snare', 'snare', { snap: 0.9, drive: 0.3 }),
      synth('Ghost', 'snare', { decay: 0.12, tone: 0.3 }),
      synth('Hat', 'hat', { decay: 0.05 }),
      synth('Kick 2', 'kick', { decay: 0.25, tune: 3 }),
      synth('Rim', 'rim'),
      synth('Hat aberto', 'openhat', { decay: 0.35 }),
      synth('Shaker', 'hat', { decay: 0.12, tone: 0.8 }),
      synth('Tom grave', 'tom', { tune: -7 }),
      synth('Tom médio', 'tom', { tune: -2 }),
      synth('Tom agudo', 'tom', { tune: 4 }),
      synth('Clap', 'clap'),
      synth('Snare seca', 'snare', { decay: 0.15, drive: 0.6 }),
      synth('Perc', 'perc'),
      synth('Perc 2', 'perc', { tune: -5 }),
      synth('Crash', 'openhat', { decay: 1.8, tone: 0.3 }),
    ],
  },
];

export const DEFAULT_PADS = stringifyPads(PAD_KITS[0].pads);

/** Samples que um canal precisa carregar (sampler e pads com sample). */
export function channelSamples(ch: { type: InstrumentType; params: Params }): string[] {
  if (ch.type === 'sampler') return ch.params.sample ? [String(ch.params.sample)] : [];
  if (ch.type === 'pads') return parsePads(ch.params.pads).flatMap((s) => (s?.sample ? [s.sample] : []));
  return [];
}
