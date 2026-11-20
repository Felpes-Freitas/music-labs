import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGen, regen, trimAutoStart, GEN_PRESETS, type AutoGen } from '../src/core/autogen.ts';
import { PPQ, autoValue, emptyProject, type Clip } from '../src/core/model.ts';
import { Engine, BLOCK } from '../src/core/engine.ts';
import { applyOps } from '../src/core/ops.ts';

const BAR = PPQ * 4;
const at = (pts: { t: number; v: number }[], t: number) => autoValue({ id: 'x', track: 0, pos: 0, len: 1e9, patternId: '', offset: 0, kind: 'auto', target: { path: ['x'], min: 0, max: 1, label: '' }, points: pts } as Clip, t)!;

test('riser linear: 2 pontos só, de lo a hi', () => {
  const pts = renderGen({ kind: 'ramp', lo: 0.1, hi: 0.9 }, 4 * BAR);
  assert.equal(pts.length, 2);
  assert.deepEqual([pts[0].v, pts[1].v], [0.1, 0.9]);
  assert.equal(pts[1].t, 4 * BAR);
});

test('riser exponencial começa devagar', () => {
  const pts = renderGen({ kind: 'ramp', lo: 0, hi: 1, curve: 0.6 }, BAR);
  assert.ok(at(pts, BAR / 2) < 0.3, `meio: ${at(pts, BAR / 2)}`);
  assert.ok(pts.length < 80, `poucos pontos: ${pts.length}`);
});

test('seno mantém o período (em tempos) qualquer que seja o tamanho do clipe', () => {
  const g: AutoGen = { kind: 'lfo', lo: 0, hi: 1, wave: 'sine', period: 1, periodEnd: 1 };
  for (const len of [BAR, 8 * BAR]) {
    const pts = renderGen(g, len);
    // pico em 1/4 de tempo, vale em 3/4, em todos os tempos
    for (let b = 0; b < len / PPQ; b++) {
      assert.ok(at(pts, b * PPQ + PPQ / 4) > 0.97, `pico no tempo ${b}`);
      assert.ok(at(pts, b * PPQ + (3 * PPQ) / 4) < 0.03, `vale no tempo ${b}`);
    }
  }
  // mais longo = mais pontos (mesma densidade)
  assert.ok(renderGen(g, 8 * BAR).length > 6 * renderGen(g, BAR).length);
});

test('seno acelerando: ciclos ficam mais curtos no fim', () => {
  const pts = renderGen({ kind: 'lfo', lo: 0, hi: 1, wave: 'sine', period: 2, periodEnd: 0.25 }, 8 * BAR);
  const cross = (a: number, b: number) => {
    let n = 0;
    for (let t = a; t < b; t += 2) if ((at(pts, t) - 0.5) * (at(pts, t + 2) - 0.5) < 0) n++;
    return n;
  };
  assert.ok(cross(7 * BAR, 8 * BAR) > 3 * cross(0, BAR), `começo ${cross(0, BAR)}, fim ${cross(7 * BAR, 8 * BAR)}`);
});

test('todas as funções prontas geram pontos válidos e ordenados', () => {
  for (const pr of GEN_PRESETS) {
    const pts = renderGen(pr.gen, 4 * BAR);
    assert.ok(pts.length >= 2, pr.id);
    for (let i = 0; i < pts.length; i++) {
      assert.ok(pts[i].v >= 0 && pts[i].v <= 1, `${pr.id}: valor`);
      if (i) assert.ok(pts[i].t >= pts[i - 1].t, `${pr.id}: ordem`);
    }
    assert.ok(pts[0].t === 0 && pts[pts.length - 1].t <= 4 * BAR + 1, `${pr.id}: limites`);
  }
});

test('redimensionar: função recalcula; editada à mão não', () => {
  const c: Clip = { id: 'a', kind: 'auto', track: 0, pos: 0, len: BAR, patternId: '', offset: 0, target: { path: ['x'], min: 0, max: 1, label: '' }, gen: { kind: 'ramp', lo: 0, hi: 1 }, points: renderGen({ kind: 'ramp', lo: 0, hi: 1 }, BAR) };
  const big = regen({ ...c, len: 4 * BAR });
  assert.equal(big.points![1].t, 4 * BAR);
  const custom = regen({ ...c, len: 4 * BAR, gen: { ...c.gen!, custom: true } });
  assert.equal(custom.points![1].t, BAR);
});

test('cortar o começo de uma automação de pontos mantém os valores no lugar', () => {
  const c: Clip = { id: 'a', kind: 'auto', track: 0, pos: 0, len: BAR, patternId: '', offset: 0, target: { path: ['x'], min: 0, max: 1, label: '' }, points: [{ t: 0, v: 0 }, { t: BAR, v: 1 }] };
  const cut = trimAutoStart(c, BAR / 4);
  assert.equal(cut.pos, BAR / 4);
  assert.equal(cut.len, (3 * BAR) / 4);
  assert.ok(Math.abs(at(cut.points!, 0) - 0.25) < 1e-9);
  assert.ok(Math.abs(at(cut.points!, (3 * BAR) / 4) - 1) < 1e-9);
  const ext = trimAutoStart(c, -BAR / 2); // estender para a esquerda segura o primeiro valor
  assert.equal(ext.pos, -BAR / 2);
  assert.equal(at(ext.points!, BAR / 2), 0);
});

test('automação de BPM acelera a música', () => {
  const p = emptyProject();
  p.bpm = 120;
  applyOps(p, [{ op: 'insert', path: ['clips'], value: { id: 'b', kind: 'auto', track: 0, pos: 0, len: 100 * BAR, patternId: '', offset: 0, target: { path: ['bpm'], min: 60, max: 240, label: 'BPM' }, points: [{ t: 0, v: 0.5 }, { t: 100 * BAR, v: 0.5 }] } }]);
  const eng = new Engine(48000);
  eng.setProject(p);
  eng.setTransport({ loopOn: true });
  eng.play('song', null, 0);
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  for (let f = 0; f < 48000; f += BLOCK) eng.process(L, R, BLOCK);
  // v = 0,5 na faixa 60..240 = 150 BPM: em 1 s andou 2,5 tempos (a 120 seriam 2)
  assert.ok(Math.abs(eng.tick / PPQ - 2.5) < 0.05, `tempos em 1 s: ${eng.tick / PPQ}`);
  assert.equal(eng.status().bpm, 150);
});
