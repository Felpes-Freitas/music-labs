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

test('costura mede a distância até a nota pretendida (não até o semitom mais próximo)', async () => {
  const { planStitch, renderStitch, rescore, tuneToMelody } = await import('../src/core/stitch.ts');
  // melodia em Dó maior: C D E F. O take B canta a 2ª nota meio tom abaixo (C#),
  // perfeitamente "afinado" num semitom, mas na nota errada.
  const A = sing([[60.3, 0.5], [62.1, 0.5], [64, 0.5], [65.35, 0.6]]);
  const B = sing([[60, 0.5], [61, 0.5], [64.05, 0.5], [65, 0.6]]);
  const C = sing([[60.1, 0.5], [62.3, 0.5], [63.7, 0.5], [65.05, 0.6]]);
  const tk = (x: Float32Array) => ({ offset: 2, from: 0, to: x.length / SR, ch: [x] });
  const takes = [tk(A), tk(B), tk(C)];
  const plan = planStitch(takes, SR, null, false);
  const { keyPcs } = await import('../src/core/key.ts');
  for (const pc of [0, 2, 4, 5]) assert.ok(keyPcs(plan.detectedKey).includes(pc), `tom detectado contém a melodia: ${JSON.stringify(plan.detectedKey)}`);
  const seg = (t: number) => plan.segments.find((s) => t >= s.t0 && t < s.t1)!;
  assert.equal(seg(2.85).target, 62, 'a nota pretendida é Ré');
  assert.notEqual(seg(2.85).take, 1, 'o take que cantou C# (afinado, mas errado) não é escolhido');
  assert.equal(seg(2.35).take, 1, 'na 1ª nota o take B é o mais perto do Dó');
  // a pessoa corrige a melodia: a 3ª nota era para ser Mi bemol (63)
  seg(3.35).target = 63;
  rescore(plan, takes, SR);
  assert.equal(seg(3.35).take, 2, 'com a melodia editada, vale o take que cantou mais baixo');
  // e a costura sai afinada exatamente na melodia
  const [L, R] = renderStitch(plan, takes, SR);
  const [tL] = tuneToMelody(L, R, plan, SR);
  // altura no meio de cada nota (a costura começa em t = 2 s; notas de 0,5 s a partir de 0,1 s)
  const tr = trackPitch(tL, SR);
  const mid = (t0: number, t1: number) => median(Array.from(tr.midi.slice(Math.floor((t0 * SR) / tr.hop), Math.floor((t1 * SR) / tr.hop))).filter((m) => !Number.isNaN(m)));
  const got = [mid(0.2, 0.5), mid(0.7, 1.0), mid(1.2, 1.5), mid(1.7, 2.1)];
  for (const [k, m] of [60, 62, 63, 65].entries()) assert.ok(Math.abs(got[k] - m) < 0.12, `costura afinada: ${got.map((g) => g.toFixed(2)).join(' ')}`);
});
