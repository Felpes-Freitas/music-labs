import { PAD_BASE } from '../../core/pads';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, state, edit, act, previewEdit, selectChannel, selectPattern, openWindow, onLive, toast } from '../state';
import { audio } from '../audio';
import * as A from '../../core/actions';
import { PRESETS, INSTRUMENTS } from '../../core/registry';
import { STEP, patternLength, uid, type Channel, type Note, type InstrumentType } from '../../core/model';
import { set } from '../../core/ops';
import { Knob, Win, dbFmt, panFmt, MenuTree, type MenuItem } from './widgets';
import * as S from '../../core/studio';
import { instrumentMenu, loadLib, libNow, type Lib } from '../addmenu';
import { addSampleChannel, samplerParams } from './Browser';
import { Icon } from './icons';
import { askConfirm, askText } from './Dialog';
import { channelInPattern } from '../../core/audiochan';
import { usePref } from '../prefs';
import { openTuneAudio } from './Tune';
import { addStitchAudios } from './Stitch';
import { addToPool } from '../pool';
import { openAmpReamp } from '../reamp';

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
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [lib, setLib] = useState<Lib | null>(libNow());
  useEffect(() => {
    if ((adding || menu) && !lib) loadLib().then(setLib);
  }, [adding, menu]);
  const lastStep = useRef(-1);
  const flashes = useRef(new Map<string, HTMLElement>());
  const [only, setOnly] = usePref('rack.onlyPattern', false);
  // canal "solto" (sem notas e sem grupo em nenhum pattern, ex.: recém-criado) aparece em todos
  const loose = (id: string) => !p.patterns.some((pt) => channelInPattern(pt, id));
  const visible = only && pat ? p.channels.filter((c) => channelInPattern(pat, c.id) || loose(c.id)) : p.channels;

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
    // Soundpad: o step padrão toca o pad 1 (C2); os outros instrumentos, C4
    const key = list[0]?.key ?? (ch.type === 'pads' ? PAD_BASE : 60);
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

  /** Menu do botão direito num canal: preencher, substituir instrumento, clonar... */
  const channelMenu = (c: Channel): MenuItem[] => {
    const fill = (every: number, offset = 0) => () => s.patternId && act(S.fillSteps, { pattern: s.patternId, channel: c.id, every, offset });
    const replace = (args: { type?: InstrumentType; preset?: string; params?: Record<string, unknown>; name: string }) => {
      const r = act(S.replaceInstrument, { channel: c.id, ...args });
      if (r) toast(`${c.name} → ${args.name}: as notas continuam${r.root ? ` (raiz ${r.root})` : ''}`);
    };
    const send: MenuItem = {
      label: 'Enviar para pattern',
      hint: 'Move as notas deste canal para outro pattern (e o canal passa a aparecer nele com o filtro)',
      sub: [
        ...p.patterns
          .filter((x) => x.id !== s.patternId)
          .map((x) => ({ label: x.name, run: () => s.patternId && act(S.moveChannelToPattern, { channel: c.id, from: s.patternId, to: x.id }) && toast(`${c.name} → ${x.name}`) })),
        { sep: true, label: '' },
        {
          label: 'Pattern novo…',
          run: async () => {
            const n = await askText({ title: 'Pattern novo', label: 'Nome', value: c.name, ok: 'Criar' });
            if (!n || !s.patternId) return;
            const r = act(S.moveChannelToPattern, { channel: c.id, from: s.patternId, newName: n });
            if (r) toast(`${c.name} → ${r.name}`);
          },
        },
      ],
    };
    if (c.type === 'audio') {
      const item = () => (p.audios ?? []).find((a) => a.channel === c.id)?.id ?? addToPool(String(c.params.sample), c.name);
      return [
        ...(c.amp ? [{ label: 'Amp (mudar os pedais)', hint: 'Refaz a gravação a partir do áudio bruto', run: () => openAmpReamp(c.id) }] : []),
        { label: 'Configurações (volume, efeitos…)', run: () => openWindow('channel') },
        { label: 'Abrir no Melodify', hint: 'Editar as notas do áudio (afinação)', run: () => openTuneAudio(item()) },
        { label: 'Abrir no Stitcher', hint: 'Juntar takes deste áudio', run: () => (addStitchAudios([item()]), openWindow('stitch')) },
        {
          label: 'Renomear',
          run: async () => {
            const n = await askText({ title: 'Renomear áudio', label: 'Nome', value: c.name, ok: 'Renomear' });
            if (n) edit([set(['channels', c.id, 'name'], n)]);
          },
        },
        { sep: true, label: '' },
        send,
        { sep: true, label: '' },
        {
          label: 'Excluir',
          run: async () =>
            (await askConfirm({ title: `Excluir ${c.name}?`, message: 'O canal, os clipes deste áudio na playlist e o item da lista de áudios serão removidos.', ok: 'Excluir', danger: true })) && act(A.removeChannel, { channel: c.id }),
        },
      ];
    }
    return [
      { label: 'Piano roll', run: () => openWindow('piano') },
      { label: 'Configurações', run: () => openWindow('channel') },
      {
        label: 'Renomear',
        run: async () => {
          const n = await askText({ title: 'Renomear canal', label: 'Nome', value: c.name, ok: 'Renomear' });
          if (n) edit([set(['channels', c.id, 'name'], n)]);
        },
      },
      { sep: true, label: '' },
      {
        label: 'Preencher',
        hint: 'Liga os steps deste canal no pattern atual a cada intervalo (substitui o que tinha)',
        sub: [
          { label: 'Cada step (1/16)', run: fill(1) },
          { label: 'A cada 2 steps (1/8)', run: fill(2) },
          { label: 'A cada 3 steps', run: fill(3) },
          { label: 'A cada 4 steps (1 tempo)', run: fill(4) },
          { label: 'A cada 8 steps (2 tempos)', run: fill(8) },
          { label: 'A cada 16 steps (1 compasso)', run: fill(16) },
          { sep: true, label: '' },
          { label: 'Contratempo (entre os tempos)', run: fill(4, 2) },
          { label: 'Tempos 2 e 4', run: fill(8, 4) },
          { sep: true, label: '' },
          { label: 'Limpar', run: () => s.patternId && act(A.clearNotes, { pattern: s.patternId, channel: c.id }) },
        ],
      },
      {
        label: 'Substituir instrumento',
        hint: 'Troca o som mantendo as notas, os efeitos, o insert e o volume',
        sub: instrumentMenu(lib, {
          native: (t) => replace({ type: t, name: INSTRUMENTS[t].label }),
          preset: (k) => replace({ preset: k, name: k }),
          sample: async (path, name) => {
            try {
              const { params } = await samplerParams(path);
              audio.loadSample(String(params.sample));
              replace({ type: 'sampler', params, name });
            } catch (e) {
              toast(`Erro: ${(e as Error).message}`);
            }
          },
        }),
      },
      send,
      { label: 'Clonar', hint: 'Canal igual (instrumento, efeitos e notas) logo abaixo', run: () => act(S.duplicateChannel, { channel: c.id, name: `${c.name} 2`, copyNotes: true }) },
      { sep: true, label: '' },
      { label: 'Limpar notas neste pattern', run: () => s.patternId && act(A.clearNotes, { pattern: s.patternId, channel: c.id }) },
      {
        label: 'Excluir',
        run: async () => (await askConfirm({ title: `Excluir ${c.name}?`, message: 'O canal e as notas dele em todos os patterns serão removidos.', ok: 'Excluir', danger: true })) && act(A.removeChannel, { channel: c.id }),
      },
    ];
  };

  const addChannel = (preset?: string, type?: InstrumentType) => {
    const r = act(A.addChannel, preset ? { preset } : { type });
    if (r) {
      selectChannel(r.id);
      toast(`Canal ${r.name} → insert ${r.insert}`);
    }
    setAdding(null);
  };

  return (
    <Win
      id="rack"
      icon="rack"
      title={
        <>
          Rack de canais <span class="dim">·</span>{' '}
          {pat && (
            <input
              class="title-edit nodrag"
              key={pat.id}
              value={pat.name}
              size={Math.max(3, pat.name.length)}
              spellcheck={false}
              data-hint="Nome do pattern: clique para renomear"
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                el.size = Math.max(3, el.value.length);
              }}
              onKeyDown={(e) => {
                const el = e.target as HTMLInputElement;
                if (e.key === 'Enter') el.blur();
                if (e.key === 'Escape') {
                  el.value = pat.name;
                  el.blur();
                }
                e.stopPropagation(); // as teclas não tocam o instrumento enquanto digita
              }}
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v && v !== pat.name) act(A.updatePattern, { pattern: pat.id, name: v });
                else (e.target as HTMLInputElement).value = pat.name;
              }}
            />
          )}
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
            <button class={`rack-eye ${only ? 'on' : ''}`} data-hint={only ? 'Mostrando só os canais deste pattern (e os novos, ainda sem notas) · clique para ver todos' : 'Mostrar só os canais deste pattern'} onClick={() => setOnly(!only)}>
              <Icon name="eye" size={14} />
            </button>
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
          {only && !visible.length && <div class="hint rack-empty">Nenhum canal neste pattern · desligue o filtro "só deste pattern" para ver todos</div>}
          {visible.map((ch) => {
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
                {ch.type === 'audio' ? (
                  <AudioStrip ch={ch} width={steps * CELL + Math.floor(steps / 4) * 3} onOpen={() => (selectChannel(ch.id), openWindow('channel'))} />
                ) : stepLike ? (
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
          <button class="ibtn" data-hint="Adicionar canal: instrumentos do Music Labs, presets ou instrumentos de outros programas (FL Studio...)" onClick={(e) => setAdding(adding ? null : (e.currentTarget as HTMLElement))}>
            <Icon name="plus" size={12} /> Canal
          </button>
          <span class="hint">Arraste samples do navegador para cá · duplo clique no nome abre o canal</span>
          {adding && (
            <MenuTree
              x={adding.getBoundingClientRect().left}
              y={adding.getBoundingClientRect().bottom + 2}
              onClose={() => setAdding(null)}
              items={instrumentMenu(lib, {
                native: (t) => addChannel(undefined, t),
                preset: (k) => addChannel(k),
                sample: (path, name) => {
                  setAdding(null);
                  void addSampleChannel(path, name);
                },
              })}
            />
          )}
        </div>
      </div>
      {menu?.ch && (
        <MenuTree
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={channelMenu(menu.ch)}
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


/** Linha de um canal de áudio no rack: a onda do arquivo e quantos clipes ele tem. */
function AudioStrip(p: { ch: Channel; width: number; onOpen: () => void }) {
  const s = state;
  const n = s.project.clips.filter((c) => c.kind === 'audio' && c.channel === p.ch.id).length;
  return (
    <div class="audio-strip" style={{ width: `${p.width}px`, '--c': p.ch.color } as any} onDblClick={p.onOpen} data-hint="Canal de áudio: o som vem dos clipes na playlist · duplo clique: volume, efeitos e o áudio">
      <span class="audio-strip-wave" />
      <span class="audio-strip-label">
        ♪ {n ? `${n} clipe${n > 1 ? 's' : ''} na playlist` : 'fora da playlist'}
      </span>
    </div>
  );
}
