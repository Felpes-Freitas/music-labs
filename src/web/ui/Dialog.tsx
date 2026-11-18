// Diálogos próprios do app (no lugar de prompt/confirm/alert do navegador).
// Uso: const nome = await askText({...}); const ok = await askConfirm({...});

import { useEffect, useLayoutEffect, useReducer, useRef } from 'preact/hooks';

interface TextReq {
  kind: 'text';
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  ok?: string;
  numeric?: { min: number; max: number };
  resolve: (v: string | null) => void;
}
interface ConfirmReq {
  kind: 'confirm';
  title: string;
  message?: string;
  ok?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
interface InfoReq {
  kind: 'info';
  title: string;
  message?: string;
  resolve: (v: boolean) => void;
}
type Req = TextReq | ConfirmReq | InfoReq;

const queue: Req[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function askText(o: Omit<TextReq, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ kind: 'text', ...o, resolve });
    notify();
  });
}
export function askConfirm(o: Omit<ConfirmReq, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ kind: 'confirm', ...o, resolve });
    notify();
  });
}
export function showInfo(o: Omit<InfoReq, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ kind: 'info', ...o, resolve });
    notify();
  });
}
/** Há um diálogo aberto (o teclado musical e os atalhos ficam pausados). */
export const dialogOpen = () => queue.length > 0;

export function DialogHost() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const l = () => force(undefined);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const req = queue[0];
  const close = (v: unknown) => {
    queue.shift();
    (req.resolve as (x: unknown) => void)(v);
    notify();
  };
  const accept = () => {
    if (!req) return;
    if (req.kind === 'text') {
      const v = input.current?.value ?? '';
      if (req.numeric) {
        const n = Number(v.replace(',', '.'));
        if (!Number.isFinite(n) || n < req.numeric.min || n > req.numeric.max) {
          input.current?.classList.add('bad');
          return;
        }
      }
      close(v.trim() ? v.trim() : null);
    } else close(true);
  };
  const cancel = () => req && close(req.kind === 'text' ? null : false);
  useEffect(() => {
    if (!req) return;
    // Enter confirma, Esc cancela; nenhuma tecla vaza para o app
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        accept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', (e) => e.stopPropagation(), { capture: true, once: true });
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req]);
  // foco no campo no mesmo quadro em que o diálogo aparece (nenhuma tecla se perde)
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [req]);
  if (!req) return null;
  return (
    <div class="dlg-back" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div class={`dlg ${req.kind === 'confirm' && req.danger ? 'danger' : ''}`} role="dialog">
        <div class="dlg-title">{req.title}</div>
        {req.kind !== 'text' && req.message && <div class="dlg-msg">{req.message}</div>}
        {req.kind === 'text' && (
          <label class="dlg-field">
            {req.label && <span>{req.label}</span>}
            <input ref={input} type="text" value={req.value ?? ''} placeholder={req.placeholder} inputMode={req.numeric ? 'decimal' : undefined} onInput={(e) => (e.target as HTMLElement).classList.remove('bad')} />
          </label>
        )}
        <div class="dlg-btns">
          {req.kind !== 'info' && <button onClick={cancel}>Cancelar</button>}
          <button class={req.kind === 'confirm' && req.danger ? 'danger' : 'on'} onClick={accept}>
            {req.kind === 'info' ? 'OK' : req.ok ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
