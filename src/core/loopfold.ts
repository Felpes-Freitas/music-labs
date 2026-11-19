// Take gravado em loop que passa do fim da área: o excesso continua no início dela.

/**
 * Pedaços de um take gravado em loop: o que passa do fim da área é cortado ali e
 * continua no início dela (de novo e de novo, se for maior que o loop); um take que
 * começou fora da área é trazido para dentro. Sem loop, um pedaço só.
 * a/b são amostras do áudio do take; tick é onde o pedaço entra na música.
 */
export function foldTake(tick: number, frames: number, sr: number, tps: number, loop: [number, number] | null): { tick: number; a: number; b: number }[] {
  if (!loop || loop[1] <= loop[0]) return [{ tick, a: 0, b: frames }];
  const [l0, l1] = loop;
  const span = l1 - l0;
  let t = tick < l0 || tick >= l1 ? l0 + ((((tick - l0) % span) + span) % span) : tick;
  const out: { tick: number; a: number; b: number }[] = [];
  for (let a = 0; a < frames; ) {
    const room = Math.max(1, Math.floor(((l1 - t) / tps) * sr));
    const b = Math.min(frames, a + room);
    out.push({ tick: Math.round(t), a, b });
    a = b;
    t = l0;
  }
  // um "toco" no fim da área (só o pré-ataque antes da volta) não vira clipe
  if (out.length > 1 && out[0].b - out[0].a < sr * 0.15) out.shift();
  // sobra de alguns ms depois da volta (variação de tempo, não é som tocado): fica fora
  if (out.length > 1 && out[out.length - 1].b - out[out.length - 1].a < sr * 0.06) out.pop();
  return out;
}
