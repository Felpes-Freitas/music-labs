// Lista ao lado da playlist: patterns e a lista de áudios do projeto. A largura
// muda arrastando a borda direita (fica salva).

import { useRef } from 'preact/hooks';
import { useApp, selectPattern, setBrush, act, state } from '../state';
import { loadAudio, ticksPerSec } from '../clipaudio';
import * as A from '../../core/actions';
import { askText, askConfirm } from './Dialog';
import { Icon } from './icons';
import { usePref } from '../prefs';
import { poolItems, removeFromPool, renameAudio, sendToPlaylist, toggleEdits } from '../pool';
import { openTuneAudio } from './Tune';

export function Picker() {
  const s = useApp();
  const p = s.project;
  const [w, setW] = usePref('picker.w', 200);
  const box = useRef<HTMLDivElement>(null);
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
            data-hint="Clique escolhe o pattern que o lápis pinta · duplo clique renomeia"
            onDblClick={async () => {
              const n = await askText({ title: 'Renomear pattern', label: 'Nome', value: pt.name, ok: 'Renomear' });
              if (n) act(A.updatePattern, { pattern: pt.id, name: n });
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
        {audios.length === 0 && <div class="picker-empty">Gravações (amp, Afinador, Stitcher) e áudios importados aparecem aqui. Clique num áudio para pintá-lo na playlist.</div>}
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
              e.dataTransfer!.setData('text/x-batuque-sample', a.path);
              e.dataTransfer!.effectAllowed = 'copy';
            }}
            onDblClick={() => openTuneAudio(a.id)}
            data-hint={`${a.name}${a.path !== a.original ? ' (editado; o original está guardado)' : ''} · clique para pintar na playlist · arraste para a playlist · duplo clique abre no Afinador`}
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
              <button data-hint="Abrir no Afinador" onClick={() => openTuneAudio(a.id)}>
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
    </div>
  );
}
