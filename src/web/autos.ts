// Criar automação (botão direito em knobs, BPM...): coloca um clipe de automação na
// playlist e abre a Central de Automações nele. A Central só edita o clipe aberto.

import type { AutoTarget, Clip } from '../core/model';
import { uid, ticksPerBar } from '../core/model';
import { ins } from '../core/ops';
import * as A from '../core/actions';
import { renderGen, type AutoGen } from '../core/autogen';
import { state, edit, emit, openWindow, toast } from './state';
import { playheadTick } from './clipaudio';

/** Alvo da automação do andamento. */
export const BPM_TARGET: AutoTarget = { path: ['bpm'], min: 40, max: 240, label: 'BPM' };

/**
 * Cria o clipe na área selecionada (ou a partir do compasso da agulha, 4 compassos)
 * numa track livre, com um riser do valor atual até o máximo, e abre a Central.
 */
export function createAutomation(target: AutoTarget) {
  const p = state.project;
  const bar = ticksPerBar(p);
  const sel = state.sel;
  const head = Math.floor(playheadTick() / bar) * bar;
  const pos = sel ? sel.start : head;
  const len = sel ? sel.end - sel.start : 4 * bar;
  const now = A.normalizedNow(p, target);
  const gen: AutoGen = { kind: 'ramp', lo: now, hi: now < 0.95 ? 1 : 0, curve: 0 };
  const track = A.freeTrack(p, pos, len);
  const clip: Clip = { id: uid('k'), kind: 'auto', track, pos, len, patternId: '', offset: 0, target, gen, points: renderGen(gen, len) };
  const ops = [];
  for (let t = p.tracks.length; t <= track; t++) ops.push(ins(['tracks'], { id: uid('t'), name: `Track ${t + 1}`, color: '#7a8a96', mute: false }));
  ops.push(ins(['clips'], clip));
  edit(ops, 'Criar automação');
  openAutoCenter(clip.id);
  toast(`Automação de ${target.label} na track ${track + 1}: escolha a função na Central`);
}

/** Abre um clipe de automação (novo ou existente) na Central. */
export function openAutoCenter(clipId: string) {
  state.autoClip = clipId;
  openWindow('autos');
  emit();
}
