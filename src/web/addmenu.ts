// Menu "adicionar instrumento" (encadeado): Music Labs (nativos), Presets e, para cada
// programa cuja biblioteca foi encontrada (FL Studio, Ableton...): Instrumentos
// (multi-sample, por família), Samples (todos os sons soltos, na árvore de pastas do
// programa — baterias, efeitos, vocais...) e Kit rápido. Cada som tem prévia (▶ ou botão
// direito). Usado no "+ Canal" do rack, no "Substituir instrumento" e no "Inserir
// instrumento" da área selecionada da playlist.

import type { InstrumentType } from '../core/model';
import { INSTRUMENTS, PRESETS } from '../core/registry';
import type { MenuItem } from './ui/widgets';
import { api } from './state';
import { audio } from './audio';

export interface SampleNode {
  name: string;
  dirs: SampleNode[];
  files: { n: string; p: string }[];
}

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
  /** Samples soltos de cada programa, em árvore de pastas. */
  trees: { daw: string; tree: SampleNode }[];
}

let cache: Lib | null = null;
let pending: Promise<Lib> | null = null;
/** Biblioteca local (uma vez por sessão; a varredura acontece no servidor). */
export function loadLib(): Promise<Lib> {
  if (cache) return Promise.resolve(cache);
  pending ??= Promise.all([api('GET', '/api/registry'), api('GET', '/api/sampletree').catch(() => [])]).then(
    ([r, trees]: [Lib, Lib['trees']]) => (cache = { localInstruments: r.localInstruments ?? [], localSamples: r.localSamples ?? [], trees: trees ?? [] }),
  );
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
  for (const t of lib.trees) if (!daws.has(t.daw)) daws.set(t.daw, []);
  // os sons de bateria do kit local vêm da instalação do FL Studio
  if (lib.localSamples.length && !daws.has('FL Studio')) daws.set('FL Studio', []);
  if (daws.size) items.push({ sep: true, label: '' });
  for (const [daw, list] of [...daws.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sub: MenuItem[] = [];
    const families = instrumentFamilies(list, h);
    if (families.length) sub.push({ label: 'Instrumentos', hint: 'Instrumentos multi-sample (uma amostra por região do teclado)', sub: families });
    const tree = lib.trees.find((t) => t.daw === daw)?.tree;
    if (tree && (tree.dirs.length || tree.files.length)) sub.push({ label: 'Samples', hint: `Todos os sons soltos do ${daw}, nas pastas dele (baterias, efeitos, vocais...)`, sub: treeItems(tree, h) });
    if (daw === 'FL Studio' && lib.localSamples.length)
      sub.push({ label: 'Kit rápido', hint: 'Os sons de bateria mais usados (um por canal)', sub: lib.localSamples.map((x) => fileItem(x.name, x.path, h)) });
    items.push({ label: daw, hint: `Sons encontrados na instalação do ${daw}`, sub });
  }
  return items;
}

/** Um som (arquivo): escolher cria/troca o canal; ▶ ou botão direito ouve. */
function fileItem(label: string, path: string, h: AddHandlers): MenuItem {
  return { label, hint: path, run: () => h.sample(path, label), preview: () => void audio.previewFile(path) };
}

/** Instrumento multi-sample: a prévia toca a amostra mais perto do Dó central. */
async function previewInstrument(path: string) {
  const info = await api('GET', `/api/source?path=${encodeURIComponent(path)}`);
  const zones: { i: number; root: number }[] = info.zones ?? [];
  if (!zones.length) return audio.previewFile(path);
  const z = zones.reduce((b, x) => (Math.abs(x.root - 60) < Math.abs(b.root - 60) ? x : b), zones[0]);
  return audio.previewUrl(`/api/zone?path=${encodeURIComponent(info.path ?? path)}&i=${z.i}`);
}

/** Famílias de instrumentos (Keyboard, Bass...) de um programa. */
function instrumentFamilies(list: LibInstrument[], h: AddHandlers): MenuItem[] {
  const groups = new Map<string, LibInstrument[]>();
  for (const i of list) {
    const g = i.group || 'Instrumentos';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(i);
  }
  return [...groups.entries()]
    .map(([label, insts]) => {
      // nomes repetidos na mesma família (pastas diferentes): mostra de onde vêm
      const count = new Map<string, number>();
      for (const i of insts) count.set(i.name, (count.get(i.name) ?? 0) + 1);
      return {
        label,
        sub: insts
          .map((i) => ({
            label: (count.get(i.name) ?? 0) > 1 ? `${i.name} (${i.path.split(/[\\/]/).slice(-3, -2)[0] ?? 'outra pasta'})` : i.name,
            hint: i.path,
            run: () => h.sample(i.path, i.name),
            preview: () => void previewInstrument(i.path),
          }))
          .sort(byName),
      };
    })
    .sort(byName);
}

/**
 * Pastas → submenus, arquivos → sons. Pasta que só tem uma pasta dentro vira um item
 * só ("FL Studio Mobile › Drum Samples"), para não ter cliques à toa.
 */
function treeItems(node: SampleNode, h: AddHandlers): MenuItem[] {
  const dirs = node.dirs.map((d0) => {
    let d = d0, label = d0.name;
    while (d.dirs.length === 1 && !d.files.length) {
      d = d.dirs[0];
      label += ` › ${d.name}`;
    }
    const n = countFiles(d);
    return { label, hint: `${n} ${n === 1 ? 'som' : 'sons'}`, sub: treeItems(d, h) };
  });
  const files = node.files.map((f) => fileItem(f.n, f.p, h));
  return dirs.length && files.length ? [...dirs, { sep: true, label: '' }, ...files] : [...dirs, ...files];
}

function countFiles(n: SampleNode): number {
  return n.files.length + n.dirs.reduce((s, d) => s + countFiles(d), 0);
}
