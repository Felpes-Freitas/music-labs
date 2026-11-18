// Detecção de afinação (YIN) para descobrir a nota raiz de samples melódicos.

export interface PitchResult {
  freq: number;
  midi: number; // fracionário: 60.13 = C4 + 13 cents
  clarity: number; // 0..1 (1 = periódico)
}

/** Analisa o trecho mais estável do sample (logo após o ataque). */
export function detectPitch(x: Float32Array, sr: number, minF = 25, maxF = 5200): PitchResult | null {
  const W = 4096;
  const tauMin = Math.max(2, Math.floor(sr / maxF));
  const tauMax = Math.min(Math.floor(sr / minF), W - 1);
  if (x.length < W + tauMax + 16) return null;
  // Começa um pouco depois do pico do ataque (onde o som já estabilizou).
  const searchEnd = Math.min(x.length - W - tauMax - 1, Math.floor(sr * 1.5));
  let peakI = 0;
  let peak = 0;
  for (let i = 0; i < searchEnd; i += 64) {
    const a = Math.abs(x[i]);
    if (a > peak) {
      peak = a;
      peakI = i;
    }
  }
  if (peak < 1e-4) return null;
  const start = Math.min(searchEnd, peakI + Math.floor(sr * 0.06));
  const d = new Float64Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) {
      const v = x[start + j] - x[start + j + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  // diferença média cumulativa normalizada
  const cm = new Float64Array(tauMax + 1);
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    if (tau < tauMin) {
      cm[tau] = 1;
      continue;
    }
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * (tau - tauMin + 1)) / run : 1;
  }
  let best = -1;
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (cm[tau] < 0.15 && cm[tau] <= cm[tau - 1] && cm[tau] <= cm[tau + 1]) {
      // desce até o fundo do vale
      while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let m = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++)
      if (cm[tau] < m) {
        m = cm[tau];
        best = tau;
      }
  }
  // interpolação parabólica na função de diferença crua (sem o viés da normalização)
  let t = best;
  if (best > tauMin && best < tauMax) {
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-12) t = best + (0.5 * (a - c)) / den;
  }
  const freq = sr / t;
  return { freq, midi: 69 + 12 * Math.log2(freq / 440), clarity: Math.max(0, 1 - cm[best]) };
}

const NOTE_RE = /(?:^|[^A-Za-z0-9#])([A-G])(#|b|s|sharp)?(-?\d)(?![0-9])/;

/** Nota escrita no nome do arquivo ("OSTR C4", "Piano_F#2", "Bass Eb1"). C4 = 60. */
export function noteFromName(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, '');
  const m = NOTE_RE.exec(base);
  if (!m) return null;
  const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'];
  const acc = m[2] === 'b' ? -1 : m[2] ? 1 : 0;
  const oct = Number(m[3]);
  if (oct < -1 || oct > 9) return null;
  return (oct + 1) * 12 + pc + acc;
}

/**
 * Corrige erros de oitava numa sequência numerada (arquivo 1, 2, 3...): ajusta uma
 * reta robusta (Theil-Sen) número -> nota e puxa cada nota discrepante para a
 * oitava mais próxima da reta. Devolve as notas corrigidas.
 */
export function fixNumberedSequence(nums: number[], roots: number[]): number[] {
  const n = roots.length;
  if (n < 4) return roots;
  const slopes: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (nums[j] !== nums[i]) slopes.push((roots[j] - roots[i]) / (nums[j] - nums[i]));
  if (!slopes.length) return roots;
  slopes.sort((a, b) => a - b);
  const b = slopes[Math.floor(slopes.length / 2)];
  const inter = roots.map((r, i) => r - b * nums[i]).sort((x, y) => x - y);
  const a = inter[Math.floor(n / 2)];
  return roots.map((r, i) => {
    const pred = a + b * nums[i];
    if (Math.abs(r - pred) <= 2.5) return r;
    const k = Math.round((pred - r) / 12);
    const moved = r + 12 * k;
    return Math.abs(moved - pred) <= 2.5 ? moved : pred;
  });
}
