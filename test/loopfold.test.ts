import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTake } from '../src/core/loopfold.ts';

const SR = 48000, TPS = 200; // 200 ticks por segundo
const loop: [number, number] = [1000, 1800]; // 4 s de loop

test('take dentro do loop: um pedaço só', () => {
  assert.deepEqual(foldTake(1200, SR * 2, SR, TPS, loop), [{ tick: 1200, a: 0, b: SR * 2 }]);
});

test('take que passa do fim: o excesso vai para o início da área', () => {
  // começa 1 s antes do fim, dura 3 s
  const p = foldTake(1600, SR * 3, SR, TPS, loop);
  assert.deepEqual(p, [
    { tick: 1600, a: 0, b: SR },
    { tick: 1000, a: SR, b: SR * 3 },
  ]);
});

test('take maior que o loop dá várias voltas', () => {
  const p = foldTake(1000, SR * 9, SR, TPS, loop);
  assert.deepEqual(p.map((x) => [x.tick, x.a / SR, x.b / SR]), [[1000, 0, 4], [1000, 4, 8], [1000, 8, 9]]);
});

test('só o pré-ataque antes da volta: o toco some, o resto vai para o início', () => {
  const p = foldTake(1790, SR * 2, SR, TPS, loop); // 0,05 s antes do fim
  assert.equal(p.length, 1);
  assert.equal(p[0].tick, 1000);
});

test('take que começou depois do fim da área é trazido para dentro', () => {
  const p = foldTake(2000, SR, SR, TPS, loop);
  assert.equal(p[0].tick, 1200);
});

test('sem loop: não mexe', () => {
  assert.deepEqual(foldTake(5000, SR * 10, SR, TPS, null), [{ tick: 5000, a: 0, b: SR * 10 }]);
});

test('sobra de poucos ms depois da volta é ignorada', () => {
  const p = foldTake(1000, SR * 4 + 400, SR, TPS, loop); // 8 ms além de uma volta
  assert.deepEqual(p, [{ tick: 1000, a: 0, b: SR * 4 }]);
});
