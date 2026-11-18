import { useEffect, useState } from 'preact/hooks';
import { useApp, state, api, act, edit, toast, selectChannel } from '../state';
import { audio } from '../audio';
import * as A from '../../core/actions';
import { set } from '../../core/ops';
import { INSTRUMENTS, PRESETS } from '../../core/registry';
import type { InstrumentType } from '../../core/model';
import { Icon } from './icons';

interface Entry {
  name: string;
  path: string;
  kind: 'dir' | 'audio' | 'flp' | 'project';
}

export function addSampleChannel(path: string, name?: string) {
  const nm = name ?? path.split('/').pop()!.replace(/\.[^.]+$/, '');
  const r = act(A.addChannel, { name: nm, type: 'sampler', params: { sample: path, keytrack: true, oneshot: true, root: 60 } });
  if (r) {
    selectChannel(r.id);
    audio.loadSample(path);
    toast(`Sampler: ${nm}`);
  }
}

function addPreset(name: string) {
  const r = act(A.addChannel, { preset: name });
  if (r) selectChannel(r.id);
}

async function openFile(e: Entry) {
  if (state.dirty && !confirm(`Abrir ${e.name}? Alterações não salvas serão perdidas.`)) return;
  try {
    const r = await api('POST', '/api/open', { path: e.path });
    if (r.imported) {
      const rep = r.imported;
      toast(`Importado do FL ${rep.version}: ${rep.channels} canais, ${rep.patterns} patterns, ${rep.clips} clips, ${rep.notes} notas. ${rep.substituted.length} plugins viraram instrumentos nativos.`);
    }
  } catch (err) {
    toast(`Erro: ${(err as Error).message}`);
  }
}

function useInChannel(e: Entry) {
  const ch = state.project.channels.find((c) => c.id === state.channelId);
  if (ch && ch.type === 'sampler') {
    edit([set(['channels', ch.id, 'params', 'sample'], e.path), set(['channels', ch.id, 'name'], e.name.replace(/\.[^.]+$/, ''))]);
    audio.loadSample(e.path);
  } else addSampleChannel(e.path);
}

const ICON: Record<string, string> = { dir: 'folder', audio: 'wave', flp: 'flp', project: 'project' };

function Folder(p: { entry: Entry; depth: number; root?: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Entry[] | null>(null);
  useEffect(() => {
    if (open && !items) api('GET', `/api/browse?dir=${encodeURIComponent(p.entry.path)}`).then(setItems).catch(() => setItems([]));
  }, [open]);
  return (
    <>
      <div class={`node k-dir ${p.root ? 'k-root' : ''}`} style={{ paddingLeft: `${4 + p.depth * 12}px` }} onClick={() => setOpen(!open)} data-hint={p.entry.path}>
        <Icon name="chevron" size={10} class={`tw ${open ? 'open' : ''}`} />
        <Icon name="folder" size={13} />
        <span class="nm">{p.entry.name}</span>
      </div>
      {open && items && items.length === 0 && <div class="empty" style={{ paddingLeft: `${30 + p.depth * 12}px` }}>vazio</div>}
      {open && items?.map((e) => (e.kind === 'dir' ? <Folder entry={e} depth={p.depth + 1} /> : <FileNode entry={e} depth={p.depth + 1} />))}
    </>
  );
}

function FileNode(p: { entry: Entry; depth: number }) {
  const e = p.entry;
  const hint =
    e.kind === 'audio'
      ? 'Clique: ouvir · duplo clique: usar no sampler selecionado (ou criar um) · arraste para o rack'
      : e.kind === 'flp'
        ? 'Duplo clique: importar projeto do FL Studio'
        : 'Duplo clique: abrir projeto';
  return (
    <div
      class={`node k-${e.kind}`}
      style={{ paddingLeft: `${16 + p.depth * 12}px` }}
      draggable={e.kind === 'audio'}
      onDragStart={(ev) => ev.dataTransfer?.setData('text/x-musiclabs-sample', e.path)}
      onClick={() => e.kind === 'audio' && audio.previewFile(e.path)}
      onDblClick={() => (e.kind === 'audio' ? useInChannel(e) : openFile(e))}
      data-hint={hint}
    >
      <Icon name={ICON[e.kind]} size={13} />
      <span class="nm">{e.name}</span>
    </div>
  );
}

export function Browser() {
  const s = useApp();
  const [tab, setTab] = useState<'files' | 'sounds' | 'projects'>('files');
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Entry[]>([]);
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [local, setLocal] = useState<{ name: string; path: string }[]>([]);

  useEffect(() => {
    api('GET', '/api/roots').then(setRoots);
    api('GET', '/api/registry').then((r) => setLocal(r.localSamples ?? []));
  }, []);
  useEffect(() => {
    api('GET', '/api/projects').then((r) => setProjects(r.projects));
  }, [s.path, tab]);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=120`).then((r) => setHits(r.map((x: any) => ({ ...x, kind: 'audio' })))), 220);
    return () => clearTimeout(t);
  }, [q]);

  if (!s.windows.browser.open) return null;
  return (
    <div class="browser">
      <div class="br-head">
        <input class="search" placeholder="Buscar samples (ex.: kick 808)" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} data-hint="Busca em todas as pastas de samples" />
      </div>
      <div class="br-tabs">
        <button class={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          Arquivos
        </button>
        <button class={tab === 'sounds' ? 'on' : ''} onClick={() => setTab('sounds')}>
          Sons
        </button>
        <button class={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>
          Projetos
        </button>
      </div>
      <div class="tree">
        {q.trim().length >= 2 ? (
          hits.length ? hits.map((e) => <FileNode entry={e} depth={0} />) : <div class="empty">Nada encontrado.</div>
        ) : tab === 'files' ? (
          roots.map((r) => <Folder entry={{ ...r, kind: 'dir' }} depth={0} root />)
        ) : tab === 'sounds' ? (
          <>
            {local.length > 0 && <div class="empty">Samples da sua instalação do FL</div>}
            {local.map((l) => (
              <div class="node k-audio" style={{ paddingLeft: '16px' }} onClick={() => audio.previewFile(l.path)} onDblClick={() => addSampleChannel(l.path, l.name)} data-hint="Clique: ouvir · duplo clique: novo canal">
                <Icon name="wave" size={13} />
                <span class="nm">{l.name}</span>
              </div>
            ))}
            <div class="empty">Instrumentos nativos</div>
            {(Object.keys(INSTRUMENTS) as InstrumentType[]).map((t) => (
              <div class="node k-inst" style={{ paddingLeft: '16px' }} onDblClick={() => act(A.addChannel, { type: t })} data-hint={`${INSTRUMENTS[t].description} · duplo clique: novo canal`}>
                <Icon name={t === 'drum' ? 'drum' : t === 'sampler' ? 'wave' : 'synth'} size={13} />
                <span class="nm">{INSTRUMENTS[t].label}</span>
              </div>
            ))}
            <div class="empty">Presets</div>
            {Object.entries(PRESETS).map(([k, v]) => (
              <div class="node k-inst" style={{ paddingLeft: '16px' }} onDblClick={() => addPreset(k)} data-hint={`${v.description} · duplo clique: novo canal`}>
                <Icon name={v.type === 'drum' ? 'drum' : 'synth'} size={13} />
                <span class="nm">{k}</span>
              </div>
            ))}
          </>
        ) : (
          <>
            {projects.length === 0 && <div class="empty">Nenhum projeto salvo ainda.</div>}
            {projects.map((pr) => (
              <FileNode entry={{ ...pr, kind: 'project' }} depth={0} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
