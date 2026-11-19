// Lista de áudios do projeto (como a de patterns): gravações feitas no Afinador e
// no Stitcher, arquivos importados e variantes. O arquivo original de cada áudio
// nunca é apagado; editar "no próprio áudio" só troca o arquivo atual.

import type { AudioItem, Project } from '../core/model';
import { PPQ, uid } from '../core/model';
import { set, ins, rem, type Op } from '../core/ops';
import * as A from '../core/actions';
import { encodeWav } from '../core/wav';
import { state, edit, act, toast } from './state';
import { loadAudio, makeRoomBelow, playheadTick, ticksPerSec, uploadFiles } from './clipaudio';
import { getPref } from './prefs';
import { audio } from './audio';

export const poolItems = (p: Project = state.project): AudioItem[] => p.audios ?? [];
export const poolItem = (id: string | null | undefined) => (id ? poolItems().find((a) => a.id === id) : undefined);
const baseName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.[a-z0-9]{2,5}$/i, '');

/** Põe um arquivo na lista (ou devolve o que já tem esse arquivo). */
export function addToPool(path: string, name?: string, variantOf?: string): string {
  const hit = poolItems().find((a) => a.path === path || a.original === path);
  if (hit) return hit.id;
  const item: AudioItem = { id: uid('au'), name: name ?? baseName(path), path, original: path, ...(variantOf ? { variantOf } : {}) };
  edit([ins(['audios'], item)]);
  return item.id;
}

/** Salva um áudio novo em ~/MusicLabs/Gravações e devolve o caminho. */
export async function saveWav(L: Float32Array, R: Float32Array, sr: number, name: string) {
  const wav = encodeWav(L, R, sr, 24);
  const res = await fetch(`/api/recording?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Blob([wav as BlobPart], { type: 'audio/wav' }) });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error);
  return d.path as string;
}

/**
 * Guarda o resultado de uma edição. variant = cria um áudio novo na lista (o
 * original fica como está); senão troca o arquivo do próprio áudio (o original
 * continua guardado) e os clipes da playlist que usavam a versão anterior passam
 * a usar a nova. Devolve o id do áudio resultante.
 */
export async function commitEdit(id: string, L: Float32Array, R: Float32Array, sr: number, variant: boolean, suffix = 'variante') {
  const it = poolItem(id);
  if (!it) throw new Error('áudio não encontrado na lista');
  const n = poolItems().filter((a) => a.variantOf === id).length + 1;
  const name = variant ? `${it.name} (${suffix}${n > 1 ? ' ' + n : ''})` : it.name;
  const path = await saveWav(L, R, sr, name);
  if (variant) {
    const nid = uid('au');
    edit([ins(['audios'], { id: nid, name, path, original: path, variantOf: id } satisfies AudioItem)]);
    return nid;
  }
  const ops: Op[] = [set(['audios', id, 'path'], path), set(['audios', id, 'edited'], undefined)];
  for (const c of state.project.clips) if (c.sample === it.path) ops.push(set(['clips', c.id, 'sample'], path));
  edit(ops);
  return id;
}

/** O áudio tem edições (ativas ou desativadas)? */
export const hasEdits = (id: string) => {
  const it = poolItem(id);
  return !!it && (it.path !== it.original || !!it.edited);
};
export const editsOn = (id: string) => {
  const it = poolItem(id);
  return !!it && it.path !== it.original;
};

/**
 * Liga/desliga as edições sem perder nada: desligar volta ao original (guardando a
 * versão editada); ligar volta à versão editada. Os clipes da playlist acompanham.
 */
export function toggleEdits(id: string) {
  const it = poolItem(id);
  if (!it) return;
  let to: string;
  const ops: Op[] = [];
  if (it.path !== it.original) {
    to = it.original;
    ops.push(set(['audios', id, 'edited'], it.path));
  } else if (it.edited) {
    to = it.edited;
    ops.push(set(['audios', id, 'edited'], undefined));
  } else return;
  ops.push(set(['audios', id, 'path'], to));
  for (const c of state.project.clips) if (c.sample === it.path) ops.push(set(['clips', c.id, 'sample'], to));
  edit(ops);
}
/** Compatibilidade: restaurar = desativar as edições (a versão editada fica guardada). */
export const restoreOriginal = (id: string) => editsOn(id) && toggleEdits(id);

export function removeFromPool(id: string) {
  edit([rem(['audios', id])]);
}

export function renameAudio(id: string, name: string) {
  edit([set(['audios', id, 'name'], name)]);
}

/**
 * Coloca o áudio na playlist. Variante de um áudio que já está na playlist vai
 * logo abaixo dele, no mesmo lugar; o resto vai para a posição atual da música.
 */
export async function sendToPlaylist(id: string) {
  const it = poolItem(id);
  if (!it) return;
  const a = await loadAudio(it.path);
  const secs = a.ch[0].length / a.sr;
  const p = state.project;
  const parent = poolItem(it.variantOf);
  const under = parent && p.clips.find((c) => c.sample === parent.path || c.sample === parent.original);
  if (under) {
    const track = makeRoomBelow(under.track, under.pos, under.len);
    act(A.addAudioClip, { sample: it.path, bar: 1, beat: under.pos / PPQ, track: track + 1, startSec: under.startSec ?? 0, lengthSec: under.len / ticksPerSec(p), insert: under.insert, gain: under.gain });
    toast(`${it.name} na playlist, logo abaixo do original`);
    return;
  }
  const tick = playheadTick();
  const len = Math.round(secs * ticksPerSec(p));
  const track = A.freeTrack(p, tick, len);
  act(A.addAudioClip, { sample: it.path, bar: 1, beat: tick / PPQ, track: track + 1, lengthSec: secs });
  toast(`${it.name} na playlist (track ${track + 1})`);
}

/** Corta o silêncio do começo e do fim de uma gravação (deixa uma margem curta). */
export function trimSilence(L: Float32Array, R: Float32Array, sr: number): [Float32Array, Float32Array] {
  const win = Math.round(sr * 0.01);
  const n = Math.floor(L.length / win);
  if (n < 10) return [L, R];
  const rms: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * win; j < (i + 1) * win; j++) s += L[j] * L[j] + R[j] * R[j];
    rms.push(Math.sqrt(s / (2 * win)));
  }
  const sorted = rms.slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)];
  const thr = Math.max(floor * 4, 0.003);
  let a = rms.findIndex((v) => v > thr), b = n - 1 - [...rms].reverse().findIndex((v) => v > thr);
  if (a < 0) return [L, R];
  a = Math.max(0, a - 15); // 150 ms antes
  b = Math.min(n, b + 30); // 300 ms depois
  return [L.slice(a * win, b * win), R.slice(a * win, b * win)];
}

/** Grava pela captura avulsa (sem tocar a música) e coloca o áudio na lista. */
export async function startToolRecording() {
  await audio.startCapture({ deviceId: getPref<string>('rec.device', '') || undefined, channels: getPref('rec.channels', 'stereo') });
}
export async function finishToolRecording(name: string): Promise<string | null> {
  const r = audio.stopCapture();
  if (!r || r.L.length < r.sr * 0.15) return null;
  const [L, R] = trimSilence(r.L, r.R, r.sr);
  const n = poolItems().filter((a) => a.name.startsWith(name)).length + 1;
  const path = await saveWav(L, R, r.sr, `${name} ${n}`);
  return addToPool(path, `${name} ${n}`);
}

/** Arquivos do computador → lista de áudios. */
export async function importToPool(files: File[]) {
  const paths = await uploadFiles(files);
  return paths.map((p) => addToPool(p));
}
