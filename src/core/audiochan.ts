// Áudios como canais do rack (como no FL Studio): cada áudio do projeto tem um canal do
// tipo "audio" com volume, pan, insert do mixer e efeitos; os clipes de áudio da playlist
// tocam por esse canal. Um áudio novo ganha também um pattern com o nome dele, que serve
// de grupo no rack (o filtro "só deste pattern" mostra o canal).
//
// completeOps olha o projeto depois de uma edição e devolve o que falta para ele ficar
// coerente: canais dos áudios novos, o pattern-grupo, o insert do mixer e as tracks que
// os clipes usam (a playlist mostra tracks infinitas; só as usadas existem no projeto).
// Roda em toda edição (interface e servidor) e ao abrir projetos antigos.

import type { Channel, Clip, Pattern, Project } from './model.js';
import { color, uid } from './model.js';
import { ins, set, type Op } from './ops.js';

/** Nome do arquivo sem pasta e sem extensão. */
export const fileLabel = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.[a-z0-9]{2,5}$/i, '');

/** Insert livre do mixer (sem canal, nome padrão, sem efeitos), ou 0 (master). */
function freeInsert(p: Project, taken: Set<number>): number {
  for (let i = 1; i < p.mixer.length; i++) {
    if (taken.has(i)) continue;
    if (/^Insert \d+$/.test(p.mixer[i].name) && p.mixer[i].effects.length === 0) return i;
  }
  return 0;
}

/** Canal de áudio de um clipe (o do campo channel, se ainda existir). */
export function clipChannel(p: Project, c: Clip): Channel | undefined {
  return c.channel ? p.channels.find((x) => x.id === c.channel && x.type === 'audio') : undefined;
}

/** O canal de áudio de um arquivo (pela lista de áudios ou pelo sample do canal). */
export function audioChannelOf(p: Project, path: string): Channel | undefined {
  const it = (p.audios ?? []).find((a) => a.path === path || a.original === path || a.edited === path);
  const byItem = it?.channel ? p.channels.find((c) => c.id === it.channel && c.type === 'audio') : undefined;
  return byItem ?? p.channels.find((c) => c.type === 'audio' && c.params.sample === path);
}

/** Patterns em que o canal aparece: tem notas nele ou foi posto nele (grupo). */
export function channelInPattern(pat: Pattern, chId: string): boolean {
  return (pat.notes[chId]?.length ?? 0) > 0 || (pat.channels ?? []).includes(chId);
}

export function completeOps(p: Project): Op[] {
  const ops: Op[] = [];
  // tracks que os clipes usam
  let maxTrack = -1;
  for (const c of p.clips) if (c.track > maxTrack) maxTrack = c.track;
  for (let t = p.tracks.length; t <= maxTrack; t++) ops.push(ins(['tracks'], { id: uid('t'), name: `Track ${t + 1}`, color: color(t), mute: false }));

  // canais dos áudios
  const taken = new Set(p.channels.map((c) => c.insert));
  const byPath = new Map<string, string>();
  for (const c of p.channels) if (c.type === 'audio' && typeof c.params.sample === 'string') byPath.set(c.params.sample, c.id);
  const exists = (id?: string) => !!id && p.channels.some((c) => c.id === id && c.type === 'audio');
  for (const it of p.audios ?? []) if (exists(it.channel)) for (const k of [it.path, it.original, it.edited]) if (k) byPath.set(k, it.channel!);
  let n = p.channels.length;
  const make = (path: string, name: string, insertHint?: number): string => {
    const id = uid('c');
    let insert = insertHint && insertHint > 0 ? insertHint : freeInsert(p, taken);
    if (insert > 0) {
      taken.add(insert);
      if (!insertHint) ops.push(set(['mixer', insert, 'name'], name));
    }
    const ch: Channel = { id, name, color: color(n++), type: 'audio', params: { sample: path }, volume: 0.78, pan: 0, pitch: 0, mute: false, insert, effects: [] };
    ops.push(ins(['channels'], ch));
    const pat: Pattern = { id: uid('p'), name, color: ch.color, length: 0, notes: {}, channels: [id] };
    ops.push(ins(['patterns'], pat));
    byPath.set(path, id);
    return id;
  };
  for (const it of p.audios ?? []) {
    if (exists(it.channel)) continue;
    const id = byPath.get(it.path) ?? byPath.get(it.original) ?? make(it.path, it.name);
    for (const k of [it.path, it.original, it.edited]) if (k) byPath.set(k, id);
    ops.push(set(['audios', it.id, 'channel'], id));
  }
  for (const c of p.clips) {
    if (c.kind !== 'audio' || !c.sample || exists(c.channel)) continue;
    const id = byPath.get(c.sample) ?? make(c.sample, fileLabel(c.sample), c.insert);
    ops.push(set(['clips', c.id, 'channel'], id));
  }
  return ops;
}
