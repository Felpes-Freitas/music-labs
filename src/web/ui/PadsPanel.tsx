// Soundpad na janela do canal: grade 4×4 de pads coloridos por linha. Clique (ou a tecla
// do computador: 1234/QWER/ASDF/ZXCV) toca; botão direito escolhe o som do pad (mesmo menu
// do "+ Canal": samples, instrumentos do FL, nativos, presets), renomeia ou limpa; arrastar
// um áudio do navegador para um pad também troca o som. Ganho e afinação do pad
// selecionado embaixo; "Kits" troca a grade inteira.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Channel } from '../../core/model';
import { noteName } from '../../core/model';
import { set } from '../../core/ops';
import { INSTRUMENTS, presetParams } from '../../core/registry';
import { PAD_COUNT, PAD_KITS, padColor, padIndex, padKey, padNote, parsePads, stringifyPads, type PadSlot } from '../../core/pads';
import { edit, previewEdit, onLive, toast } from '../state';
import { audio } from '../audio';
import { Knob, MenuTree, type MenuItem } from './widgets';
import { askText } from './Dialog';
import { instrumentMenu, loadLib, libNow, type Lib } from '../addmenu';
import { samplerParams } from './Browser';
import { rgbFlash } from '../rgb';

/** Pads acesos agora (tecla do computador, clique ou música tocando). */
const hits = new Set<(ch: string, i: number) => void>();
export function padHit(ch: string, i: number) {
  for (const f of hits) f(ch, i);
}
/** Pad clicado ou tocado pela música: acende a tecla dele no teclado RGB. */
function padFlash(i: number) {
  rgbFlash(padKey(i));
}

/** Pad com um arquivo de áudio: o sample toca na altura original. */
export async function padFromSample(path: string, name: string): Promise<PadSlot> {
  const { params } = await samplerParams(path);
  const { sample, ...rest } = params;
  void sample;
  audio.loadSample(path);
  return { name, sample: path, params: rest as PadSlot['params'], note: Number(params.root ?? 60) };
}

