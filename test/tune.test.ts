import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackPitch, segmentNotes } from '../src/core/pitchtrack.ts';
import { shiftPitch } from '../src/core/psola.ts';

const SR = 48000;
/** "Voz" sintética: fundamental + harmônicos, com notas em sequência (MIDI, duração s). */
function sing(notes: [number, number][], vibrato = 0) {
  const total = notes.reduce((s, n) => s + n[1], 0) + 0.2;
  const x = new Float32Array(Math.round(SR * total));
  let t0 = 0.1, ph = 0;
  for (const [m, dur] of notes) {
    const a = Math.round(t0 * SR), b = Math.round((t0 + dur) * SR);
    for (let i = a; i < b; i++) {
      const t = (i - a) / SR;
      const f = 440 * Math.pow(2, (m - 69 + vibrato * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
      ph += (2 * Math.PI * f) / SR;
      const env = Math.min(1, t * 40, (dur - t) * 40);
      x[i] = 0.3 * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.15 * Math.sin(4 * ph));
    }
    t0 += dur;
  }
  return x;
}
const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];

test('rastreia a altura de notas de voz com precisão de poucos cents', () => {
  const x = sing([[57.3, 0.6], [62, 0.6], [64.85, 0.6]]);
  const tr = trackPitch(x, SR);
  const notes = segmentNotes(tr);
  assert.equal(notes.length, 3, JSON.stringify(notes.map((n) => n.pitch)));
  [57.3, 62, 64.85].forEach((m, k) => assert.ok(Math.abs(notes[k].pitch - m) < 0.05, `nota ${k}: ${notes[k].pitch.toFixed(3)} (esperado ${m})`));
});

test('guitarra grave (E2) também é rastreada', () => {
  const tr = trackPitch(sing([[40, 0.8]]), SR);
  const v = Array.from(tr.midi).filter((m) => !Number.isNaN(m));
  assert.ok(Math.abs(median(v) - 40) < 0.05, `E2: ${median(v)}`);
});

test('PSOLA muda a altura sem mudar a duração', () => {
  const x = sing([[60, 1.0]]);
  const tr = trackPitch(x, SR);
  const shift = new Float32Array(tr.midi.length).fill(2); // +2 semitons
  const [y] = shiftPitch([x], tr, shift);
  assert.equal(y.length, x.length);
  const t2 = trackPitch(y, SR);
  const v = Array.from(t2.midi).filter((m) => !Number.isNaN(m));
  assert.ok(Math.abs(median(v) - 62) < 0.08, `deslocado: ${median(v).toFixed(3)}`);
  // nível parecido com o original
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, q) => s + q * q, 0) / a.length);
  assert.ok(Math.abs(20 * Math.log10(rms(y) / rms(x))) < 2, 'volume preservado');
});

test('costura escolhe, nota a nota, o take mais afinado', async () => {
  const { planStitch, renderStitch } = await import('../src/core/stitch.ts');
  // a mesma frase de 3 notas; cada take erra uma nota diferente
  const A = sing([[60, 0.5], [62.45, 0.5], [64, 0.5]]); // 2ª nota 45 cents alta
  const B = sing([[59.6, 0.5], [62, 0.5], [64.4, 0.5]]); // 1ª e 3ª desafinadas
  const C = sing([[60.05, 0.5], [61.6, 0.5], [64.02, 0.5]]); // 2ª nota baixa
  const tk = (x: Float32Array) => ({ offset: 2, from: 0, to: x.length / SR, ch: [x] });
  const takes = [tk(A), tk(B), tk(C)];
  const plan = planStitch(takes, SR);
  const picks = plan.segments.filter((s) => s.take >= 0).map((s) => s.take);
  // nota 1: A ou C (afinados); nota 2: B; nota 3: A ou C
  const at = (t: number) => plan.segments.find((s) => t >= s.t0 && t < s.t1)!.take;
  assert.ok([0, 2].includes(at(2.35)), `nota 1 → take ${at(2.35)} (${JSON.stringify(picks)})`);
  assert.equal(at(2.85), 1, 'nota 2 → take B');
  assert.ok([0, 2].includes(at(3.35)), `nota 3 → take ${at(3.35)}`);
  const [L] = renderStitch(plan, takes, SR);
  const notes = segmentNotes(trackPitch(L, SR));
  assert.equal(notes.length, 3);
  for (const [k, m] of [60, 62, 64].entries()) assert.ok(Math.abs(notes[k].pitch - m) < 0.1, `costurado nota ${k}: ${notes[k].pitch.toFixed(2)}`);
});
