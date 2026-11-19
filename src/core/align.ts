// Alinhamento de takes: acha o deslocamento entre duas gravações da mesma parte
// comparando o contorno de volume (correlação cruzada do envelope).

/** Envelope RMS em blocos de `step` segundos. */
function envelope(x: Float32Array, sr: number, step: number) {
  const n = Math.max(1, Math.round(step * sr));
  const out = new Float32Array(Math.floor(x.length / n));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = i * n; j < (i + 1) * n; j++) s += x[j] * x[j];
    out[i] = Math.sqrt(s / n);
  }
  // compressão leve: frases baixas também contam
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(out[i]);
  return out;
}

/**
 * Quanto `x` está atrasado em relação a `ref` (s). Positivo: o conteúdo de x
 * acontece mais tarde no arquivo, então x deve começar antes para alinhar.
 */
export function alignOffset(ref: Float32Array, x: Float32Array, sr: number, maxLagSec = 3): number {
  const step = 0.01;
  const a = envelope(ref, sr, step), b = envelope(x, sr, step);
  const maxLag = Math.round(maxLagSec / step);
  const mean = (v: Float32Array) => v.reduce((s, q) => s + q, 0) / Math.max(1, v.length);
  const ma = mean(a), mb = mean(b);
  // normaliza pela energia total (e não só pelo trecho sobreposto): deslocamentos que
  // deixam pouca sobreposição não ganham correlação alta por acaso
  let na = 0, nb = 0;
  for (const v of a) na += (v - ma) ** 2;
  for (const v of b) nb += (v - mb) ** 2;
  const norm = Math.sqrt(na * nb) || 1;
  let best = 0, bestC = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      c += (a[i] - ma) * (b[j] - mb);
    }
    if (c / norm > bestC) (bestC = c / norm), (best = lag);
  }
  return best * step;
}
