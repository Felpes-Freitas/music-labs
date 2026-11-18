import type { ParamDef } from '../../core/registry';
import type { Params } from '../../core/model';
import { noteName } from '../../core/model';
import { Knob, fmt } from './widgets';

export function ParamGrid(p: { defs: ParamDef[]; values: Params; onInput: (k: string, v: number | string | boolean) => void; onCommit: (k: string, v: number | string | boolean) => void; mixerSize?: number }) {
  return (
    <div class="params">
      {p.defs.map((d) => {
        const v = p.values[d.key] ?? d.def;
        if (d.kind === 'text') return null;
        if (d.key === 'sidechain')
          return (
            <label class="param-sel">
              <span>{d.label}</span>
              <select value={Number(v)} onChange={(e) => p.onCommit(d.key, Number((e.target as HTMLSelectElement).value))}>
                <option value={-1}>nenhum</option>
                {Array.from({ length: (p.mixerSize ?? 17) - 1 }, (_, i) => (
                  <option value={i + 1}>insert {i + 1}</option>
                ))}
              </select>
            </label>
          );
        if (d.kind === 'enum')
          return (
            <label class="param-sel">
              <span>{d.label}</span>
              <select value={String(v)} onChange={(e) => p.onCommit(d.key, (e.target as HTMLSelectElement).value)}>
                {d.options!.map((o) => (
                  <option>{o}</option>
                ))}
              </select>
            </label>
          );
        if (d.kind === 'bool')
          return (
            <label class="param-bool">
              <input type="checkbox" checked={v === true} onChange={() => p.onCommit(d.key, !(v === true))} />
              <span>{d.label}</span>
            </label>
          );
        const format = d.key === 'root' ? (x: number) => noteName(Math.round(x)) : (x: number) => `${d.step && d.step >= 1 ? Math.round(x) : fmt(x)}${d.unit ? ' ' + d.unit : ''}`;
        return (
          <Knob
            size={30}
            value={Number(v)}
            min={d.min!}
            max={d.max!}
            def={Number(d.def)}
            log={d.curve === 'log' && d.min! > 0}
            step={d.step}
            bipolar={d.min! < 0 && d.max! > 0}
            label={d.label}
            format={format}
            onInput={(x) => p.onInput(d.key, x)}
            onCommit={(x) => p.onCommit(d.key, x)}
          />
        );
      })}
    </div>
  );
}
