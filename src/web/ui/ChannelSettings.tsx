import { PadsPanel } from './PadsPanel';
import { useEffect, useState } from 'preact/hooks';
import { useApp, edit, previewEdit, act } from '../state';
import { audio } from '../audio';
import { INSTRUMENTS, PRESETS } from '../../core/registry';
import { noteName, type InstrumentType } from '../../core/model';
import { set } from '../../core/ops';
import * as A from '../../core/actions';
import { Win, useCanvas } from './widgets';
import { ParamGrid } from './ParamGrid';
import { PrismaPanel } from './PrismaPanel';
import { ChannelFx } from './ChannelFx';
import { ChannelPiano } from './ChannelPiano';
import { GearTab } from './GearTab';
import { Icon } from './icons';
import { decodeWav } from '../../core/wav';
import { ui, accent } from '../theme';

function Waveform(p: { path: string }) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    let alive = true;
    setPeaks(null);
    if (!p.path) return;
    fetch(`/api/sample?path=${encodeURIComponent(p.path)}`)
      .then((r) => r.arrayBuffer())
      .then((b) => {
        const d = decodeWav(new Uint8Array(b));
        const ch = d.ch[0];
        const n = 400;
        const out = new Float32Array(n);
        const per = Math.max(1, Math.floor(ch.length / n));
        for (let i = 0; i < n; i++) {
          let m = 0;
          for (let k = i * per; k < Math.min(ch.length, (i + 1) * per); k++) m = Math.max(m, Math.abs(ch[k]));
          out[i] = m;
        }
        if (alive) setPeaks(out);
      })
      .catch(() => alive && setPeaks(new Float32Array(0)));
    return () => {
      alive = false;
    };
  }, [p.path]);
  const { ref } = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = ui('#15191c');
      ctx.fillRect(0, 0, w, h);
      if (!peaks) return;
      ctx.fillStyle = accent();
      for (let i = 0; i < peaks.length; i++) {
        const x = (i / peaks.length) * w;
        const ph = peaks[i] * h * 0.9;
        ctx.fillRect(x, h / 2 - ph / 2, Math.max(1, w / peaks.length), Math.max(1, ph));
      }
    },
    [peaks],
  );
  return <canvas ref={ref} class="wave" />;
}

function SourceBox(p: { path: string; oneshot: boolean; loop: boolean }) {
  const [info, setInfo] = useState<any>(null);
  useEffect(() => {
    setInfo(null);
    if (p.path) fetch(`/api/source?path=${encodeURIComponent(p.path)}`).then((r) => r.json()).then(setInfo).catch(() => setInfo(null));
  }, [p.path]);
  const mode = p.oneshot && !p.loop ? 'One-shot: toca o arquivo inteiro, ignora soltar a tecla' : `Segura enquanto a tecla estiver pressionada e solta com o release${p.loop ? ', com loop de sustentação' : ''}`;
  if (info?.kind === 'set') {
    const roots = info.zones.map((z: any) => z.root);
    return (
      <div class="set-info">
        <b>Instrumento multi-sample</b> · {info.zones.length} samples, de {noteName(Math.round(Math.min(...roots)))} a {noteName(Math.round(Math.max(...roots)))} · raízes por {info.rootSource}
        {info.hasLoop ? ' · com pontos de loop' : ''}
        <div class="set-keys">
          {info.zones.map((z: any) => (
            <span style={{ left: `${(z.lo / 128) * 100}%`, width: `${((z.hi - z.lo + 1) / 128) * 100}%` }} data-hint={`${z.file}: ${noteName(z.lo)}–${noteName(z.hi)}, raiz ${noteName(Math.round(z.root))}`} />
          ))}
        </div>
        <div class="dim">{mode}</div>
      </div>
    );
  }
  return (
    <>
      <Waveform path={p.path} />
      <div class="dim">{mode}</div>
    </>
  );
}

