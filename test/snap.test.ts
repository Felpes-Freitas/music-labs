import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSnap } from '../src/core/snap.ts';
import { PPQ } from '../src/core/model.ts';

test('snap automático afina com o zoom', () => {
  const bar = PPQ * 4;
  assert.equal(autoSnap(0.01, bar), bar); // longe: compasso
  assert.equal(autoSnap(0.12, bar), PPQ); // padrão (11,5 px por tempo)
  assert.equal(autoSnap(0.5, bar), PPQ / 4); // perto: 1/4 de tempo (step)
  assert.equal(autoSnap(4, bar), PPQ / 16); // muito perto: o mais fino
});

import { autoSnapRoll } from '../src/core/snap.ts';
test('snap automático do piano roll: intervalo diminui com o zoom e fica livre no máximo', () => {
  const bar = 384;
  const steps = [0.04, 0.2, 0.6, 1.5, 2.5, 4].map((zx) => autoSnapRoll(zx, bar));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1], `não aumenta: ${steps}`);
  assert.equal(autoSnapRoll(0.04, bar), bar, 'pouco zoom: compasso');
  assert.equal(autoSnapRoll(6, bar), 1, 'zoom máximo: livre');
});
