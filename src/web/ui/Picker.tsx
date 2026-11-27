// Lista ao lado da playlist: patterns e a lista de áudios do projeto. A largura
// muda arrastando a borda direita (fica salva).

import { useRef, useState } from 'preact/hooks';
import { useApp, selectPattern, setBrush, act, state, openWindow, toast } from '../state';
import { loadAudio, ticksPerSec } from '../clipaudio';
import * as A from '../../core/actions';
import { askText, askConfirm } from './Dialog';
import { Icon } from './icons';
import { ContextMenu } from './widgets';
import { usePref } from '../prefs';
import { poolItems, removeFromPool, renameAudio, sendToPlaylist, toggleEdits } from '../pool';
import { openTuneAudio } from './Tune';

export function Picker() {
  const s = useApp();
  const p = s.project;
  const [w, setW] = usePref('picker.w', 200);
  const box = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [aMenu, setAMenu] = useState<{ x: number; y: number; items: [string, () => void][] } | null>(null);
  const openPattern = (id: string) => {
    selectPattern(id);
    openWindow('rack');
  };
  const patMenu = (id: string): [string, () => void][] => {
    const pt = p.patterns.find((x) => x.id === id);
    if (!pt) return [];
    return [
      ['Abrir no rack', () => openPattern(id)],
      [
        'Renomear…',
        async () => {
          const n = await askText({ title: 'Renomear pattern', label: 'Nome', value: pt.name, ok: 'Renomear' });
          if (n) act(A.updatePattern, { pattern: id, name: n });
        },
      ],
      [
        'Clonar',
        () => {
          const r = act(A.duplicatePattern, { pattern: id });
          if (r) selectPattern(r.id);
        },
      ],
      [
        'Excluir',
        async () => {
          const n = p.clips.filter((c) => c.patternId === id).length;
          if (await askConfirm({ title: `Excluir ${pt.name}?`, message: n ? `As notas e os ${n} clipe${n > 1 ? 's' : ''} dele na playlist também saem.` : 'As notas dele também saem.', ok: 'Excluir', danger: true })) act(A.removePattern, { pattern: id });
        },
      ],
    ];
  };
  const audios = poolItems(p);
  // variantes logo abaixo do áudio de origem
  const ordered = audios.filter((a) => !a.variantOf || !audios.some((x) => x.id === a.variantOf));
  const withVariants = ordered.flatMap((a) => [a, ...audios.filter((v) => v.variantOf === a.id)]);
  const resize = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = w;
    const move = (ev: PointerEvent) => {
      const nw = Math.max(130, Math.min(460, w0 + ev.clientX - x0));
      if (box.current) box.current.style.width = `${nw}px`;
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setW(Math.max(130, Math.min(460, w0 + ev.clientX - x0)));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div class="picker" ref={box} style={{ width: `${w}px` }}>
      <div class="picker-scroll">
        <div class="picker-head">Patterns</div>
        {p.patterns.map((pt) => (
          <button
            class={`pk ${pt.id === s.patternId && !s.brush ? 'on' : ''}`}
            style={{ borderLeftColor: pt.color }}
            onClick={() => selectPattern(pt.id)}
            data-hint="Clique escolhe o pattern que o lápis pinta · duplo clique abre no rack · botão direito: renomear, clonar, excluir"
            onDblClick={() => openPattern(pt.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, id: pt.id });
            }}
          >
            {pt.name}
          </button>
        ))}
        <button
          class="pk pk-add"
          data-hint="Novo pattern"
          onClick={() => {
            const r = act(A.addPattern, {});
            if (r) selectPattern(r.id);
          }}
        >
          + pattern
        </button>
        <div class="picker-head">Áudios</div>
        {audios.length === 0 && <div class="picker-empty">Gravações (amp, Melodify, Stitcher) e áudios importados aparecem aqui. Clique num áudio para pintá-lo na playlist.</div>}
        {withVariants.map((a) => (
          <div
            class={`pa ${a.variantOf ? 'variant' : ''} ${s.brush?.sample === a.path ? 'on' : ''}`}
            onClick={async () => {
              // o áudio vira o pincel da playlist (clicar no vazio coloca ele inteiro)
              const d = await loadAudio(a.path);
              setBrush({ sample: a.path, startSec: 0, len: Math.max(1, Math.round((d.ch[0].length / d.sr) * ticksPerSec(state.project))), name: a.name });
            }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer!.setData('text/x-musiclabs-sample', a.path);
              e.dataTransfer!.effectAllowed = 'copy';
            }}
            onDblClick={() => openTuneAudio(a.id)}
            onContextMenu={async (e) => {
              e.preventDefault();
              const x = e.clientX, y = e.clientY;
              setAMenu({ x, y, items: await timbreMenu(a.id, a.name) });
            }}
            data-hint={`${a.name}${a.path !== a.original ? ' (editado; o original está guardado)' : ''} · clique para pintar na playlist · arraste para a playlist · duplo clique abre no Melodify · botão direito: timbre transfer`}
          >
            <Icon name="wave" size={12} class="pa-ico" />
            <span class="pa-name">{a.name}</span>
            {(a.path !== a.original || a.edited) && (
              <button
                class={`pa-badge ${a.path !== a.original ? '' : 'off'}`}
                data-hint={a.path !== a.original ? 'Editado: clique para desativar as edições (o original toca)' : 'Edições desativadas: clique para reativar'}
                onClick={(e) => (e.stopPropagation(), toggleEdits(a.id))}
              >
                ed.
              </button>
            )}
            <span class="pa-acts">
              <button data-hint="Enviar para a playlist" onClick={() => sendToPlaylist(a.id)}>
                <Icon name="playlist" size={11} />
              </button>
              <button data-hint="Abrir no Melodify" onClick={() => openTuneAudio(a.id)}>
                <Icon name="tune" size={11} />
              </button>
              <button
                data-hint="Renomear"
                onClick={async () => {
                  const n = await askText({ title: 'Renomear áudio', label: 'Nome', value: a.name, ok: 'Renomear' });
                  if (n) renameAudio(a.id, n);
                }}
              >
                <Icon name="pencil" size={11} />
              </button>
              <button
                data-hint="Tirar da lista (o arquivo e os clipes na playlist continuam)"
                onClick={async () => (await askConfirm({ title: `Tirar "${a.name}" da lista?`, message: 'O arquivo continua salvo e os clipes na playlist não mudam.', ok: 'Tirar' })) && removeFromPool(a.id)}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <div class="picker-grip" onPointerDown={resize as any} data-hint="Arraste para mudar a largura da lista" />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={patMenu(menu.id)} onClose={() => setMenu(null)} />}
      {aMenu && <ContextMenu x={aMenu.x} y={Math.max(8, Math.min(aMenu.y, window.innerHeight - 24 - aMenu.items.length * 28))} items={aMenu.items} onClose={() => setAMenu(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- timbre transfer (versão crua)

type TimbreModel = { name: string; description: string; downloaded: boolean };
const post = async (url: string, b: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? r.statusText);
  return d;
};

/** Itens do botão direito num áudio: transformar com um modelo, baixar modelos, preparar o ambiente. */
async function timbreMenu(id: string, name: string): Promise<[string, () => void][]> {
  let st: { ready: boolean; models: TimbreModel[] };
  try {
    st = await (await fetch('/api/timbre')).json();
  } catch {
    return [['Timbre transfer: servidor indisponível', () => {}]];
  }
  if (!st.ready)
    return [
      [
        'Timbre transfer: preparar (instala o PyTorch, ~900 MB)',
        async () => {
          toast('Preparando o timbre transfer… (alguns minutos)');
          try {
            await post('/api/timbre/setup', {});
            toast('Timbre transfer pronto: clique com o botão direito num áudio de novo');
          } catch (e) {
            toast(`Timbre transfer: ${(e as Error).message}`);
          }
        },
      ],
    ];
  const have = st.models.filter((m) => m.downloaded);
  const rest = st.models.filter((m) => !m.downloaded);
  return [
    ...have.map((m) => [
      `Timbre → ${m.name}`,
      async () => {
        toast(`Timbre transfer de "${name}" com ${m.name}…`);
        try {
          const d = await post('/api/timbre', { audio: id, model: m.name, origin: 'http' });
          toast(`Pronto em ${d.seconds} s: variante "${name} (${m.name})" na lista`);
        } catch (e) {
          toast(`Timbre transfer: ${(e as Error).message}`);
        }
      },
    ] as [string, () => void]),
    ...rest.map((m) => [
      `Baixar modelo ${m.name} — ${m.description.split(/[.,(]/)[0].slice(0, 48)}`,
      async () => {
        toast(`Baixando o modelo ${m.name}…`);
        try {
          await post('/api/timbre/model', { name: m.name });
          toast(`Modelo ${m.name} baixado`);
        } catch (e) {
          toast(`Download: ${(e as Error).message}`);
        }
      },
    ] as [string, () => void]),
  ];
}
