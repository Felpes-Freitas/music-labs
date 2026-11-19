import { PPQ } from './model.js';

/** Snap automático: o passo mais fino (compasso … 1/16 de tempo) com células de pelo menos ~10 px. */
export function autoSnap(zx: number, bar: number) {
  const steps = [bar, PPQ, PPQ / 2, PPQ / 4, PPQ / 8, PPQ / 16];
  let best = steps[0];
  for (const st of steps) if (st * zx >= 10) best = st;
  return best;
}
