import { useEffect, useState } from 'preact/hooks';
import { useApp, state, api, act, edit, toast, selectChannel } from '../state';
import { audio } from '../audio';
import * as A from '../../core/actions';
import { set } from '../../core/ops';

interface Entry {
  name: string;
  path: string;
  kind: 'dir' | 'audio' | 'flp' | 'project';
}

export function addSampleChannel(path: string) {
  const name = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  const r = act(A.addChannel, { name, type: 'sampler', params: { sample: path, keytrack: true, oneshot: true, root: 60 } });
  if (r) {
    selectChannel(r.id);
    audio.loadSample(path);
    toast(`Sampler: ${name}`);
  }
}

export function Browser() {
  const s = useApp();
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([]);
  const [stack, setStack] = useState<{ name: string; path: string }[]>([]);
  const [items, setItems] = useState<Entry[]>([]);
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);

  useEffect(() => {
    api('GET', '/api/roots').then(setRoots);
    api('GET', '/api/projects').then((r) => setProjects(r.projects));
  }, [s.path]);

  const cur = stack[stack.length - 1];
  useEffect(() => {
    if (q.trim().length >= 2) {
      const t = setTimeout(() => api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=80`).then((r) => setItems(r.map((x: any) => ({ ...x, kind: 'audio' })))), 250);
      return () => clearTimeout(t);
    }
    if (cur) api('GET', `/api/browse?dir=${encodeURIComponent(cur.path)}`).then(setItems);
    else setItems([]);
  }, [cur?.path, q]);

  const open = async (e: Entry) => {
    if (e.kind === 'dir') setStack([...stack, { name: e.name, path: e.path }]);
    else if (e.kind === 'audio') audio.previewFile(e.path);
    else if (e.kind === 'flp' || e.kind === 'project') {
      if (state.dirty && !confirm(`Abrir ${e.name}? Alterações não salvas serão perdidas.`)) return;
      try {
        const r = await api('POST', '/api/open', { path: e.path });
        if (r.imported) {
          const rep = r.imported;
          toast(`Importado do FL ${rep.version}: ${rep.channels} canais, ${rep.patterns} patterns, ${rep.clips} clips, ${rep.notes} notas. ${rep.substituted.length} plugins trocados por instrumentos nativos.`);
        }
      } catch (err) {
        toast(`Erro: ${(err as Error).message}`);
      }
    }
  };

  const useInChannel = (e: Entry) => {
    const ch = state.project.channels.find((c) => c.id === state.channelId);
    if (ch && ch.type === 'sampler') {
      edit([set(['channels', ch.id, 'params', 'sample'], e.path), set(['channels', ch.id, 'name'], e.name.replace(/\.[^.]+$/, ''))]);
      audio.loadSample(e.path);
    } else addSampleChannel(e.path);
  };

  if (!s.windows.browser.open) return null;
  return (
    <div class="browser">
      <input class="search" placeholder="Buscar samples… (ex.: kick 808)" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {!q && (
        <div class="crumbs">
          <button onClick={() => setStack([])}>⌂</button>
          {stack.map((c, i) => (
            <button onClick={() => setStack(stack.slice(0, i + 1))}>{c.name}</button>
          ))}
        </div>
      )}
      <div class="list">
        {!cur && !q && (
          <>
            <div class="sect">Pastas</div>
            {roots.map((r) => (
              <div class="item dir" onClick={() => setStack([r])}>
                ▸ {r.name}
              </div>
            ))}
            <div class="sect">Projetos do Batuque</div>
            {projects.length === 0 && <div class="hint">Nenhum salvo ainda.</div>}
            {projects.map((pr) => (
              <div class="item project" onDblClick={() => open({ ...pr, kind: 'project' })} title="Duplo clique para abrir">
                ♪ {pr.name}
              </div>
            ))}
          </>
        )}
        {items.map((e) => (
          <div
            class={`item ${e.kind}`}
            draggable={e.kind === 'audio'}
            onDragStart={(ev) => ev.dataTransfer?.setData('text/x-batuque-sample', e.path)}
            onClick={() => e.kind !== 'project' && e.kind !== 'flp' && open(e)}
            onDblClick={() => (e.kind === 'audio' ? useInChannel(e) : open(e))}
            title={e.kind === 'audio' ? 'Clique: ouvir · duplo clique: usar no canal sampler selecionado (ou criar um) · arraste para o rack' : e.kind === 'flp' ? 'Duplo clique: importar projeto do FL Studio' : e.path}
          >
            {e.kind === 'dir' ? '▸ ' : e.kind === 'audio' ? '♫ ' : e.kind === 'flp' ? '⬢ ' : '♪ '}
            {e.name}
          </div>
        ))}
      </div>
    </div>
  );
}
