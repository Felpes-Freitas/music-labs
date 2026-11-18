import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, previewEdit, onLive, act, emit } from '../state';
import { EFFECTS } from '../../core/registry';
import type { EffectType, Insert } from '../../core/model';
import { set } from '../../core/ops';
import * as A from '../../core/actions';
import { Knob, Win, dbFmt, panFmt } from './widgets';
import { ParamGrid } from './ParamGrid';
import { askText } from './Dialog';

function Fader(p: { value: number; onInput: (v: number) => void; onCommit: (v: number) => void }) {
  // curva: posição 0..1 -> ganho com 0 dB em ~0.8 e +4.4 dB no topo
  const toPos = (g: number) => Math.pow(g / 1.66, 1 / 3);
  const toGain = (x: number) => 1.66 * x * x * x;
  const pos = Math.max(0, Math.min(1, toPos(p.value)));
  const onDown = (e: PointerEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      p.onCommit(0.8);
      return;
    }
    const track = (e.currentTarget as HTMLElement).getBoundingClientRect();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    let last = p.value;
    const at = (ev: PointerEvent) => {
      const x = 1 - (ev.clientY - track.top) / track.height;
      last = toGain(Math.max(0, Math.min(1, x)));
      p.onInput(last);
    };
    at(e);
    const el = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      p.onCommit(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div class="fader" onPointerDown={onDown as any} onDblClick={() => p.onCommit(0.8)} title={dbFmt(p.value)}>
      <div class="fader-line" />
      {[1.25, 0.8, 0.4, 0.2, 0.1, 0.05].map((g) => (
        <div class="fader-tick" style={{ bottom: `calc(${toPos(g) * 100}% )` }} />
      ))}
      <div class="fader-zero" style={{ bottom: `${toPos(0.8) * 100}%` }} />
      <div class="fader-cap" style={{ bottom: `calc(${pos * 100}% - 6px)` }} />
    </div>
  );
}

