// Central de Automações: funções que geram os pontos de um clipe de automação.
//
// O clipe guarda a função (gen) e os pontos já calculados (o que a engine toca). Ao
// redimensionar, os pontos são recalculados para o tamanho novo: rampas se esticam
// (vão do início ao fim do clipe) e ondas mantêm o período em tempos (um seno de 1
// tempo continua de 1 tempo, só ganha mais ciclos). Editar um ponto à mão marca a
// função como "custom": daí em diante valem os pontos, como numa automação gravada.

import { PPQ, type AutoPoint, type Clip } from './model.js';

export type GenKind = 'ramp' | 'lfo' | 'pump' | 'steps' | 'random';
export type Wave = 'sine' | 'tri' | 'square' | 'saw' | 'sawdown';

export interface AutoGen {
  kind: GenKind;
  /** Função pronta de onde veio (só para destacar na lista). */
  preset?: string;
  /** Pontos editados à mão: a função não é mais reaplicada. */
  custom?: boolean;
  /** Faixa de saída (0..1 na faixa do parâmetro). Rampa e escada vão de lo a hi. */
  lo: number;
  hi: number;
  /** Rampa/escada: curva -1..1 (positivo começa devagar = exponencial; negativo começa rápido). */
  curve?: number;
  /** Rampa: curva em S (suave nas duas pontas). */
  s?: boolean;
  /** LFO */
  wave?: Wave;
  /** Período em tempos (LFO, bombeamento, aleatório). */
  period?: number;
  /** LFO: período no fim do clipe (acelera ou desacelera ao longo dele). */
  periodEnd?: number;
  /** LFO: "respiração" — a frequência contrai e expande (0..2 oitavas). */
  breathe?: number;
  /** LFO: ciclo da respiração em tempos. */
  breathePeriod?: number;
  /** LFO: intensidade (0..1) no começo e no fim do clipe. */
  depth?: number;
  depthEnd?: number;
  /** LFO: fase inicial (0..1). */
  phase?: number;
  /** Bombeamento: fração do período que leva para voltar (0..1). */
  release?: number;
  /** Escada: número de degraus. */
  count?: number;
  /** Aleatório: deslize entre valores (0..1) e semente. */
  smooth?: number;
  seed?: number;
}

export const GEN_DEFAULTS: Required<Omit<AutoGen, 'custom' | 'kind' | 'preset'>> = {
  lo: 0,
  hi: 1,
  curve: 0,
  s: false,
  wave: 'sine',
  period: 1,
  periodEnd: 1,
  breathe: 0,
  breathePeriod: 8,
  depth: 1,
  depthEnd: 1,
  phase: 0,
  release: 0.8,
  count: 8,
  smooth: 0,
  seed: 1,
};

/** Funções prontas (o ponto de partida; os controles ajustam o resto). */
export const GEN_PRESETS: { id: string; label: string; hint: string; gen: AutoGen }[] = [
  { id: 'riser', label: 'Riser', hint: 'Sobe em linha reta do início ao fim', gen: { kind: 'ramp', lo: 0, hi: 1, curve: 0 } },
  { id: 'riser-exp', label: 'Riser exponencial', hint: 'Começa devagar e dispara no fim', gen: { kind: 'ramp', lo: 0, hi: 1, curve: 0.6 } },
  { id: 'fade-in', label: 'Fade in', hint: 'Entra rápido e acomoda (curva logarítmica)', gen: { kind: 'ramp', lo: 0, hi: 1, curve: -0.5 } },
  { id: 'fade-out', label: 'Fade out', hint: 'Desce até o mínimo', gen: { kind: 'ramp', lo: 1, hi: 0, curve: -0.5 } },
  { id: 's-curve', label: 'Curva S', hint: 'Transição suave nas duas pontas', gen: { kind: 'ramp', lo: 0, hi: 1, s: true } },
  { id: 'sine', label: 'Seno', hint: 'Onda senoidal no tempo da música', gen: { kind: 'lfo', lo: 0.2, hi: 0.8, wave: 'sine', period: 2, periodEnd: 2 } },
  { id: 'breathe', label: 'Seno que respira', hint: 'A frequência contrai e expande', gen: { kind: 'lfo', lo: 0.1, hi: 0.9, wave: 'sine', period: 1, periodEnd: 1, breathe: 1.5, breathePeriod: 8 } },
  { id: 'accel', label: 'Seno acelerando', hint: 'Cada vez mais rápido até o fim (ótimo antes de um drop)', gen: { kind: 'lfo', lo: 0.1, hi: 0.9, wave: 'sine', period: 2, periodEnd: 0.125 } },
  { id: 'wobble', label: 'Wobble', hint: 'Triângulo rápido (dubstep, wah)', gen: { kind: 'lfo', lo: 0.15, hi: 0.85, wave: 'tri', period: 0.5, periodEnd: 0.5 } },
  { id: 'gate', label: 'Trance gate', hint: 'Liga e desliga no ritmo', gen: { kind: 'lfo', lo: 0, hi: 1, wave: 'square', period: 0.5, periodEnd: 0.5 } },
  { id: 'saw', label: 'Dente de serra', hint: 'Sobe e cai de uma vez, em ciclos', gen: { kind: 'lfo', lo: 0, hi: 1, wave: 'saw', period: 1, periodEnd: 1 } },
  { id: 'pump', label: 'Bombeamento', hint: 'Abaixa em cada tempo e volta (efeito sidechain)', gen: { kind: 'pump', lo: 0.1, hi: 1, period: 1, release: 0.8, curve: 0.3 } },
  { id: 'steps', label: 'Escada', hint: 'Sobe em degraus', gen: { kind: 'steps', lo: 0, hi: 1, count: 8 } },
  { id: 'random', label: 'Aleatório', hint: 'Um valor novo a cada período (sample & hold)', gen: { kind: 'random', lo: 0.2, hi: 0.8, period: 0.5, smooth: 0.3, seed: 1 } },
];

