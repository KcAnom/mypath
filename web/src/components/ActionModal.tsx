import { FormEvent, ReactNode, useEffect, useId, useRef } from 'react';

export type ModalField = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  required?: boolean;
};

type Props = {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  error?: string;
  status?: string;
  field?: ModalField;
  fields?: ModalField[];
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ActionModal({ open, title, description, confirmLabel, cancelLabel = 'Cancel', danger = false, pending = false, error = '', status = '', field, fields, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => (input.current || confirmRef.current)?.focus(), 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) { onCancel(); return; }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inDialog = active && dialog.contains(active);
      if (event.shiftKey) {
        if (!inDialog || active === first) { event.preventDefault(); last.focus(); }
      } else if (!inDialog || active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', keydown); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, [open, pending, onCancel]);
  if (!open) return null;
  const activeFields = fields || (field ? [field] : []);
  const invalid = activeFields.some((item) => item.required && !item.value.trim());
  const submit = (event: FormEvent) => { event.preventDefault(); if (!pending && !invalid) void onConfirm(); };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onCancel(); }}>
    <section className="action-modal" ref={dialogRef as any} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
      <form onSubmit={submit}>
        <header><h3 id={titleId}>{title}</h3></header>
        <div className="modal-body">
          {description && <div id={descriptionId} className="modal-description">{description}</div>}
          {activeFields.map((item, index) => { const common = { ref: index === 0 ? input as any : undefined, value: item.value, placeholder: item.placeholder, required: item.required, disabled: pending, onChange: (event: any) => item.onChange(event.target.value) }; return <label key={item.label}>{item.label}{item.multiline ? <textarea {...common}/> : <input {...common}/>}</label>; })}
          {error && <p className="status-message error" role="alert">{error}</p>}
          {status && !error && <p className="status-message success" role="status">{status}</p>}
        </div>
        <footer><button type="button" disabled={pending} onClick={onCancel}>{cancelLabel}</button><button ref={confirmRef} className={danger ? 'danger' : 'primary'} disabled={pending || invalid}>{pending ? 'Working…' : confirmLabel}</button></footer>
      </form>
    </section>
  </div>;
}
