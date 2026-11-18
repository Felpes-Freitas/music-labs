// Teoria musical: escalas, acordes por nome e graus, para o piano roll e o MCP.

import { parseNote } from './model.js';

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchClass(name: string): number {
  const m = /^([A-Ga-g])([#b]?)/.exec(name.trim());
  if (!m) throw new Error(`Tônica inválida: ${name}`);
  return (PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

/** Notas MIDI da escala entre lo e hi. */
export function scaleNotes(root: string, scale: string, lo = 0, hi = 127): number[] {
  const iv = SCALES[scale];
  if (!iv) throw new Error(`Escala desconhecida: ${scale}. Opções: ${Object.keys(SCALES).join(', ')}`);
  const r = pitchClass(root);
  const out: number[] = [];
  for (let k = lo; k <= hi; k++) if (iv.includes((k - r + 120) % 12)) out.push(k);
  return out;
}

export function inScale(key: number, root: string, scale: string): boolean {
  return SCALES[scale]?.includes((key - pitchClass(root) + 120) % 12) ?? true;
}

const QUALITIES: [RegExp, number[]][] = [
  [/^(maj13)/, [0, 4, 7, 11, 14, 21]],
  [/^(maj9|M9)/, [0, 4, 7, 11, 14]],
  [/^(maj7|M7|Δ7?)/, [0, 4, 7, 11]],
  [/^(m7b5|ø7?)/, [0, 3, 6, 10]],
  [/^(mMaj7|mM7)/, [0, 3, 7, 11]],
  [/^(m11|min11)/, [0, 3, 7, 10, 14, 17]],
  [/^(m9|min9)/, [0, 3, 7, 10, 14]],
  [/^(m7|min7|-7)/, [0, 3, 7, 10]],
  [/^(m6|min6)/, [0, 3, 7, 9]],
  [/^(madd9)/, [0, 3, 7, 14]],
  [/^(m|min|-)/, [0, 3, 7]],
  [/^(dim7|°7)/, [0, 3, 6, 9]],
  [/^(dim|°)/, [0, 3, 6]],
  [/^(aug|\+)/, [0, 4, 8]],
  [/^(sus2)/, [0, 2, 7]],
  [/^(sus4|sus)/, [0, 5, 7]],
  [/^(add9)/, [0, 4, 7, 14]],
  [/^(13)/, [0, 4, 7, 10, 14, 21]],
  [/^(11)/, [0, 4, 7, 10, 14, 17]],
  [/^(9)/, [0, 4, 7, 10, 14]],
  [/^(7)/, [0, 4, 7, 10]],
  [/^(6)/, [0, 4, 7, 9]],
  [/^(5)/, [0, 7]],
  [/^/, [0, 4, 7]],
];

/** "Am7", "F#maj9", "C/E", "Bbsus2" -> notas MIDI a partir da oitava dada. */
export function chordNotes(symbol: string, octave = 4): number[] {
  const [main, bass] = symbol.trim().split('/');
  const m = /^([A-Ga-g][#b]?)(.*)$/.exec(main);
  if (!m) throw new Error(`Acorde inválido: ${symbol}`);
  const root = parseNote(`${m[1]}${octave}`);
  const rest = m[2];
  let iv = [0, 4, 7];
  for (const [re, ivs] of QUALITIES) if (re.test(rest)) {
    iv = ivs;
    break;
  }
  const notes = iv.map((i) => root + i);
  if (bass) {
    const b = parseNote(`${bass}${octave - 1}`);
    notes.unshift(b > root ? b - 12 : b);
  }
  return notes;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Graus romanos na tonalidade: "vi", "IV", "V7", "ii7", "bVII". Minúscula = menor. */
export function romanChord(numeral: string, root: string, scale = 'major', octave = 4): number[] {
  const m = /^(b|#)?([ivIV]+)(°|dim|\+|aug)?(7|maj7|9|sus2|sus4)?$/.exec(numeral.trim());
  if (!m) throw new Error(`Grau inválido: ${numeral}`);
  const deg = ROMAN.indexOf(m[2].toUpperCase());
  if (deg < 0) throw new Error(`Grau inválido: ${numeral}`);
  const iv = SCALES[scale] ?? SCALES.major;
  const pcRoot = pitchClass(root);
  const semi = iv[deg % iv.length] + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0);
  const base = parseNote(`C${octave}`) + pcRoot + semi;
  const minor = m[2] === m[2].toLowerCase();
  let q = minor ? [0, 3, 7] : [0, 4, 7];
  if (m[3] === '°' || m[3] === 'dim') q = [0, 3, 6];
  if (m[3] === '+' || m[3] === 'aug') q = [0, 4, 8];
  if (m[4] === '7') q = [...q, 10];
  if (m[4] === 'maj7') q = [...q, 11];
  if (m[4] === '9') q = [...q, 10, 14];
  if (m[4] === 'sus2') q = [0, 2, 7];
  if (m[4] === 'sus4') q = [0, 5, 7];
  return q.map((x) => base + x);
}

/** Aproxima cada acorde do anterior (voice leading simples por inversões). */
export function voiceLead(chords: number[][], center = 62): number[][] {
  const out: number[][] = [];
  let prev: number[] | null = null;
  for (const c of chords) {
    let best = c;
    let bestCost = Infinity;
    for (let inv = -c.length; inv <= c.length; inv++) {
      const v = c.map((n, i) => {
        let k = n;
        if (inv > 0 && i < inv) k += 12;
        if (inv < 0 && i >= c.length + inv) k -= 12;
        return k;
      }).sort((a, b) => a - b);
      const avg = v.reduce((a, b) => a + b, 0) / v.length;
      const cost = prev ? v.reduce((s, n, i) => s + Math.abs(n - (prev![Math.min(i, prev!.length - 1)])), 0) : Math.abs(avg - center);
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
    }
    out.push(best);
    prev = best;
  }
  return out;
}