export function Mixer() {
  const s = useApp();
  const p = s.project;
  const meters = useRef<(HTMLCanvasElement | null)[]>([]);
  const grs = useRef<(HTMLElement | null)[]>([]);
  const [fxSel, setFxSel] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const hold: number[][] = [];
    return onLive((st) => {
      st.meters.forEach((m, i) => {
        const c = meters.current[i];
        if (!c) return;
        const hv = (hold[i] ??= [0, 0]);
        hv[0] = Math.max(m[0], hv[0] * 0.86);
        hv[1] = Math.max(m[1], hv[1] * 0.86);
        const ctx = c.getContext('2d')!;
        const w = c.width, h = c.height;
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, w, h);
        for (let k = 0; k < 2; k++) {
          const db = 20 * Math.log10(Math.max(hv[k], 1e-5));
          const y = Math.max(0, Math.min(1, (db + 54) / 60)) * h;
          const grad = ctx.createLinearGradient(0, h, 0, 0);
          grad.addColorStop(0, '#2f9e4f');
          grad.addColorStop(0.75, '#c8d040');
          grad.addColorStop(0.92, '#ff4d4d');
          ctx.fillStyle = grad;
          ctx.fillRect(k * (w / 2) + 1, h - y, w / 2 - 2, y);
        }
        const g = grs.current[i];
        if (g) g.textContent = st.gr[i] > 0.3 ? `-${st.gr[i].toFixed(1)}` : '';
      });
    });
  }, []);

  const visible = p.mixer
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => showAll || i === 0 || i <= 16 || p.channels.some((c) => c.insert === i) || m.effects.length || !/^Insert \d+$/.test(m.name));
  const cur = p.mixer[s.insert] ?? p.mixer[0];
  const curFx = cur.effects.find((e) => e.id === fxSel) ?? cur.effects[0];

  const setIns = (i: number, key: keyof Insert, v: unknown) => edit([set(['mixer', i, key], v)]);

  return (
    <Win
      id="mixer"
      icon="mixer"
      title={
        <>
          Mixer <span class="dim">· {cur.name}</span>
        </>
      }
      minW={500}
      minH={320}
      tools={
        <button class={showAll ? 'on' : ''} onClick={() => setShowAll(!showAll)} title="Mostrar todos os inserts">
          todos
        </button>
      }
    >
      <div class="mixer">
        <div class="strips">
          {visible.map(({ m, i }) => {
            const chans = p.channels.filter((c) => c.insert === i);
            return (
              <div
                class={`strip ${s.insert === i ? 'sel' : ''} ${i === 0 ? 'master' : ''}`}
                key={m.id}
                onPointerDown={() => {
                  if (state.insert !== i) {
                    state.insert = i;
                    setFxSel(null);
                    emit();
                  }
                }}
              >
                <div class="strip-num">{i === 0 ? 'M' : i}</div>
                <div
                  class="strip-name"
                  style={{ borderTopColor: m.color }}
                  title={`${m.name}${chans.length ? '\nCanais: ' + chans.map((c) => c.name).join(', ') : ''}\nDuplo clique: renomear`}
                  onDblClick={async () => {
                    const n = await askText({ title: 'Renomear insert', label: 'Nome', value: m.name, ok: 'Renomear' });
                    if (n) setIns(i, 'name', n);
                  }}
                >
                  {m.name}
                </div>
                <div class="strip-fx">{m.effects.length ? `${m.effects.length} fx` : ''}</div>
                <Knob size={24} value={m.pan} min={-1} max={1} def={0} bipolar format={panFmt} auto={{ path: ['mixer', i, 'pan'], label: `${m.name} · pan` }} onInput={(v) => previewEdit([set(['mixer', i, 'pan'], v)])} onCommit={(v) => setIns(i, 'pan', v)} />
                <div class="strip-mid">
                  <canvas ref={(el) => void (meters.current[i] = el)} width={12} height={150} class="meter" />
                  <Fader value={m.volume} onInput={(v) => previewEdit([set(['mixer', i, 'volume'], v)])} onCommit={(v) => setIns(i, 'volume', v)} />
                </div>
                <div class="strip-db">{dbFmt(m.volume).replace(' dB', '')}</div>
                <span class="gr" ref={(el) => void (grs.current[i] = el)} title="Redução de ganho (compressor/limiter)" />
                <div class="strip-btns">
                  <button class={`mute ${m.mute ? 'on' : ''}`} title="Mute" onClick={() => setIns(i, 'mute', !m.mute)}>
                    M
                  </button>
                  {i > 0 && (
                    <button class={`solo ${m.solo ? 'on' : ''}`} title="Solo" onClick={() => setIns(i, 'solo', !m.solo)}>
                      S
                    </button>
                  )}
                </div>
                {i > 0 && (
                  <select class="route" value={m.output} title="Saída" onChange={(e) => setIns(i, 'output', Number((e.target as HTMLSelectElement).value))}>
                    {p.mixer.map((x, j) =>
                      j === i ? null : (
                        <option value={j}>
                          → {j === 0 ? 'Master' : `${j} ${x.name}`}
                        </option>
                      ),
                    )}
                  </select>
                )}
              </div>
            );
          })}
        </div>
        <div class="fxpanel">
          <div class="fx-head">
            <b>
              {s.insert === 0 ? 'Master' : `Insert ${s.insert}`} · {cur.name}
            </b>
            <span class="hint">{cur.effects.length}/10 efeitos</span>
          </div>
          <div class="slots">
            {Array.from({ length: 10 }, (_, k) => {
              const e = cur.effects[k];
              if (!e)
                return (
                  <div class="slot empty">
                    <span class="slot-n">{k + 1}</span>
                    <select
                      value=""
                      data-hint="Slot vazio: escolha um efeito"
                      onChange={(ev) => {
                        const t = (ev.target as HTMLSelectElement).value as EffectType;
                        (ev.target as HTMLSelectElement).value = '';
                        if (!t) return;
                        const r = act(A.addEffect, { insert: s.insert, type: t });
                        if (r) setFxSel(r.id);
                      }}
                    >
                      <option value="">(vazio)</option>
                      {(Object.keys(EFFECTS) as EffectType[]).map((t) => (
                        <option value={t}>{EFFECTS[t].label}</option>
                      ))}
                    </select>
                  </div>
                );
              return (
                <div class={`slot ${curFx?.id === e.id ? 'sel' : ''}`} onClick={() => setFxSel(e.id)}>
                  <span class="slot-n">{k + 1}</span>
                  <button
                    class={`led ${e.enabled ? 'on' : ''}`}
                    data-hint="Ligar/desligar efeito"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      edit([set(['mixer', s.insert, 'effects', e.id, 'enabled'], !e.enabled)]);
                    }}
                  />
                  <span class="slot-name">{EFFECTS[e.type].label}</span>
                  <Knob size={18} value={e.mix} min={0} max={1} def={1} format={(v) => `mix ${Math.round(v * 100)}%`} title="Dry/wet" onInput={(v) => previewEdit([set(['mixer', s.insert, 'effects', e.id, 'mix'], v)])} onCommit={(v) => edit([set(['mixer', s.insert, 'effects', e.id, 'mix'], v)])} />
                  <button
                    data-hint="Subir na cadeia"
                    disabled={k === 0}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      const list = [...cur.effects];
                      [list[k - 1], list[k]] = [list[k], list[k - 1]];
                      edit([set(['mixer', s.insert, 'effects'], list)]);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    data-hint="Remover efeito"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      act(A.removeEffect, { insert: s.insert, effect: e.id });
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          {curFx && (
            <div class="fx-params">
              <div class="hint">{EFFECTS[curFx.type].description}</div>
              <ParamGrid
                defs={EFFECTS[curFx.type].params}
                values={curFx.params}
                auto={{ prefix: ['mixer', s.insert, 'effects', curFx.id, 'params'], label: `${p.mixer[s.insert]?.name ?? 'Insert'} · ${EFFECTS[curFx.type].label}` }}
                onInput={(k, v) => previewEdit([set(['mixer', s.insert, 'effects', curFx.id, 'params', k], v)])}
                onCommit={(k, v) => edit([set(['mixer', s.insert, 'effects', curFx.id, 'params', k], v)])}
                mixerSize={p.mixer.length}
              />
            </div>
          )}
        </div>
      </div>
    </Win>
  );
}
