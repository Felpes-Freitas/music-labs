import { useEffect, useState } from 'preact/hooks';
import { useApp, edit, previewEdit, act } from '../state';
import { audio } from '../audio';
import { INSTRUMENTS, PRESETS } from '../../core/registry';
import type { InstrumentType } from '../../core/model';
import { set } from '../../core/ops';
import * as A from '../../core/actions';
import { Win, useCanvas } from './widgets';
import { ParamGrid } from './ParamGrid';
import { decodeWav } from '../../core/wav';

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
      ctx.fillStyle = '#15191c';
      ctx.fillRect(0, 0, w, h);
      if (!peaks) return;
      ctx.fillStyle = '#e4a23a';
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

function MiniKeys(p: { channel: string }) {
  const keys = Array.from({ length: 25 }, (_, i) => 48 + i);
  return (
    <div class="minikeys">
      {keys.map((k) => {
        const black = [1, 3, 6, 8, 10].includes(k % 12);
        return (
          <div
            class={`mk ${black ? 'b' : 'w'}`}
            onPointerDown={() => audio.liveOn(p.channel, k, 0.85)}
            onPointerUp={() => audio.liveOff(p.channel, k)}
            onPointerLeave={() => audio.liveOff(p.channel, k)}
          />
        );
      })}
    </div>
  );
}

export function ChannelSettings() {
  const s = useApp();
  const p = s.project;
  const ch = p.channels.find((c) => c.id === s.channelId);
  if (!ch) return null;
  const def = INSTRUMENTS[ch.type];
  return (
    <Win id="channel" title={`Canal · ${ch.name}`} minW={360} minH={260}>
      <div class="chset">
        <div class="chset-row">
          <input value={ch.name} onChange={(e) => edit([set(['channels', ch.id, 'name'], (e.target as HTMLInputElement).value)])} />
          <select value={ch.type} title="Tipo de instrumento" onChange={(e) => act(A.updateChannel, { channel: ch.id, type: (e.target as HTMLSelectElement).value as InstrumentType })}>
            {(Object.keys(INSTRUMENTS) as InstrumentType[]).map((t) => (
              <option value={t}>{INSTRUMENTS[t].label}</option>
            ))}
          </select>
          <select value="" title="Carregar preset" onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) act(A.updateChannel, { channel: ch.id, preset: v });
          }}>
            <option value="">preset…</option>
            {Object.entries(PRESETS)
              .filter(([, v]) => v.type === ch.type || true)
              .map(([k, v]) => (
                <option value={k}>
                  {k} ({v.type})
                </option>
              ))}
          </select>
          <label title="Afinação do canal em semitons">
            pitch
            <input type="number" value={ch.pitch} min={-48} max={48} onChange={(e) => edit([set(['channels', ch.id, 'pitch'], Number((e.target as HTMLInputElement).value))])} />
          </label>
          <label title="Insert do mixer">
            insert
            <input type="number" value={ch.insert} min={0} max={p.mixer.length - 1} onChange={(e) => edit([set(['channels', ch.id, 'insert'], Number((e.target as HTMLInputElement).value))])} />
          </label>
        </div>
        <div class="hint">{def.description}</div>
        {ch.type === 'sampler' && (
          <div class="sample-box">
            <div class="sample-path" title={String(ch.params.sample)}>
              {String(ch.params.sample || 'Nenhum sample: dê duplo clique num áudio do navegador com este canal selecionado.')}
            </div>
            <Waveform path={String(ch.params.sample ?? '')} />
          </div>
        )}
        <ParamGrid
          defs={def.params}
          values={ch.params}
          onInput={(k, v) => previewEdit([set(['channels', ch.id, 'params', k], v)])}
          onCommit={(k, v) => edit([set(['channels', ch.id, 'params', k], v)])}
        />
        <MiniKeys channel={ch.id} />
      </div>
    </Win>
  );
}
