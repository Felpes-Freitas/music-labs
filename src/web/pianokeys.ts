// Teclado do computador como piano: duas fileiras, começando no Z (fileira de baixo, C3) e
// no Q (fileira de cima, C4). As teclas pretas ficam na fileira acima de cada uma (S D G H J
// e 2 3 5 6 7 9 0). Os símbolos à direita continuam o piano: , . ; / embaixo e [ = ] em
// cima. (O L continua sendo o atalho de PAT/SONG; Tab e Shift não tocam nada.)

export const KEYMAP: Record<string, number> = {
  // fileira de baixo: C3 …
  z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59,
  ',': 60, '.': 62, ';': 63, '/': 64,
  // fileira de cima: C4 …
  q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71, i: 72, '9': 73, o: 74, '0': 75, p: 76,
  '[': 77, '=': 78, ']': 79,
};
export const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