const val = <K extends keyof typeof GEN_DEFAULTS>(g: AutoGen, k: K) => (g[k] ?? GEN_DEFAULTS[k]) as (typeof GEN_DEFAULTS)[K];
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Curva de 0..1 → 0..1 (c > 0 começa devagar; c < 0 começa rápido). */
export function shapeCurve(u: number, c: number, s = false) {
  if (s) u = u * u * (3 - 2 * u);
  if (Math.abs(c) < 1e-3) return u;
  const k = Math.pow(2, c * 3);
  return c > 0 ? Math.pow(u, k) : 1 - Math.pow(1 - u, 1 / k);
}

function wave(w: Wave, ph: number) {
  const f = ph - Math.floor(ph);
  switch (w) {
    case 'sine':
      return Math.sin(2 * Math.PI * f);
    case 'tri':
      return f < 0.25 ? 4 * f : f < 0.75 ? 2 - 4 * f : 4 * f - 4;
    case 'square':
      return f < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * f - 1;
    case 'sawdown':
      return 1 - 2 * f;
  }
}

/** Gerador pseudoaleatório determinístico (mesma semente = mesma automação). */
function rng(seed: number) {
  let s = (Math.floor(seed * 9973) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tira pontos que a interpolação linear já reproduz (erro máximo eps). */
export function simplify(pts: AutoPoint[], eps = 0.004): AutoPoint[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, err = eps;
    const A = pts[a], B = pts[b];
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const lin = B.t > A.t ? A.v + ((B.v - A.v) * (P.t - A.t)) / (B.t - A.t) : A.v;
      const e = Math.abs(P.v - lin);
      if (e > err) {
        err = e;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Calcula os pontos da função para um clipe de len ticks. */
export function renderGen(g: AutoGen, len: number): AutoPoint[] {
  len = Math.max(1, Math.round(len));
  const lo = val(g, 'lo'), hi = val(g, 'hi');
  const map = (x: number) => clamp01(lo + (hi - lo) * x);
  const out: AutoPoint[] = [];
  const MAX = 20000;
  if (g.kind === 'ramp') {
    const c = val(g, 'curve'), s = val(g, 's');
    const n = Math.abs(c) < 1e-3 && !s ? 1 : 256;
    for (let i = 0; i <= n; i++) out.push({ t: Math.round((i / n) * len), v: map(shapeCurve(i / n, c, s)) });
    return simplify(out);
  }
  if (g.kind === 'steps') {
    const n = Math.max(1, Math.round(val(g, 'count')));
    const c = val(g, 'curve');
    const seg = len / n;
    for (let k = 0; k < n; k++) {
      const v = map(shapeCurve(n > 1 ? k / (n - 1) : 1, c));
      const a = Math.round(k * seg), b = Math.round((k + 1) * seg);
      out.push({ t: a, v }, { t: Math.max(a, b - 1), v });
    }
    return out;
  }
  if (g.kind === 'random') {
    const per = Math.max(1, val(g, 'period') * PPQ);
    const sm = clamp01(val(g, 'smooth'));
    const r = rng(val(g, 'seed'));
    let prev = r();
    for (let a = 0; a < len; a += per) {
      const v = r();
      const glide = Math.min(per, per * sm);
      const t0 = Math.round(a), t1 = Math.round(Math.min(len, a + glide));
      if (a > 0 && sm > 0) out.push({ t: t0, v: map(prev) }, { t: t1, v: map(v) });
      else out.push({ t: t0, v: map(v) });
      const tEnd = Math.round(Math.min(len, a + per)) - 1;
      if (tEnd > t1) out.push({ t: tEnd, v: map(v) });
      prev = v;
      if (out.length > MAX) break;
    }
    if (out[out.length - 1].t < len) out.push({ t: len, v: out[out.length - 1].v });
    return out;
  }
  if (g.kind === 'pump') {
    const per = Math.max(6, val(g, 'period') * PPQ);
    const rel = Math.max(0.05, Math.min(1, val(g, 'release')));
    const c = val(g, 'curve');
    const dt = Math.max(1, per / 48);
    for (let t = 0; t <= len && out.length < MAX; t += dt) {
      const f = (t % per) / per;
      // cai na hora no começo do período e volta ao máximo ao longo de "release"
      const x = f >= rel ? 1 : shapeCurve(f / rel, c);
      out.push({ t: Math.round(t), v: map(x) });
    }
    return simplify(out);
  }
  // LFO: a fase anda conforme o período (que pode mudar ao longo do clipe e "respirar")
  const p0 = Math.max(1 / 16, val(g, 'period')) * PPQ, p1 = Math.max(1 / 16, val(g, 'periodEnd')) * PPQ;
  const br = Math.max(0, val(g, 'breathe')), brP = Math.max(0.25, val(g, 'breathePeriod')) * PPQ;
  const d0 = clamp01(val(g, 'depth')), d1 = clamp01(val(g, 'depthEnd'));
  const w = val(g, 'wave');
  const minPer = Math.min(p0, p1) * Math.pow(2, -br);
  const dt = Math.max(len / MAX, Math.min(minPer / 32, 4), 0.25);
  let ph = val(g, 'phase');
  for (let t = 0; ; t += dt) {
    const tt = Math.min(t, len);
    const u = tt / len;
    const d = d0 + (d1 - d0) * u;
    out.push({ t: Math.round(tt * 4) / 4, v: clamp01(0.5 + 0.5 * wave(w, ph) * d) });
    if (tt >= len) break;
    // período geométrico entre início e fim, contraído/expandido pela respiração
    const per = p0 * Math.pow(p1 / p0, u) * Math.pow(2, -br * Math.sin((2 * Math.PI * tt) / brP));
    ph += dt / per;
  }
  // ticks inteiros (a engine e o projeto usam ticks inteiros nos pontos)
  const merged: AutoPoint[] = [];
  for (const p of out) {
    const t = Math.round(p.t);
    if (merged.length && merged[merged.length - 1].t === t && !(w === 'square' || w === 'saw' || w === 'sawdown')) merged[merged.length - 1].v = p.v;
    else merged.push({ t, v: p.v });
  }
  return simplify(merged.map((p) => ({ t: p.t, v: map(p.v) })));
}

/** Recalcula os pontos de um clipe gerado por função (para o tamanho atual). */
export function regen(c: Clip): Clip {
  if (c.kind !== 'auto' || !c.gen || c.gen.custom) return c;
  return { ...c, points: renderGen(c.gen, c.len) };
}

/**
 * Anda o começo de um clipe de automação d ticks (positivo corta, negativo estende).
 * Função: recalcula para o tamanho novo. Pontos (gravada/editada): o que estava em
 * cada instante continua no mesmo instante da música.
 */
export function trimAutoStart(c: Clip, d: number): Clip {
  const len = c.len - d;
  if (c.gen && !c.gen.custom) return { ...c, pos: c.pos + d, len, points: renderGen(c.gen, len) };
  const pts = c.points ?? [];
  if (!pts.length) return { ...c, pos: c.pos + d, len };
  const at = (t: number) => {
    if (t <= pts[0].t) return pts[0].v;
    for (let i = 1; i < pts.length; i++) if (t < pts[i].t) return pts[i - 1].v + ((pts[i].v - pts[i - 1].v) * (t - pts[i - 1].t)) / (pts[i].t - pts[i - 1].t);
    return pts[pts.length - 1].v;
  };
  const moved = pts.map((p) => ({ t: p.t - d, v: p.v })).filter((p) => p.t > 0);
  return { ...c, pos: c.pos + d, len, points: [{ t: 0, v: at(Math.max(0, d)) }, ...moved] };
}
