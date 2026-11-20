// Menu do botão direito numa área selecionada da playlist: preencher a área com um
// pattern (repetido e cortado para caber) ou inserir um instrumento novo ali (um
// pattern novo, só com ele, ocupando a área, pronto para gravar).

import { useEffect, useState } from 'preact/hooks';
import { state, edit, act, api, toast, selectPattern, selectChannel, openWindow, setSelection } from '../state';
import * as A from '../../core/actions';
import { INSTRUMENTS, PRESETS } from '../../core/registry';
import { patternLength, uid, color, STEP, type Clip, type InstrumentType, type Pattern } from '../../core/model';
import { ins, rem, type Op } from '../../core/ops';
import { MenuTree, type MenuItem } from './widgets';
import { instrumentMenu, loadLib, libNow, type Lib } from '../addmenu';
import { addSampleChannel } from './Browser';


/** Clipes do pattern repetido para encher [start, end) na track (o último é cortado). */
export function fillOps(patId: string, track: number, start: number, end: number): Op[] {
  const p = state.project;
  const pat = p.patterns.find((x) => x.id === patId);
  if (!pat) return [];
  const plen = patternLength(p, pat);
  const ops: Op[] = [];
  for (let pos = start; pos < end; pos += plen) ops.push(ins(['clips'], { id: uid('k'), track, pos, len: Math.min(plen, end - pos), patternId: patId, offset: 0 } satisfies Clip));
  return ops;
}

export function SelectionMenu(p: { x: number; y: number; track: number; sel: { start: number; end: number }; onClose: () => void }) {
  const [lib, setLib] = useState<Lib | null>(libNow());
  useEffect(() => {
    if (!lib) loadLib().then(setLib);
  }, []);
  const proj = state.project;
  const { start, end } = p.sel;
  const track = Math.max(0, p.track); // tracks infinitas: a clicada passa a existir se for usada

  /** Depois de criar o canal: pattern novo só com ele, ocupando a área. */
  const placeNew = (channelId: string, name: string) => {
    const pat: Pattern = { id: uid('p'), name, color: color(state.project.patterns.length), length: Math.round((end - start) / STEP), notes: { [channelId]: [] } };
    edit([ins(['patterns'], pat), ...fillOpsFor(pat, track, start, end)]);
    selectPattern(pat.id);
    selectChannel(channelId);
    toast(`${name}: pattern novo na área selecionada. Toque no teclado com o REC ligado para gravar`);
  };
  const fillOpsFor = (pat: Pattern, tr: number, a: number, b: number): Op[] => [ins(['clips'], { id: uid('k'), track: tr, pos: a, len: b - a, patternId: pat.id, offset: 0 } satisfies Clip)];
  /** Abre a ferramenta lembrando a track clicada (o áudio dela vai para lá). */
  const openTool = (k: 'amp' | 'tune' | 'stitch', label: string) => {
    state.selTrack = track;
    openWindow(k, false);
    toast(`${label}: o áudio vai para a track ${track + 1}, no começo da área`);
  };
  const newChannel = (args: { type?: InstrumentType; preset?: string }, label: string) => {
    const r = act(A.addChannel, args);
    if (r) placeNew((r as { id: string }).id, label);
  };
  const newSample = async (path: string, name: string) => {
    const before = state.channelId;
    await addSampleChannel(path, name);
    if (state.channelId && state.channelId !== before) placeNew(state.channelId, name);
  };

  const items: MenuItem[] = [
    {
      label: 'Preencher com',
      hint: 'Repete o pattern escolhido em toda a área (o último é cortado se não couber)',
      sub: proj.patterns.length
        ? proj.patterns.map((pt) => ({
            label: pt.name,
            swatch: pt.color,
            run: () => {
              edit(fillOps(pt.id, track, start, end));
              selectPattern(pt.id);
            },
          }))
        : [{ label: '(nenhum pattern)' }],
    },
    {
      label: 'Inserir instrumento',
      hint: 'Cria um instrumento e um pattern novo só com ele, ocupando a área',
      sub: [
        ...instrumentMenu(lib, {
          native: (t) => newChannel({ type: t }, INSTRUMENTS[t].label),
          preset: (k) => newChannel({ preset: k }, k),
          sample: (path, name) => void newSample(path, name),
        }),
        { sep: true, label: '' },
        { label: 'Amp de guitarra', hint: 'O áudio vai para esta track, no começo da área', run: () => openTool('amp', 'Amp de guitarra') },
        { label: 'Melodify', hint: 'O áudio vai para esta track, no começo da área', run: () => openTool('tune', 'Melodify') },
        { label: 'Stitcher', hint: 'O áudio vai para esta track, no começo da área', run: () => openTool('stitch', 'Stitcher') },
      ],
    },
    { sep: true, label: '' },
    {
      label: 'Apagar clipes da área (nesta track)',
      run: () => edit(state.project.clips.filter((c) => c.track === track && c.pos < end && c.pos + c.len > start).map((c) => rem(['clips', c.id]))),
    },
    { label: 'Tirar a seleção', run: () => setSelection(null) },
  ];
  return <MenuTree x={p.x} y={p.y} items={items} onClose={p.onClose} />;
}
