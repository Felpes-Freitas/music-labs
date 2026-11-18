// Preferências da interface guardadas no navegador (gráficos recolhidos, piano visível...).

import { useState } from 'preact/hooks';

const KEY = 'musiclabs.ui';

function load(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

const prefs = load();

export function getPref<T>(k: string, def: T): T {
  return (prefs[k] as T) ?? def;
}

export function setPref(k: string, v: unknown) {
  prefs[k] = v;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* armazenamento indisponível */
  }
}

/** useState que lembra o valor entre sessões. */
export function usePref<T>(k: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(getPref(k, def));
  return [
    v,
    (nv: T) => {
      setPref(k, nv);
      setV(nv);
    },
  ];
}
