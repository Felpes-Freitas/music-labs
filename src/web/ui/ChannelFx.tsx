// Faixa de 4 efeitos do canal (sempre visível, acima do teclado).

import type { Channel, Effect, EffectType } from '../../core/model';
import { EFFECTS, type ParamDef } from '../../core/registry';
import { CHANNEL_FX_MAX } from '../../core/actions';
import * as A from '../../core/actions';
import { set } from '../../core/ops';
import { act, edit, previewEdit } from '../state';
import { Knob, fmt } from './widgets';

/** Os controles principais de cada efeito (o resto fica no padrão). */
const MAIN: Record<EffectType, string[]> = {
  reverb: ['size', 'damp'],
  delay: ['time', 'feedback'],
  phaser: ['rate', 'depth', 'feedback'],
  chorus: ['rate', 'depth'],
  distortion: ['drive', 'tone'],
  filter: ['cutoff', 'res', 'lfoDepth'],
  eq: ['lowGain', 'm1Gain', 'highGain'],
  compressor: ['threshold', 'ratio'],
  bitcrusher: ['bits', 'downsample'],
  stereo: ['width'],
  limiter: ['gain'],
};

/** Ordem do seletor: os básicos primeiro. */
const ORDER: EffectType[] = ['reverb', 'delay', 'phaser', 'chorus', 'distortion', 'filter', 'eq', 'compressor', 'bitcrusher', 'stereo', 'limiter'];

const fmtFor = (d: ParamDef) => (x: number) => {
  if (d.unit === 'Hz') return x >= 1000 ? `${(x / 1000).toFixed(2)} kHz` : `${Math.round(x)} Hz`;
  if (d.step && d.step >= 1) return `${Math.round(x)}${d.unit ? ' ' + d.unit : ''}`;
  if (!d.unit && d.min === 0 && (d.max === 1 || d.max === 0.95 || d.max === 0.9)) return `${Math.round(x * 100)}%`;
  return `${fmt(x)}${d.unit ? ' ' + d.unit : ''}`;
};

function Slot(p: { ch: Channel; fx: Effect | undefined; index: number }) {
  const { ch, fx } = p;
  if (!fx)
    return (
      <div class="cfx-slot empty">
        <span class="cfx-n">{p.index + 1}</span>
        <select
          value=""
          data-hint="Adicionar um efeito ao som deste canal"
          onChange={(e) => {
            const t = (e.target as HTMLSelectElement).value as EffectType;
            (e.target as HTMLSelectElement).value = '';
            if (t) act(A.addChannelEffect, { channel: ch.id, type: t });
          }}
        >
          <option value="">+ efeito</option>
          {ORDER.map((t) => (
            <option value={t}>{EFFECTS[t].label}</option>
          ))}
        </select>
      </div>
    );
  const path = ['channels', ch.id, 'effects', fx.id];
  const defs = EFFECTS[fx.type].params;
  return (
    <div class={`cfx-slot ${fx.enabled ? '' : 'off'}`}>
      <div class="cfx-top">
        <button class={`led ${fx.enabled ? 'on' : ''}`} data-hint="Ligar/desligar" onClick={() => edit([set([...path, 'enabled'], !fx.enabled)])} />
        <select value={fx.type} data-hint={EFFECTS[fx.type].description} onChange={(e) => act(A.updateChannelEffect, { channel: ch.id, effect: fx.id, type: (e.target as HTMLSelectElement).value as EffectType })}>
          {ORDER.map((t) => (
            <option value={t}>{EFFECTS[t].label}</option>
          ))}
        </select>
        <button class="cfx-x" data-hint="Remover efeito" onClick={() => act(A.removeChannelEffect, { channel: ch.id, effect: fx.id })}>
          ×
        </button>
      </div>
      <div class="cfx-knobs">
        {MAIN[fx.type].map((k) => {
          const d = defs.find((x) => x.key === k);
          if (!d) return null;
          const v = fx.params[k] ?? d.def;
          if (d.kind === 'enum')
            return (
              <label class="cfx-enum">
                <select value={String(v)} onChange={(e) => edit([set([...path, 'params', k], (e.target as HTMLSelectElement).value)])}>
                  {d.options!.map((o) => (
                    <option>{o}</option>
                  ))}
                </select>
                <span>{d.label}</span>
              </label>
            );
          return (
            <Knob
              size={24}
              value={Number(v)}
              min={d.min!}
              max={d.max!}
              def={Number(d.def)}
              log={d.curve === 'log' && d.min! > 0}
              step={d.step}
              bipolar={d.min! < 0 && d.max! > 0}
              label={d.label}
              format={fmtFor(d)}
              auto={{ path: [...path, 'params', k], label: `${ch.name} · ${EFFECTS[fx.type].label} · ${d.label}` }}
              onInput={(x) => previewEdit([set([...path, 'params', k], x)])}
              onCommit={(x) => edit([set([...path, 'params', k], x)])}
            />
          );
        })}
        <Knob
          size={24}
          value={fx.mix}
          min={0}
          max={1}
          def={1}
          color="#6fdc8c"
          label="Mix"
          format={(x) => `${Math.round(x * 100)}%`}
          onInput={(x) => previewEdit([set([...path, 'mix'], x)])}
          onCommit={(x) => edit([set([...path, 'mix'], x)])}
        />
      </div>
    </div>
  );
}

export function ChannelFx(p: { ch: Channel }) {
  const list = p.ch.effects ?? [];
  return (
    <div class="cfx" data-hint="Efeitos do canal: processam o som deste instrumento antes do mixer">
      <div class="cfx-title">Efeitos</div>
      {Array.from({ length: CHANNEL_FX_MAX }, (_, i) => (
        <Slot ch={p.ch} fx={list[i]} index={i} />
      ))}
    </div>
  );
}
