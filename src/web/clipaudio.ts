// Utilidades das ferramentas de áudio (Melodify, Stitcher): ler o áudio de um
// clipe e salvar um resultado como clipe novo na playlist.

import { decodeWav, encodeWav } from '../core/wav';
import { PPQ, uid, color, type Clip, type Project } from '../core/model';
import { set, ins, type Op } from '../core/ops';
import * as A from '../core/actions';
import { alignOffset } from '../core/align';
import { audio } from './audio';
import { state, act, edit } from './state';

const cache = new Map<string, Promise<{ sr: number; ch: Float32Array[] }>>();

/** Áudio decodificado de um arquivo (em cache). */
export function loadAudio(path: string) {
  let p = cache.get(path);
  if (!p) {
    p = fetch(`/api/sample?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`não consegui ler ${path.split('/').pop()}`);
        const d = decodeWav(new Uint8Array(await r.arrayBuffer()));
        return { sr: d.sr, ch: d.ch };
      })
      .catch((e) => {
        cache.delete(path);
        throw e;
      });
    cache.set(path, p);
  }
  return p;
}

export const ticksPerSec = (p: Project) => (p.bpm * PPQ) / 60;
export const audioClips = (p: Project) => p.clips.filter((c) => c.kind === 'audio' && c.sample);
export const clipName = (c: Clip) => (c.sample ?? '').split(/[\\/]/).pop()?.replace(/\.wav$/i, '') ?? '?';

/** Primeira track abaixo de `from` livre no trecho [pos, pos+len) (pode ser uma nova). */
export function trackBelow(p: Project, from: number, pos: number, len: number) {
  for (let t = from + 1; t < p.tracks.length; t++) if (!p.clips.some((c) => c.track === t && c.pos < pos + len && c.pos + c.len > pos)) return t;
  return Math.max(from + 1, p.tracks.length);
}

/**
 * Track logo abaixo de `track`: se ela estiver ocupada nesse trecho, insere uma
 * track nova ali (as de baixo descem uma posição). Devolve o índice.
 */
export function makeRoomBelow(track: number, pos: number, len: number) {
  const p = state.project;
  const below = track + 1;
  if (below >= p.tracks.length || !p.clips.some((c) => c.track === below && c.pos < pos + len && c.pos + c.len > pos)) return below;
  const ops: Op[] = [ins(['tracks'], { id: uid('t'), name: `${p.tracks[track]?.name ?? 'Track'} (var.)`, color: color(below), mute: false }, below)];
  for (const c of p.clips) if (c.track >= below) ops.push(set(['clips', c.id, 'track'], c.track + 1));
  edit(ops);
  return below;
}

/** Salva o áudio em ~/MusicLabs/Gravações e coloca um clipe na playlist. Devolve o id do clipe. */
export async function saveAsClip(L: Float32Array, R: Float32Array, sr: number, name: string, place: { tick: number; track: number | (() => number); startSec?: number; lengthSec?: number; insert?: number; gain?: number }) {
  const wav = encodeWav(L, R, sr, 24);
  const res = await fetch(`/api/recording?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Blob([wav as BlobPart], { type: 'audio/wav' }) });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error);
  const r = act(A.addAudioClip, {
    sample: d.path,
    bar: 1,
    beat: place.tick / PPQ,
    track: (typeof place.track === 'function' ? place.track() : place.track) + 1, // a track só é criada depois que o arquivo foi salvo
    startSec: place.startSec ?? 0,
    lengthSec: place.lengthSec ?? L.length / sr - (place.startSec ?? 0),
    insert: place.insert,
    gain: place.gain,
  });
  return r ? (r as { clip: string }).clip : null;
}

export const projectName = () => state.project.name || 'Sem título';

/** Envia arquivos escolhidos no computador para ~/MusicLabs/Importados. Devolve os caminhos. */
export async function uploadFiles(files: File[]) {
  const out: string[] = [];
  for (const f of files) {
    const r = await fetch(`/api/import?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    const d = await r.json();
    if (!r.ok) throw new Error(`${f.name}: ${d.error}`);
    out.push(d.path);
  }
  return out;
}

/** Caminhos de áudio soltos numa janela (arquivos do computador ou itens do navegador de samples). */
export async function droppedAudio(e: DragEvent): Promise<string[]> {
  const dt = e.dataTransfer;
  if (!dt) return [];
  const sample = dt.getData('text/x-musiclabs-sample');
  if (sample) return [sample];
  const files = [...dt.files].filter((f) => /^audio\//.test(f.type) || /\.(wav|mp3|flac|ogg|m4a|aac|opus|aiff?)$/i.test(f.name));
  return files.length ? uploadFiles(files) : [];
}
export const acceptsAudio = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/x-musiclabs-sample'));

/** Abre o seletor de arquivos do sistema (vários de uma vez). */
export function pickAudioFiles(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aiff,.opus';
    inp.multiple = multiple;
    inp.onchange = () => resolve([...(inp.files ?? [])]);
    inp.click();
  });
}

/** Posição da música agora (ou 0 se estiver no modo pattern). */
export const playheadTick = () => (audio.status.mode === 'song' ? Math.max(0, Math.floor(audio.status.tick)) : 0);

/**
 * Coloca áudios na playlist a partir de `tick`, cada um numa track livre. Com
 * align, os takes são alinhados ao primeiro pelo contorno de volume (gravações
 * da mesma parte que começam em momentos diferentes do arquivo).
 */
export async function placeAudios(paths: string[], tick: number, align = false) {
  const p0 = state.project;
  const tps = ticksPerSec(p0);
  const loaded = await Promise.all(paths.map((x) => loadAudio(x)));
  const mono = (a: { ch: Float32Array[] }) => {
    const m = new Float32Array(a.ch[0].length);
    for (const c of a.ch) for (let i = 0; i < m.length; i++) m[i] += c[i] / a.ch.length;
    return m;
  };
  const ref = align && loaded.length > 1 ? mono(loaded[0]) : null;
  const ids: string[] = [];
  loaded.forEach((a, i) => {
    const secs = a.ch[0].length / a.sr;
    let pos = tick, startSec = 0;
    if (ref && i > 0) {
      const d = alignOffset(ref, mono(a), a.sr);
      pos = Math.round(tick - d * tps);
      if (pos < 0) {
        startSec = -pos / tps;
        pos = 0;
      }
    }
    const len = Math.round((secs - startSec) * tps);
    const track = A.freeTrack(state.project, pos, len);
    const r = act(A.addAudioClip, { sample: paths[i], bar: 1, beat: pos / PPQ, track: track + 1, startSec, lengthSec: secs - startSec });
    if (r) ids.push((r as { clip: string }).clip);
  });
  return ids;
}