export function PadsPanel({ ch }: { ch: Channel }) {
  const pads = parsePads(ch.params.pads);
  const [sel, setSel] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [lib, setLib] = useState<Lib | null>(libNow());
  const [lit, setLit] = useState<Set<number>>(new Set());
  const flash = useRef(new Map<number, number>());

  useEffect(() => {
    if (!lib) loadLib().then(setLib);
  }, []);
  // acende o pad tocado (teclado, clique) por um instante
  useEffect(() => {
    const f = (c: string, i: number) => {
      if (c !== ch.id) return;
      flash.current.set(i, performance.now() + 140);
      setLit((s) => new Set(s).add(i));
      setTimeout(() => {
        if ((flash.current.get(i) ?? 0) <= performance.now()) setLit((s) => ((s = new Set(s)), s.delete(i), s));
      }, 150);
    };
    hits.add(f);
    return () => void hits.delete(f);
  }, [ch.id]);
  // e o que a música toca nesse canal
  useEffect(() => {
    audio.watch(ch.id);
    let last = '';
    const off = onLive((st) => {
      const keys = (st.lit ?? []).map((k) => k - padNote(0)).filter((i) => i >= 0 && i < PAD_COUNT);
      const sig = keys.join(',');
      if (sig === last) return;
      last = sig;
      for (const i of keys) {
        padHit(ch.id, i);
        padFlash(i);
      }
    });
    return () => {
      off();
      audio.watch(null);
    };
  }, [ch.id]);

  const save = (next: (PadSlot | null)[]) => edit([set(['channels', ch.id, 'params', 'pads'], stringifyPads(next))]);
  const setPad = (i: number, slot: PadSlot | null) => {
    const next = [...pads];
    next[i] = slot;
    save(next);
    setSel(i);
  };
  const patch = (i: number, p: Partial<PadSlot>, live = false) => {
    const cur = pads[i];
    if (!cur) return;
    const next = [...pads];
    next[i] = { ...cur, ...p };
    const ops = [set(['channels', ch.id, 'params', 'pads'], stringifyPads(next))];
    if (live) previewEdit(ops);
    else edit(ops);
  };
  const play = (i: number) => {
    padHit(ch.id, i);
    padFlash(i);
    audio.liveOn(ch.id, padNote(i), 0.85);
  };
  const stop = (i: number) => audio.liveOff(ch.id, padNote(i));

  const chooseSound = (i: number): MenuItem[] =>
    instrumentMenu(lib, {
      native: (t) => setPad(i, { name: INSTRUMENTS[t].label, type: t, params: {} }),
      preset: (k) => {
        const pr = presetParams(k);
        if (pr) setPad(i, { name: k, type: pr.type, params: pr.params });
      },
      sample: async (path, name) => {
        try {
          setPad(i, await padFromSample(path, name));
        } catch (e) {
          toast(`Erro: ${(e as Error).message}`);
        }
      },
    }).map((x) => (x.label === 'Music Labs' && x.sub ? { ...x, sub: x.sub.filter((y) => y.label !== INSTRUMENTS.pads.label) } : x));

  const padMenu = (i: number, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: pads[i] ? 'Trocar som' : 'Escolher som', sub: chooseSound(i) },
        {
          label: 'Renomear',
          run: async () => {
            const n = await askText({ title: 'Renomear pad', label: 'Nome', value: pads[i]?.name ?? '', ok: 'Renomear' });
            if (n && pads[i]) patch(i, { name: n });
          },
        },
        { label: 'Limpar pad', run: () => setPad(i, null) },
      ],
    });

  const kitMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = PAD_KITS.map((k) => ({ label: k.label, run: () => save(k.pads) }));
    if (lib?.localSamples.length)
      items.push({
        label: 'Bateria do FL Studio',
        hint: 'Kick, snare, clap, hats, toms e percussão da instalação',
        run: async () => {
          // ordem dos pads: de baixo para cima, da esquerda para a direita
          const want = ['Kick', 'Snare', 'Clap', 'Hat', '808 Kick', 'Rim', 'Open Hat', 'Ride', '909 Kick', '909 Snare', 'Crash', '808 Snare', 'Tom', 'Conga', 'Cowbell'];
          const list: (PadSlot | null)[] = [];
          for (const n of want) {
            const s = lib.localSamples.find((x) => x.name === n);
            list.push(s ? await padFromSample(s.path, s.name).catch(() => null) : null);
          }
          save(list);
        },
      });
    items.push({ sep: true, label: '' }, { label: 'Limpar todos', run: () => save([]) });
    setMenu({ x: r.left, y: r.bottom + 2, items });
  };

  const cur = pads[sel];
  return (
    <div class="padsp">
      <div class="padsp-bar">
        <button onClick={kitMenu as any} data-hint="Trocar todos os pads por um kit pronto">
          Kits ▾
        </button>
        <span class="hint">Clique ou tecla para tocar · botão direito: escolher o som · arraste um áudio do navegador para um pad</span>
      </div>
      <div class="padsp-grid">
        {[0, 1, 2, 3].map((row) =>
          [0, 1, 2, 3].map((col) => {
            const i = padIndex(row, col);
            const s = pads[i];
            const color = padColor(i);
            return (
              <button
                class={`pad ${s ? '' : 'empty'} ${sel === i ? 'sel' : ''} ${lit.has(i) ? 'lit' : ''}`}
                style={{ '--pad': color } as any}
                data-hint={`${s?.name ?? 'Pad vazio'} · tecla ${padKey(i).toUpperCase()} · nota ${noteName(padNote(i))}`}
                onPointerDown={(e) => {
                  if (e.button === 2) return;
                  (e.currentTarget as Element).setPointerCapture(e.pointerId);
                  setSel(i);
                  play(i);
                }}
                onPointerUp={() => stop(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSel(i);
                  padMenu(i, e.clientX, e.clientY);
                }}
                onDragOver={(e) => e.dataTransfer?.types.includes('text/x-musiclabs-sample') && e.preventDefault()}
                onDrop={async (e) => {
                  const path = e.dataTransfer?.getData('text/x-musiclabs-sample');
                  if (!path) return;
                  e.preventDefault();
                  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.[a-z0-9]{2,5}$/i, '');
                  setPad(i, await padFromSample(path, name));
                }}
              >
                <span class="pad-key">{padKey(i).toUpperCase()}</span>
                <span class="pad-name">{s?.name ?? '—'}</span>
              </button>
            );
          }),
        )}
      </div>
      <div class="padsp-sel">
        <b>
          Pad {sel + 1}: {cur?.name ?? 'vazio'}
        </b>
        {cur ? (
          <>
            <span class="dim">{cur.sample ? cur.sample.split(/[\\/]/).slice(-2).join('/') : cur.type ? INSTRUMENTS[cur.type].label : ''}</span>
            <div class="padsp-knobs">
              <Knob label="Ganho" value={cur.gain ?? 0} min={-36} max={12} def={0} format={(v) => `${v.toFixed(1)} dB`} onInput={(v) => patch(sel, { gain: v }, true)} onCommit={(v) => patch(sel, { gain: v })} />
              <Knob label="Afinação" value={cur.tune ?? 0} min={-24} max={24} def={0} step={1} bipolar format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)} st`} onInput={(v) => patch(sel, { tune: Math.round(v) }, true)} onCommit={(v) => patch(sel, { tune: Math.round(v) })} />
            </div>
          </>
        ) : (
          <span class="dim">botão direito no pad para escolher um som</span>
        )}
      </div>
      {menu && <MenuTree x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
