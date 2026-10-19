import { useEffect, useRef, type ReactNode, type FormEvent } from 'react';
import { X, AlertCircle, ArrowUpRight, Plus, Lightbulb, Check } from 'lucide-react';
import { ApiError } from './api';

export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { ref?: React.Ref<HTMLButtonElement> }) {
  return <button {...props} className={`button ${props.className || ''}`}>{children}</button>;
}
export function Modal({ title, children, close, busy = false }: { title: string; children: ReactNode; close: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('input:not([type="checkbox"]), select')?.focus();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}
    onKeyDown={event => {
      if (busy && event.key === 'Escape') event.preventDefault();
      if (event.key !== 'Tab') return;
      const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]')]
        .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length > 0);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }}>
    <div className="modal-heading"><div><p className="eyebrow">YOUR ENERGY WORKSPACE</p><h2 id="modal-title">{title}</h2></div>
      <button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={close}><X size={20} /></button></div>
    {children}
  </dialog>;
}
export function Field({ label, name, error, hint, children, ...input }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; name: string; error?: string; hint?: string; children?: ReactNode }) {
  return <div className={`field ${error ? 'invalid' : ''}`}><label htmlFor={name}>{label}</label>
    {children || <input {...input} id={name} name={name} aria-invalid={!!error} aria-describedby={error ? name + '-error' : hint ? name + '-hint' : undefined} />}
    {error ? <p className="field-error" id={name + '-error'}>{error}</p> : hint && <p className="hint" id={name + '-hint'}>{hint}</p>}
  </div>;
}
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const stale = error instanceof ApiError && error.code === 'STALE_VERSION';
  const text = stale ? 'This appliance changed in another session. Discard your changes and reload the latest record.'
    : error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT' ? 'This request was already used with different values. Refresh the workspace before trying again.'
    : error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  return <div role="alert" className="notice error"><AlertCircle size={19} /><div><strong>{text}</strong>
    {error instanceof ApiError && error.requestId && <p className="hint">Reference: {error.requestId}</p>}
    {retry && <button className="text-button" onClick={retry}>{stale ? 'Discard changes and reload' : 'Try again'} <ArrowUpRight size={14} /></button>}</div></div>;
}
export function EmptyState({ kind, action }: { kind: 'profiles' | 'appliances'; action: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><Lightbulb size={28} /></div>
    <p className="eyebrow">A CLEARER PICTURE STARTS HERE</p><h2>{kind === 'profiles' ? 'Make space for your energy story.' : 'Every appliance adds a little clarity.'}</h2>
    <p>{kind === 'profiles' ? 'Create a profile for your home or business. Keep each space’s appliances and estimates together.' : 'Add the appliances you use, then tell us what you know about their ratings and daily use. Unknown values can wait.'}</p>
    <Button onClick={action}><Plus size={17} />{kind === 'profiles' ? 'Create your first profile' : 'Add your first appliance'}</Button>
    <span className="empty-foot"><Check size={14} /> No guessed ratings. No hidden assumptions.</span>
  </div>;
}
export function submitFocus(event: FormEvent, errors: Record<string, string>) {
  event.preventDefault();
  const name = Object.keys(errors)[0];
  if (name) requestAnimationFrame(() => (document.getElementById(name) as HTMLElement | null)?.focus());
}
