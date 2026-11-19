// Detecção de tom (tonalidade) a partir de notas cantadas/tocadas, e utilidades
// de escala para "qual nota a pessoa quis cantar".

import { SCALES } from './theory.js';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_PT = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];

export const SCALE_LABELS: Record<string, string> = {
  major: 'maior',
  minor: 'menor',
  harmonicMinor: 'menor harmônica',
  melodicMinor: 'menor melódica',
  dorian: 'dórica',
  phrygian: 'frígia',
  lydian: 'lídia',
  mixolydian: 'mixolídia',
  locrian: 'lócria',
  pentatonicMajor: 'pentatônica maior',
  pentatonicMinor: 'pentatônica menor',
  blues: 'blues',
  chromatic: 'cromática',
};

export interface Key {
  root: number; // classe de altura 0..11
  scale: string; // chave de SCALES
}

export const keyLabel = (k: Key) => (k.scale === 'chromatic' ? 'cromática' : `${NOTE_NAMES_PT[k.root]} ${SCALE_LABELS[k.scale] ?? k.scale}`);
export const keyPcs = (k: Key) => (SCALES[k.scale] ?? SCALES.chromatic).map((i) => (i + k.root) % 12);

// perfis de Krumhansl-Kessler
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Tom mais provável para notas (altura MIDI fracionária, peso = duração × volume). */
export function detectKey(notes: { pitch: number; weight: number }[]): Key & { confidence: number } {
  const h = new Array(12).fill(0);
  for (const n of notes) h[((Math.round(n.pitch) % 12) + 12) % 12] += n.weight;
  const corr = (prof: number[], r: number) => {
    const xs = h.map((_, i) => h[(i + r) % 12]);
    const mx = xs.reduce((a, b) => a + b, 0) / 12, mp = prof.reduce((a, b) => a + b, 0) / 12;
    let num = 0, dx = 0, dp = 0;
    for (let i = 0; i < 12; i++) {
      num += (xs[i] - mx) * (prof[i] - mp);
      dx += (xs[i] - mx) ** 2;
      dp += (prof[i] - mp) ** 2;
    }
    return dx > 0 ? num / Math.sqrt(dx * dp) : 0;
  };
  let best = { root: 0, scale: 'major', confidence: -2 };
  for (let r = 0; r < 12; r++) {
    const a = corr(MAJ, r), b = corr(MIN, r);
    if (a > best.confidence) best = { root: r, scale: 'major', confidence: a };
    if (b > best.confidence) best = { root: r, scale: 'minor', confidence: b };
  }
  return best;
}

/** Nota da escala mais próxima (MIDI inteiro). */
export function snapToKey(m: number, k: Key): number {
  const pcs = keyPcs(k);
  let best = Math.round(m), bd = Infinity;
  for (let n = Math.floor(m) - 2; n <= Math.ceil(m) + 2; n++) {
    if (!pcs.includes(((n % 12) + 12) % 12)) continue;
    const d = Math.abs(n - m);
    if (d < bd) (bd = d), (best = n);
  }
  return best;
}

/** Todas as tonalidades para os seletores (raiz × escala). */
export const SCALE_KEYS = Object.keys(SCALE_LABELS);
