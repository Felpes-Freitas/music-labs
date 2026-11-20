// Gravações do amp com reamp: o áudio bruto (sem efeitos) fica guardado ao lado da versão
// processada, e o canal de áudio guarda a cadeia de pedais. Mudar um pedal depois refaz a
// versão processada a partir do bruto.
//
// Qual versão toca:
// - processada (pré-renderizada, alta qualidade, custo zero) quando ela está em dia com a
//   cadeia e nenhum pedal tem automação;
// - bruto + pedais em tempo real quando há automação num pedal do canal, ou enquanto a
//   versão processada ainda está sendo refeita depois de uma mudança (resposta imediata).

import type { Channel, Clip, Project } from './model.js';

/** Assinatura da cadeia: muda quando qualquer pedal, mix ou ganho muda. */
export function ampSig(amp: NonNullable<Channel['amp']>): string {
  return JSON.stringify([amp.outGainDb ?? 0, amp.chain.map((e) => [e.type, e.enabled, e.mix, e.params])]);
}

/** Caminho da automação de um parâmetro de pedal do canal. */
export const ampParamPath = (chId: string, fxId: string, key: string) => ['channels', chId, 'amp', 'chain', fxId, 'params', key];

/** Algum clipe de automação mexe nos pedais deste canal? */
export function ampAutomated(p: Project, chId: string): boolean {
  return p.clips.some((c) => c.kind === 'auto' && !c.muted && c.target?.path[0] === 'channels' && c.target.path[1] === chId && c.target.path[2] === 'amp');
}

/** O canal toca o bruto com os pedais em tempo real (em vez da versão processada)? */
export function ampLive(p: Project, ch: Channel): boolean {
  if (ch.type !== 'audio' || !ch.amp) return false;
  return ch.amp.sig !== ampSig(ch.amp) || ampAutomated(p, ch.id);
}

/** Arquivo bruto do áudio que um clipe toca (null se ele não tem). */
export function rawOf(p: Project, c: Pick<Clip, 'sample'>): string | null {
  if (!c.sample) return null;
  const it = (p.audios ?? []).find((a) => a.path === c.sample);
  return it?.raw ?? null;
}
