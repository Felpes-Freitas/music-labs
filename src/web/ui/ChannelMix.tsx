// Configurações de mixagem de um canal: volume, pan, mute, insert do mixer e os efeitos
// do canal. Aparece no canal de áudio (duplo clique num áudio) e na aba de configurações
// do Melodify e do Stitcher — sempre o mesmo canal do rack, então mexer aqui é o mesmo
// que mexer no rack ou no mixer.

import type { Channel } from '../../core/model';
import { set } from '../../core/ops';
import { edit, previewEdit, openWindow, useApp } from '../state';
import { Knob, dbFmt, panFmt } from './widgets';
import { ChannelFx } from './ChannelFx';

export function ChannelMix({ ch }: { ch: Channel }) {
  const p = useApp().project;
  const path = ['channels', ch.id];
  return (
    <div class="chmix">
      <div class="chmix-row">
        <Knob size={34} label="Volume" value={ch.volume} min={0} max={1.25} def={0.78} format={dbFmt} auto={{ path: [...path, 'volume'], label: `${ch.name} · volume` }} onInput={(v) => previewEdit([set([...path, 'volume'], v)])} onCommit={(v) => edit([set([...path, 'volume'], v)])} />
        <Knob size={34} label="Pan" value={ch.pan} min={-1} max={1} def={0} bipolar format={panFmt} auto={{ path: [...path, 'pan'], label: `${ch.name} · pan` }} onInput={(v) => previewEdit([set([...path, 'pan'], v)])} onCommit={(v) => edit([set([...path, 'pan'], v)])} />
        <button class={`chmix-mute ${ch.mute ? 'on' : ''}`} onClick={() => edit([set([...path, 'mute'], !ch.mute)])} data-hint="Silenciar o canal">
          {ch.mute ? 'Mudo' : 'Mute'}
        </button>
        <label class="chmix-ins" data-hint="Insert do mixer para onde o canal vai (lá ficam o fader, o pan e os efeitos do insert)">
          <span>Mixer</span>
          <select value={ch.insert} onChange={(e) => edit([set([...path, 'insert'], Number((e.target as HTMLSelectElement).value))])}>
            {p.mixer.map((m, i) => (
              <option value={i}>{i === 0 ? 'Master' : `${i} · ${m.name}`}</option>
            ))}
          </select>
        </label>
        <button onClick={() => openWindow('mixer')} data-hint="Abrir o mixer (F9)">
          Abrir mixer
        </button>
      </div>
      <ChannelFx ch={ch} />
    </div>
  );
}
