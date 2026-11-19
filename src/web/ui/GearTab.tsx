// Aba de configurações do canal (engrenagem): nota raiz, ajuste fino e opções
// de reprodução do áudio. Vale para todos os instrumentos.

import { useEffect, useRef } from 'preact/hooks';
import type { Channel } from '../../core/model';
import { noteName } from '../../core/model';
import { set } from '../../core/ops';
import { edit, previewEdit, setHint } from '../state';
import { audio } from '../audio';
import { themeRev } from '../theme';
import { drawKeyboard, keyAt, keyboardLayout } from './ChannelPiano';

function RootPicker(p: { ch: Channel }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const root = 60 - p.ch.pitch;
  const lo = 24, hi = 96; // C1 a C7
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = c.getBoundingClientRect();
      if (!r.width) return;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawKeyboard(ctx, keyboardLayout(lo, hi, r.width, r.height), new Set([root]), root, null);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [root, themeRev]);
  const pick = (e: PointerEvent) => {
    const c = e.currentTarget as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    const k = keyAt(keyboardLayout(lo, hi, r.width, r.height), e.clientX - r.left, e.clientY - r.top);
    if (k === null) return;
    edit([set(['channels', p.ch.id, 'pitch'], 60 - k)]);
    // toca a nota raiz para ouvir a altura original
    audio.liveOn(p.ch.id, k, 0.8, 96);
  };
  return <canvas ref={ref} class="root-keys" onPointerDown={pick as any} data-hint="Clique na tecla que deve tocar o instrumento na altura original (a nota raiz)" />;
}

export function GearTab(p: { ch: Channel }) {
  const ch = p.ch;
  const root = 60 - ch.pitch;
  const fine = ch.fine ?? 0;
  const sampler = ch.type === 'sampler';
  const mode = ch.pitchMode ?? 'stretch';
  const path = ['channels', ch.id];
  const setParam = (k: string, v: unknown) => edit([set([...path, 'params', k], v)]);
  const bool = (k: string) => ch.params[k] === true;
  return (
    <div class="gear">
      <section class="gear-card">
        <h4>Nota raiz</h4>
        <RootPicker ch={ch} />
        <div class="gear-row">
          <span>
            Tocar <b>{noteName(root)}</b> dá a altura original
            {ch.pitch !== 0 && (
              <span class="dim">
                {' '}
                · transposição de {ch.pitch > 0 ? '+' : ''}
                {ch.pitch} semitons
              </span>
            )}
          </span>
          <button disabled={ch.pitch === 0} onClick={() => edit([set([...path, 'pitch'], 0)])} data-hint="Voltar a nota raiz para C4">
            C4
          </button>
          <button onClick={() => edit([set([...path, 'pitch'], ch.pitch + 12)])} data-hint="Uma oitava acima">
            +oit.
          </button>
          <button onClick={() => edit([set([...path, 'pitch'], ch.pitch - 12)])} data-hint="Uma oitava abaixo">
            −oit.
          </button>
        </div>
        <div class="dim small">
          {sampler
            ? 'Em instrumentos com vários samples, a troca de sample acompanha a transposição (cada tecla usa o sample gravado mais próximo).'
            : 'A transposição muda as notas enviadas ao instrumento.'}
        </div>
      </section>
      <section class="gear-card">
        <h4>Ajuste fino</h4>
        <div class="fine">
          <span class="fine-end">−1 st</span>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={fine}
            data-hint="Ajuste fino entre meio tom abaixo e meio tom acima (duplo clique ou botão do meio zera)"
            onInput={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              previewEdit([set([...path, 'fine'], v)]);
              setHint(`Ajuste fino: ${v > 0 ? '+' : ''}${v} cents`);
            }}
            onChange={(e) => edit([set([...path, 'fine'], Number((e.target as HTMLInputElement).value))])}
            onDblClick={() => edit([set([...path, 'fine'], 0)])}
            onPointerDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                edit([set([...path, 'fine'], 0)]);
              }
            }}
          />
          <span class="fine-end">+1 st</span>
          <span class="lcd fine-val">
            {fine > 0 ? '+' : ''}
            {fine} ct
          </span>
        </div>
        {sampler ? (
          <div class="gear-row">
            <label class="radio" data-hint="Muda o tom sem mudar a duração nem o andamento do áudio">
              <input type="radio" checked={mode === 'stretch'} onChange={() => edit([set([...path, 'pitchMode'], 'stretch')])} />
              Preservar andamento
            </label>
            <label class="radio" data-hint="Reamostragem clássica: o tom e a duração mudam juntos (sem artefatos)">
              <input type="radio" checked={mode === 'resample'} onChange={() => edit([set([...path, 'pitchMode'], 'resample')])} />
              Reamostrar
            </label>
          </div>
        ) : (
          <div class="dim small">Nos sintetizadores o ajuste fino afina os osciladores direto, sem alterar o tempo.</div>
        )}
      </section>
      {sampler && (
        <section class="gear-card">
          <h4>Reprodução do áudio</h4>
          <div class="gear-checks">
            <label data-hint="Toca o áudio de trás para frente">
              <input type="checkbox" checked={bool('reverse')} onChange={() => setParam('reverse', !bool('reverse'))} />
              Reverso
            </label>
            <label data-hint="Toca o arquivo inteiro ao apertar, ignorando soltar a tecla (bateria)">
              <input type="checkbox" checked={bool('oneshot')} onChange={() => setParam('oneshot', !bool('oneshot'))} />
              One-shot
            </label>
            <label data-hint="Repete o trecho de sustentação enquanto a tecla estiver pressionada">
              <input type="checkbox" checked={bool('loop')} onChange={() => setParam('loop', !bool('loop'))} />
              Loop de sustentação
            </label>
            <label data-hint="A altura acompanha a tecla tocada (desligado: toda tecla toca igual)">
              <input type="checkbox" checked={bool('keytrack')} onChange={() => setParam('keytrack', !bool('keytrack'))} />
              Seguir tecla
            </label>
          </div>
        </section>
      )}
    </div>
  );
}
