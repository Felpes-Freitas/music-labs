// Menu "adicionar instrumento" (encadeado): Music Labs (nativos), Presets e, para cada
// programa cuja biblioteca foi encontrada (FL Studio, Ableton...), direto nele: as famílias
// de instrumentos (Keyboard, Bass...), Bateria (todas as pastas de bateria do programa,
// com subpastas), Efeitos, Vocais e Outros. Prévia: botão direito num som (segurando e
// descendo, toca cada um por onde passa). Usado no "+ Canal" do rack, no "Substituir
// instrumento" e no "Inserir instrumento" da área selecionada da playlist.

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
      sub: (Object.keys(INSTRUMENTS) as InstrumentType[]).filter((t) => t !== 'audio').map((t) => ({ label: INSTRUMENTS[t].label, hint: INSTRUMENTS[t].description, run: () => h.native(t) })),
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
    const sub: MenuItem[] = instrumentFamilies(list, h);
    const tree = lib.trees.find((t) => t.daw === daw)?.tree;
    const cats = tree ? sampleCategories(tree) : null;
    if (cats) {
      const extra: MenuItem[] = [];
      for (const [label, hint, entries] of [
        ['Bateria', 'Todas as pastas de bateria (kicks, snares, hats, kits...)', cats.drums],
        ['Efeitos', 'SFX, risers e efeitos', cats.fx],
        ['Vocais', 'Vozes e frases', cats.vocals],
        ['Outros', 'Os demais sons soltos', cats.other],
      ] as const) {
        if (!entries.length) continue;
        const total = entries.reduce((n, e) => n + countFiles(e.node), 0);
        extra.push({ label, hint: `${hint} · ${total} sons`, sub: entries.map((e) => ({ label: e.label, hint: `${countFiles(e.node)} sons`, sub: treeItems(e.node, h) })) });
      }
      if (extra.length) sub.push({ sep: true, label: '' }, ...extra);
    } else if (daw === 'FL Studio' && lib.localSamples.length)
      // sem o índice da biblioteca: pelo menos o kit de bateria local
      sub.push({ sep: true, label: '' }, { label: 'Bateria', sub: lib.localSamples.map((x) => fileItem(x.name, x.path, h)) });
    items.push({ label: daw, hint: `Sons encontrados na instalação do ${daw}`, sub });
  }
  return items;
}

/** Um som (arquivo): escolher cria/troca o canal; botão direito ouve. */
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

type Cat = { label: string; node: SampleNode }[];
const DRUM = /drum|perc|kit|kick|snare|hat|clap|cymbal|tom|shaker|rim/i;
const FX = /sfx|\bfx\b|riser|impact|sweep/i;
const VOCAL = /vocal|voice|vox|choir/i;

/**
 * Separa a árvore de samples por tipo, pelo nome das pastas: a primeira pasta (de cima
 * para baixo) que for de bateria/efeitos/vocais leva tudo o que está dentro dela; as
 * outras pastas são abertas até achar uma dessas, e o que sobra vai para "Outros".
 */
function sampleCategories(tree: SampleNode) {
  const out = { drums: [] as Cat, fx: [] as Cat, vocals: [] as Cat, other: [] as Cat };
  const walk = (node: SampleNode, path: string) => {
    for (const d of node.dirs) {
      const label = path ? `${path} › ${d.name}` : d.name;
      if (DRUM.test(d.name)) out.drums.push({ label, node: d });
      else if (FX.test(d.name)) out.fx.push({ label, node: d });
      else if (VOCAL.test(d.name)) out.vocals.push({ label, node: d });
      else {
        walk(d, label);
        if (d.files.length) out.other.push({ label, node: { name: d.name, dirs: [], files: d.files } });
      }
    }
  };
  walk(tree, '');
  return out;
}

function countFiles(n: SampleNode): number {
  return n.files.length + n.dirs.reduce((s, d) => s + countFiles(d), 0);
}
