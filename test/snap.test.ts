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
