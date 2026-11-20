// Seletor de tom (escala) usado pelo Melodify e pelo Stitcher: "Automático"
// mostra o tom detectado; dá para escolher qualquer raiz e escala.

import { NOTE_NAMES_PT, SCALE_LABELS, SCALE_KEYS, keyLabel, type Key } from '../../core/key';

export function KeyPicker(p: { value: Key | null; detected: Key | null; onChange: (k: Key | null) => void }) {
  const cur = p.value ?? p.detected;
  return (
    <div class="keypick" data-hint="Tom usado para decidir a nota certa de cada trecho. Automático = o tom detectado no que foi cantado/tocado">
      <span class="keypick-lbl">Tom</span>
      <select
        value={p.value ? String(p.value.root) : 'auto'}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          p.onChange(v === 'auto' ? null : { root: Number(v), scale: cur?.scale ?? 'major' });
        }}
      >
        <option value="auto">Automático{p.detected ? ` (${keyLabel(p.detected)})` : ''}</option>
        {NOTE_NAMES_PT.map((n, i) => (
          <option value={String(i)}>{n}</option>
        ))}
      </select>
      <select
        value={cur?.scale ?? 'major'}
        disabled={!p.value && !p.detected}
        onChange={(e) => p.onChange({ root: cur?.root ?? 0, scale: (e.target as HTMLSelectElement).value })}
      >
        {SCALE_KEYS.map((k) => (
          <option value={k}>{SCALE_LABELS[k]}</option>
        ))}
      </select>
    </div>
  );
}
