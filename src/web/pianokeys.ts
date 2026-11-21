// Teclado do computador como piano: duas fileiras, começando no Z (fileira de baixo, C3) e
// no Q (fileira de cima, C4). As teclas pretas ficam na fileira acima de cada uma (S D G H J
// e 2 3 5 6 7 9 0). Os símbolos à direita continuam o piano: , . ; / embaixo e [ = ] em
// cima. (O L continua sendo o atalho de PAT/SONG; Tab e Shift não tocam nada.)
//
// As teclas são identificadas pela POSIÇÃO FÍSICA (KeyboardEvent.code), não pelo caractere:
// assim um teclado americano com o layout PT-BR no sistema (ou qualquer outra combinação)
// toca as mesmas notas nos mesmos lugares. O nome de cada tecla aqui é o caractere dela no
// teclado americano ("q", ",", "[" ...), que também é o nome usado pelo teclado RGB.
// Configurações → Atalhos → Teclado musical escolhe o teclado físico.

import { getPref, setPref } from './prefs';

export type KeyLayout = 'us' | 'abnt2' | 'chars';
export const KEY_LAYOUTS: { id: KeyLayout; label: string; hint: string }[] = [
  { id: 'us', label: 'Americano (US / ANSI)', hint: 'Teclado físico americano, com qualquer layout no sistema (ex.: PT-BR)' },
  { id: 'abnt2', label: 'Brasileiro (ABNT2, com Ç)', hint: 'Teclado físico ABNT2: ganha a tecla \\ ao lado do Z e a / ao lado do ;' },
  { id: 'chars', label: 'Pelos caracteres digitados', hint: 'Usa a letra que o sistema digita (o comportamento antigo); a posição muda com o layout' },
];
export const keyLayout = (): KeyLayout => getPref<KeyLayout>('keys.layout', 'us');
export const setKeyLayout = (l: KeyLayout) => setPref('keys.layout', l);

export const KEYMAP: Record<string, number> = {
  // fileira de baixo: C3 …
  z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59,
  ',': 60, '.': 62, ';': 63, '/': 64,
  // fileira de cima: C4 …
  q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71, i: 72, '9': 73, o: 74, '0': 75, p: 76,
  '[': 77, '=': 78, ']': 79,
};
/** Teclas a mais do ABNT2: \ antes do Z (B2) e / depois do ; (F4). */
const ABNT2_EXTRA: Record<string, number> = { intlbackslash: 47, intlro: 65 };
export const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

/** Código físico da tecla → nome dela no teclado americano. */
const CODE: Record<string, string> = {
  Comma: ',', Period: '.', Semicolon: ';', Slash: '/', BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Quote: "'", Backquote: '`', Backslash: '\\',
  IntlBackslash: 'intlbackslash', IntlRo: 'intlro',
};
for (let i = 0; i < 26; i++) CODE[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i);
for (let i = 0; i < 10; i++) CODE[`Digit${i}`] = String(i);

/** Nome da tecla para o teclado musical e o Soundpad, conforme o teclado escolhido. */
export function musicKey(e: KeyboardEvent): string {
  if (keyLayout() === 'chars') return e.key.toLowerCase();
  return CODE[e.code] ?? e.key.toLowerCase();
}

/** Nota da tecla (sem a oitava do teclado), ou undefined. */
export function noteOfKey(name: string): number | undefined {
  if (name in KEYMAP) return KEYMAP[name];
  if (keyLayout() === 'abnt2') return ABNT2_EXTRA[name];
  return undefined;
}
