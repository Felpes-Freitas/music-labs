// Reamp das gravações do amp: quando a cadeia de pedais de um canal muda, refaz a versão
// processada a partir do áudio bruto, em segundo plano e em alta qualidade. Enquanto isso
// (e sempre que houver automação num pedal) a engine toca o bruto pelos pedais em tempo
// real (core/reamp.ts), então a mudança se ouve na hora.

import type { Channel } from '../core/model';
import { set, type Op } from '../core/ops';
import { renderChain } from '../core/effects';
import { encodeWav } from '../core/wav';
import { ampSig } from '../core/reamp';
import { state, onState, edit, emit, openWindow, toast } from './state';
import { loadAudio } from './clipaudio';

/** Canal cuja gravação o amp está editando (null = amp ao vivo). */
export let reampChannel: string | null = null;
/** Canais sendo reprocessados agora. */
export const reampBusy = new Set<string>();

/** Abre o amp nos pedais de uma gravação. */
export function openAmpReamp(channelId: string) {
  reampChannel = channelId;
  openWindow('amp');
  emit();
}
export function closeAmpReamp() {
  reampChannel = null;
  emit();
}

let timer = 0;
let running = false;
onState(() => {
  clearTimeout(timer);
  timer = window.setTimeout(run, 900);
});

/** Canais com a versão processada desatualizada (e com bruto para refazer). */
function stale(): Channel[] {
  const p = state.project;
  return p.channels.filter((ch) => ch.type === 'audio' && ch.amp && ch.amp.sig !== ampSig(ch.amp) && (p.audios ?? []).some((a) => a.channel === ch.id && a.raw));
}

async function run() {
  if (running) return;
  const list = stale();
  if (!list.length) return;
  running = true;
  try {
    for (const ch of list) await reamp(ch.id);
  } finally {
    running = false;
  }
  // mudou de novo enquanto refazia: mais uma volta
  if (stale().length) timer = window.setTimeout(run, 300);
}

async function reamp(chId: string) {
  const ch0 = state.project.channels.find((c) => c.id === chId);
  if (!ch0?.amp) return;
  const amp = JSON.parse(JSON.stringify(ch0.amp)) as NonNullable<Channel['amp']>;
  const sig = ampSig(amp);
  reampBusy.add(chId);
  emit();
  try {
    const items = (state.project.audios ?? []).filter((a) => a.channel === chId && a.raw);
    const ops: Op[] = [];
    for (const it of items) {
      const a = await loadAudio(it.raw!);
      const L = a.ch[0], R = a.ch[1] ?? a.ch[0];
      // deixa a interface respirar entre um take e outro
      await new Promise((r) => setTimeout(r, 0));
      const [wl, wr] = renderChain(a.sr, amp.chain, L, R, { bpm: state.project.bpm, outGainDb: amp.outGainDb, tailSec: 2.5 });
      const res = await fetch(`/api/recording?name=${encodeURIComponent(state.project.name)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Blob([encodeWav(wl, wr, a.sr, 24) as BlobPart], { type: 'audio/wav' }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      const old = it.path;
      ops.push(set(['audios', it.id, 'path'], d.path));
      for (const c of state.project.clips) if (c.kind === 'audio' && c.sample === old) ops.push(set(['clips', c.id, 'sample'], d.path));
      if (state.project.channels.find((c) => c.id === chId)?.params.sample === old) ops.push(set(['channels', chId, 'params', 'sample'], d.path));
    }
    // a cadeia mudou durante o processamento: estas versões já estão velhas
    const now = state.project.channels.find((c) => c.id === chId);
    if (!now?.amp || ampSig(now.amp) !== sig) return;
    ops.push(set(['channels', chId, 'amp', 'sig'], sig));
    edit(ops, 'Reamp');
  } catch (e) {
    toast(`Reamp: ${(e as Error).message}`);
  } finally {
    reampBusy.delete(chId);
    emit();
  }
}
