import { PPQ } from './model.js';

/** Snap automático: o passo mais fino (compasso … 1/16 de tempo) com células de pelo menos ~10 px. */
export function autoSnap(zx: number, bar: number) {
  const steps = [bar, PPQ, PPQ / 2, PPQ / 4, PPQ / 8, PPQ / 16];
  let best = steps[0];
  for (const st of steps) if (st * zx >= 10) best = st;
  return best;
}

/**
 * Snap automático do piano roll: o passo mais fino (compasso … 1/16 de tempo) cujas células
 * tenham pelo menos ~12 px; com bastante zoom (células de 1/16 de tempo com 20 px ou mais)
 * o snap fica livre (devolve 1 = um tick). Com pouco zoom, o intervalo é grande.
 */
export function autoSnapRoll(zx: number, bar: number) {
  const steps = [bar, bar / 2, PPQ, PPQ / 2, PPQ / 4, PPQ / 8, PPQ / 16];
  if ((PPQ / 16) * zx >= 20) return 1;
  let best = steps[0];
  for (const st of steps) if (st * zx >= 12) best = st;
  return best;
}
