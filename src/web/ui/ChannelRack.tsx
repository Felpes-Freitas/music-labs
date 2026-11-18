import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, act, previewEdit, selectChannel, selectPattern, openWindow, onLive, toast } from '../state';
import { audio } from '../audio';
import * as A from '../../core/actions';
import { PRESETS, INSTRUMENTS } from '../../core/registry';
import { STEP, patternLength, uid, type Channel, type Note, type InstrumentType } from '../../core/model';
import { set } from '../../core/ops';
import { Knob, Win, dbFmt, panFmt, ContextMenu } from './widgets';
import { Icon } from './icons';
import { askConfirm, askText } from './Dialog';

const CELL = 21;

/** Canal "de steps" = só notas de 1 step na mesma tecla; senão mostra mini piano roll. */
function isStepLike(notes: Note[]) {
  if (!notes.length) return true;
  const k = notes[0].key;
  return notes.every((n) => n.key === k && n.len <= STEP && n.pos % STEP === 0);
}

export function ChannelRack() {
  const s = useApp();
  const p = s.project;
  const pat = p.patterns.find((x) => x.id === s.patternId);
  const steps = pat ? Math.max(16, Math.round(patternLength(p, pat) / STEP)) : 16;
  const [menu, setMenu] = useState<{ x: number; y: number; ch?: Channel } | null>(null);
  const [adding, setAdding] = useState(false);
  const lastStep = useRef(-1);
  const flashes = useRef(new Map<string, HTMLElement>());

  useEffect(
    () =>
      onLive((st) => {
        const show = st.playing && st.mode === 'pattern' && st.patternId === state.patternId;
        const idx = show ? Math.floor(st.tick / STEP) : -1;
        if (idx !== lastStep.current) {
          document.querySelectorAll('.step.play').forEach((e) => e.classList.remove('play'));
          if (idx >= 0) document.querySelectorAll(`.step[data-i="${idx}"]`).forEach((e) => e.classList.add('play'));
          lastStep.current = idx;
        }
        for (const id of st.activeChannels) {
          const e = flashes.current.get(id);
          if (e) {
            e.classList.remove('flash');
            void e.offsetWidth;
            e.classList.add('flash');
          }
        }
      }),
    [],
  );

  const toggleStep = (ch: Channel, i: number, force?: boolean) => {
    if (!pat) return;
    const list = pat.notes[ch.id] ?? [];
    const at = list.filter((n) => n.pos === i * STEP);
    const on = at.length > 0;
    const want = force ?? !on;
    if (want === on) return;
    const key = list[0]?.key ?? 60;
    const next = want ? [...list, { id: uid('n'), key, pos: i * STEP, len: STEP, vel: 0.78 }] : list.filter((n) => n.pos !== i * STEP);
    edit([set(['patterns', pat.id, 'notes', ch.id], next)]);
    if (want) audio.liveOn(ch.id, key, 0.78, STEP);
  };

  const paint = (ch: Channel, i: number, e: PointerEvent) => {
    e.preventDefault();
    const list = pat?.notes[ch.id] ?? [];
    const on = list.some((n) => n.pos === i * STEP);
    const value = e.button === 2 ? false : !on;
    toggleStep(ch, i, value);
    const row = (e.currentTarget as HTMLElement).parentElement!;
    const move = (ev: PointerEvent) => {
      const r = row.getBoundingClientRect();
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const di = el?.closest('.step')?.getAttribute('data-i');
      const j = di != null && el!.closest('.steps')?.parentElement === row.parentElement ? Number(di) : Math.floor((ev.clientX - r.left) / (CELL + 0.75));
      if (j >= 0 && j < steps) toggleStep(ch, j, value);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addChannel = (preset?: string, type?: InstrumentType) => {
    const r = act(A.addChannel, preset ? { preset } : { type });
    if (r) {
      selectChannel(r.id);
      toast(`Canal ${r.name} → insert ${r.insert}`);
    }
    setAdding(false);
  };

  return (
    <Win
      id="rack"
      icon="rack"
      title={
        <>
          Rack de canais <span class="dim">· {pat?.name ?? ''}</span>
        </>
      }
      tools={
        <span class="pr-tools nodrag">
          <span class="tgroup" data-hint="Pattern editado no rack">
            <select value={s.patternId ?? ''} onChange={(e) => selectPattern((e.target as HTMLSelectElement).value)}>
              {p.patterns.map((pt) => (
                <option value={pt.id}>{pt.name}</option>
              ))}
            </select>
          </span>
          <span class="tgroup">
            <span class="hint">{steps} steps</span>
            <button data-hint="Aumentar o pattern em 16 steps (1 compasso)" onClick={() => pat && edit([set(['patterns', pat.id, 'length'], steps + 16)])}>
              +16
            </button>
            <button data-hint="Diminuir o pattern em 16 steps" disabled={steps <= 16} onClick={() => pat && edit([set(['patterns', pat.id, 'length'], Math.max(16, steps - 16))])}>
              −16
            </button>
            <button data-hint="Comprimento automático (arredonda pelas notas)" onClick={() => pat && edit([set(['patterns', pat.id, 'length'], 0)])}>
              auto
            </button>
          </span>
        </span>
      }
    >
      <div class="rack" onContextMenu={(e) => e.preventDefault()}>
        <div class="rack-rows">
          {p.channels.map((ch) => {
            const notes = pat?.notes[ch.id] ?? [];
            const stepLike = isStepLike(notes);
            return (
              <div class={`rack-row ${s.channelId === ch.id ? 'sel' : ''}`} key={ch.id}>
                <button
                  class={`led ${ch.mute ? '' : 'on'}`}
                  data-hint="Mute (clique) / solo (clique direito)"
                  onClick={() => edit([set(['channels', ch.id, 'mute'], !ch.mute)])}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const solo = p.channels.every((c) => c.id === ch.id || c.mute) && !ch.mute;
                    edit(p.channels.map((c) => set(['channels', c.id, 'mute'], solo ? false : c.id !== ch.id)));
                  }}
                />
                <Knob size={22} value={ch.pan} min={-1} max={1} def={0} bipolar format={panFmt} auto={{ path: ['channels', ch.id, 'pan'], label: `${ch.name} · pan` }} onInput={(v) => previewEdit([set(['channels', ch.id, 'pan'], v)])} onCommit={(v) => edit([set(['channels', ch.id, 'pan'], v)])} title={`Pan ${panFmt(ch.pan)}`} />
                <Knob size={22} value={ch.volume} min={0} max={1.25} def={0.78} format={dbFmt} auto={{ path: ['channels', ch.id, 'volume'], label: `${ch.name} · volume` }} onInput={(v) => previewEdit([set(['channels', ch.id, 'volume'], v)])} onCommit={(v) => edit([set(['channels', ch.id, 'volume'], v)])} title={`Volume ${dbFmt(ch.volume)}`} />
                <input
                  class="ins-num"
                  type="number"
                  min={0}
                  max={p.mixer.length - 1}
                  value={ch.insert}
                  data-hint="Insert do mixer para onde o canal vai"
                  onChange={(e) => edit([set(['channels', ch.id, 'insert'], Math.max(0, Math.min(p.mixer.length - 1, Number((e.target as HTMLInputElement).value))))])}
                />
                <button
                  class="ch-name"
                  ref={(el) => {
                    if (el) flashes.current.set(ch.id, el);
                  }}
                  style={{ borderLeftColor: ch.color }}
                  data-hint={`${INSTRUMENTS[ch.type].label} · clique: selecionar · duplo clique: configurações · direito: menu`}
                  onClick={() => selectChannel(ch.id)}
                  onDblClick={() => {
                    selectChannel(ch.id);
                    openWindow('channel');
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    selectChannel(ch.id);
                    setMenu({ x: e.clientX, y: e.clientY, ch });
                  }}
                >
                  {ch.name}
                </button>
                {stepLike ? (
                  <div class="steps" style={{ width: `${steps * CELL + Math.floor(steps / 4) * 3}px` }}>
                    {Array.from({ length: steps }, (_, i) => {
                      const on = notes.some((n) => n.pos === i * STEP);
                      return <div data-i={i} class={`step ${on ? 'on' : ''} ${Math.floor(i / 4) % 2 ? 'alt' : ''} ${i % 4 === 3 ? 'g4' : ''}`} onPointerDown={(e) => paint(ch, i, e as any)} />;
                    })}
                  </div>
                ) : (
                  <MiniRoll notes={notes} steps={steps} color={ch.color} onOpen={() => { selectChannel(ch.id); openWindow('piano'); }} />
                )}
              </div>
            );
          })}
        </div>
        <div class="rack-foot">
          <button class="ibtn" data-hint="Adicionar canal (instrumento, preset ou sample)" onClick={() => setAdding(!adding)}>
            <Icon name="plus" size={12} /> Canal
          </button>
          <span class="hint">Arraste samples do navegador para cá · duplo clique no nome abre o canal</span>
          {adding && (
            <div class="add-menu">
              <div class="add-col">
                <b>Presets</b>
                {Object.entries(PRESETS).map(([k, v]) => (
                  <button title={v.description} onClick={() => addChannel(k)}>
                    {k}
                  </button>
                ))}
              </div>
              <div class="add-col">
                <b>Instrumentos</b>
                {(Object.keys(INSTRUMENTS) as InstrumentType[]).map((t) => (
                  <button title={INSTRUMENTS[t].description} onClick={() => addChannel(undefined, t)}>
                    {INSTRUMENTS[t].label}
                  </button>
                ))}
                <p class="hint">Samples: arraste do navegador para o rack.</p>
              </div>
            </div>
          )}
        </div>
      </div>
      {menu?.ch && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ['Piano roll', () => openWindow('piano')],
            ['Configurações', () => openWindow('channel')],
            [
              'Renomear',
              async () => {
                const n = await askText({ title: 'Renomear canal', label: 'Nome', value: menu.ch!.name, ok: 'Renomear' });
                if (n) edit([set(['channels', menu.ch!.id, 'name'], n)]);
              },
            ],
            [
              'Clonar',
              () => {
                const c = menu.ch!;
                const r = act(A.addChannel, { name: `${c.name} 2`, type: c.type, insert: c.insert });
                if (r) edit([set(['channels', r.id, 'params'], c.params)]);
              },
            ],
            ['Limpar notas neste pattern', () => s.patternId && act(A.clearNotes, { pattern: s.patternId, channel: menu.ch!.id })],
            ['Excluir', async () => (await askConfirm({ title: `Excluir ${menu.ch!.name}?`, message: 'O canal e as notas dele em todos os patterns serão removidos.', ok: 'Excluir', danger: true })) && act(A.removeChannel, { channel: menu.ch!.id })],
          ]}
        />
      )}
    </Win>
  );
}

function MiniRoll(p: { notes: Note[]; steps: number; color: string; onOpen: () => void }) {
  const lo = Math.min(...p.notes.map((n) => n.key));
  const hi = Math.max(...p.notes.map((n) => n.key));
  const span = Math.max(1, hi - lo + 1);
  const w = p.steps * CELL;
  return (
    <div class="miniroll" style={{ width: `${w}px` }} onDblClick={p.onOpen} onClick={p.onOpen} title="Abrir no piano roll">
      {p.notes.map((n) => (
        <div
          class="mini-note"
          style={{
            left: `${(n.pos / STEP) * CELL}px`,
            width: `${Math.max(2, (n.len / STEP) * CELL - 1)}px`,
            top: `${((hi - n.key) / span) * 80 + 6}%`,
            background: p.color,
          }}
        />
      ))}
    </div>
  );
}