export function ChannelSettings() {
  const s = useApp();
  const p = s.project;
  const ch = p.channels.find((c) => c.id === s.channelId);
  const [tab, setTab] = useState<'inst' | 'gear'>('inst');
  const open = s.windows.channel.open;
  // A engine acende as teclas do canal aberto na tela.
  useEffect(() => {
    audio.watch(open && ch ? ch.id : null);
  }, [open, ch?.id]);
  if (!ch) return null;
  const def = INSTRUMENTS[ch.type];
  // A janela cresce até um tamanho útil (o Prisma pede mais espaço).
  const w = s.windows.channel;
  const [minW, minH] = ch.type === 'prisma' ? [860, 760] : [660, 640];
  if (w.open && (w.w < minW || w.h < minH)) {
    const ws = document.querySelector('.workspace') as HTMLElement | null;
    const W = ws?.clientWidth ?? 1200, H = ws?.clientHeight ?? 800;
    w.w = Math.max(w.w, Math.min(minW, W));
    w.h = Math.max(w.h, Math.min(minH, H - 10));
    w.x = Math.max(0, Math.min(w.x, W - w.w));
    w.y = Math.max(0, Math.min(w.y, H - w.h));
  }
  return (
    <Win id="channel" icon="settings" title={<>Canal <span class="dim">· {ch.name}</span></>} minW={420} minH={300}>
      <div class="chwin">
        <div class="chset-head">
          <input class="ch-title" value={ch.name} onChange={(e) => edit([set(['channels', ch.id, 'name'], (e.target as HTMLInputElement).value)])} />
          <select value={ch.type} data-hint="Tipo de instrumento" onChange={(e) => act(A.updateChannel, { channel: ch.id, type: (e.target as HTMLSelectElement).value as InstrumentType })}>
            {(Object.keys(INSTRUMENTS) as InstrumentType[]).map((t) => (
              <option value={t}>{INSTRUMENTS[t].label}</option>
            ))}
          </select>
          {ch.type !== 'prisma' && ch.type !== 'pads' && (
            <select
              value=""
              data-hint="Carregar preset"
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v) act(A.updateChannel, { channel: ch.id, preset: v });
              }}
            >
              <option value="">preset…</option>
              {Object.entries(PRESETS).map(([k, v]) => (
                <option value={k}>
                  {k} ({v.type})
                </option>
              ))}
            </select>
          )}
          <label data-hint="Insert do mixer para onde o canal vai">
            insert
            <input type="number" value={ch.insert} min={0} max={p.mixer.length - 1} onChange={(e) => edit([set(['channels', ch.id, 'insert'], Number((e.target as HTMLInputElement).value))])} />
          </label>
          <div class="tabs">
            <button class={tab === 'inst' ? 'on' : ''} onClick={() => setTab('inst')} data-hint="Controles do instrumento">
              Instrumento
            </button>
            <button class={`gear-btn ${tab === 'gear' ? 'on' : ''}`} onClick={() => setTab('gear')} data-hint="Configurações: nota raiz, ajuste fino e reprodução do áudio">
              <Icon name="settings" size={13} />
            </button>
          </div>
        </div>
        <div class="chset">
          {tab === 'gear' ? (
            <GearTab ch={ch} />
          ) : (
            <>
              {ch.type !== 'prisma' && <div class="hint">{def.description}</div>}
              {ch.type === 'sampler' && (
                <div class="sample-box">
                  <div class="sample-path" title={String(ch.params.sample)}>
                    {String(ch.params.sample || 'Nenhum sample: dê duplo clique num áudio do navegador com este canal selecionado.')}
                  </div>
                  <SourceBox path={String(ch.params.sample ?? '')} oneshot={ch.params.oneshot === true} loop={ch.params.loop === true} />
                </div>
              )}
              {ch.type === 'pads' ? (
                <PadsPanel ch={ch} />
              ) : ch.type === 'prisma' ? (
                <PrismaPanel ch={ch} />
              ) : (
                <ParamGrid
                  defs={def.params}
                  values={ch.params}
                  auto={{ prefix: ['channels', ch.id, 'params'], label: ch.name }}
                  onInput={(k, v) => previewEdit([set(['channels', ch.id, 'params', k], v)])}
                  onCommit={(k, v) => edit([set(['channels', ch.id, 'params', k], v)])}
                />
              )}
            </>
          )}
        </div>
        <ChannelFx ch={ch} />
        {ch.type !== 'pads' && <ChannelPiano ch={ch} />}
      </div>
    </Win>
  );
}
