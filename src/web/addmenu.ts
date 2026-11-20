// Menu "adicionar instrumento" (encadeado): Music Labs (nativos), Presets e, para cada
// programa cuja biblioteca foi encontrada (FL Studio, Ableton...), os instrumentos
// multi-sample por família (Piano, Bass, Guitar...) e os sons de bateria. Usado no
// "+ Canal" do rack e no "Inserir instrumento" da área selecionada da playlist.

import type { InstrumentType } from '../core/model';
import { INSTRUMENTS, PRESETS } from '../core/registry';
import type { MenuItem } from './ui/widgets';
import { api } from './state';

export interface LibInstrument {
  name: string;
  path: string;
  daw?: string;
  group?: string;
  category?: string;
}
export interface Lib {
  localInstruments: LibInstrument[];
  localSamples: { name: string; path: string }[];
}

let cache: Lib | null = null;
let pending: Promise<Lib> | null = null;
/** Biblioteca local (uma vez por sessão; a varredura acontece no servidor). */
export function loadLib(): Promise<Lib> {
  if (cache) return Promise.resolve(cache);
  pending ??= api('GET', '/api/registry').then((r: Lib) => (cache = { localInstruments: r.localInstruments ?? [], localSamples: r.localSamples ?? [] }));
  return pending;
}
export const libNow = () => cache;

export interface AddHandlers {
  native: (t: InstrumentType) => void;
  preset: (name: string) => void;
  sample: (path: string, name: string) => void;
}

const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'pt', { numeric: true });

export function instrumentMenu(lib: Lib | null, h: AddHandlers): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: 'Music Labs',
      hint: 'Instrumentos nativos',
      sub: (Object.keys(INSTRUMENTS) as InstrumentType[]).map((t) => ({ label: INSTRUMENTS[t].label, hint: INSTRUMENTS[t].description, run: () => h.native(t) })),
    },
  ];
  // presets agrupados pelo instrumento de base
  const byType = new Map<string, MenuItem[]>();
  for (const [k, v] of Object.entries(PRESETS)) {
    const g = INSTRUMENTS[v.type].label;
    if (!byType.has(g)) byType.set(g, []);
    byType.get(g)!.push({ label: k, hint: v.description, run: () => h.preset(k) });
  }
  items.push({ label: 'Presets', sub: [...byType.entries()].map(([label, sub]) => ({ label, sub })).sort(byName) });
  if (!lib) {
    items.push({ sep: true, label: '' }, { label: 'Carregando a biblioteca…' });
    return items;
  }
  // um item por programa (as várias pastas do mesmo programa se juntam)
  const daws = new Map<string, LibInstrument[]>();
  for (const i of lib.localInstruments) {
    const d = i.daw || 'Outros';
    if (!daws.has(d)) daws.set(d, []);
    daws.get(d)!.push(i);
  }
  // os sons de bateria do kit local vêm da instalação do FL Studio
  if (lib.localSamples.length && !daws.has('FL Studio')) daws.set('FL Studio', []);
  if (daws.size) items.push({ sep: true, label: '' });
  for (const [daw, list] of [...daws.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const groups = new Map<string, LibInstrument[]>();
    for (const i of list) {
      const g = i.group || 'Instrumentos';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(i);
    }
    const sub: MenuItem[] = [...groups.entries()]
      .map(([label, insts]) => {
        // nomes repetidos na mesma família (pastas diferentes): mostra de onde vêm
        const count = new Map<string, number>();
        for (const i of insts) count.set(i.name, (count.get(i.name) ?? 0) + 1);
        return {
          label,
          sub: insts
            .map((i) => ({ label: (count.get(i.name) ?? 0) > 1 ? `${i.name} (${i.path.split(/[\\/]/).slice(-3, -2)[0] ?? 'outra pasta'})` : i.name, hint: i.path, run: () => h.sample(i.path, i.name) }))
            .sort(byName),
        };
      })
      .sort(byName);
    if (daw === 'FL Studio' && lib.localSamples.length)
      sub.push({ sep: true, label: '' }, { label: 'Bateria', hint: 'Sons de bateria da instalação (um por canal)', sub: lib.localSamples.map((x) => ({ label: x.name, hint: x.path, run: () => h.sample(x.path, x.name) })) });
    items.push({ label: daw, hint: `Instrumentos encontrados na instalação do ${daw}`, sub });
  }
  return items;
}
