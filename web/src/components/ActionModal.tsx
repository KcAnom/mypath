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
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function ActionModal({ open, title, description, confirmLabel, cancelLabel = 'Cancel', danger = false, pending = false, error = '', status = '', field, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => input.current?.focus(), 0);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending) onCancel(); };
    document.addEventListener('keydown', escape);
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', escape); previous?.focus(); };
  }, [open, pending, onCancel]);
  if (!open) return null;
  const submit = (event: FormEvent) => { event.preventDefault(); if (!pending && (!field?.required || field.value.trim())) void onConfirm(); };
  const common = { ref: input as any, value: field?.value || '', placeholder: field?.placeholder, required: field?.required, disabled: pending, onChange: (event: any) => field?.onChange(event.target.value) };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onCancel(); }}>
    <section className="action-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
      <form onSubmit={submit}>
        <header><h3 id={titleId}>{title}</h3></header>
        <div className="modal-body">
          {description && <div id={descriptionId} className="modal-description">{description}</div>}
          {field && <label>{field.label}{field.multiline ? <textarea {...common}/> : <input {...common}/>}</label>}
          {error && <div className="diagnostics modal-message" role="alert">{error}</div>}
          {status && !error && <div className="modal-status" role="status">{status}</div>}
        </div>
        <footer><button type="button" disabled={pending} onClick={onCancel}>{cancelLabel}</button><button className={danger ? 'danger' : 'primary'} disabled={pending || Boolean(field?.required && !field.value.trim())}>{pending ? 'Working…' : confirmLabel}</button></footer>
      </form>
    </section>
  </div>;
}
