import { Fragment, useSyncExternalStore, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { TriangleAlert } from 'lucide-react';
import { statusInfo } from './labels';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

// ---- Button ----
type Variant = 'primary' | 'secondary' | 'danger';
type ButtonProps = { variant?: Variant; icon?: ReactNode } & (
  | ({ href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>)
  | ({ href: string } & AnchorHTMLAttributes<HTMLAnchorElement>)
);
export function Button({ variant = 'primary', icon, className, children, ...rest }: ButtonProps) {
  const kids = <>{icon}{children}</>;
  if ('href' in rest && rest.href !== undefined) return <a {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} className={cx('button', 'btn', `btn--${variant}`, className)}>{kids}</a>;
  const { type, ...b } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return <button {...b} type={type ?? 'button'} className={cx('btn', `btn--${variant}`, className)}>{kids}</button>;
}

// ---- Fields: one visible <label for>, aria-invalid/describedby only when `error` is set ----
interface FieldShell { id: string; label: string; hint?: { id: string; text: string }; error?: string; errorId?: string; attention?: boolean }
const aria = ({ id, hint, error, errorId }: FieldShell) => {
  const eid = errorId ?? `${id}-err`;
  return error
    ? { 'aria-invalid': true as const, 'aria-describedby': [hint?.id, eid].filter(Boolean).join(' ') }
    : { 'aria-describedby': hint?.id };
};
function Field({ shell, children }: { shell: FieldShell; children: ReactNode }) {
  const { id, label, hint, error, errorId = `${id}-err` } = shell;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <p id={hint.id} className="hint">{hint.text}</p>}
      {error && <p id={errorId} role="alert" className="error">{error}</p>}
    </div>
  );
}
type TextProps = FieldShell & { multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;
type AreaProps = FieldShell & { multiline: true } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>;
export function TextField(props: TextProps | AreaProps) {
  const { id, label, hint, error, errorId, attention, multiline, ...native } = props;
  const shell = { id, label, hint, error, errorId, attention };
  const common = { id, className: cx(attention && 'attention'), ...aria(shell) };
  return (
    <Field shell={shell}>
      {multiline
        ? <textarea {...common} {...(native as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
        : <input {...common} {...(native as InputHTMLAttributes<HTMLInputElement>)} />}
    </Field>
  );
}
export function Select({ id, label, hint, error, errorId, attention, options, children, ...native }: FieldShell & { options?: { value: string; label: string }[] } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>) {
  const shell = { id, label, hint, error, errorId, attention };
  return (
    <Field shell={shell}>
      <select {...native} id={id} className={cx(attention && 'attention')} {...aria(shell)}>
        {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {children}
      </select>
    </Field>
  );
}
export const DateField = (p: FieldShell & { max?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'>) => <TextField {...p} type="date" />;

// ---- Display ----
export function Card({ as: As = 'div', className, children }: { as?: 'div' | 'section' | 'li' | 'fieldset'; className?: string; children: ReactNode }) {
  return <As className={cx('card', className)}>{children}</As>;
}
export const StatusBadge = ({ status }: { status: string }) => {
  const { label, tone } = statusInfo(status);
  return <span className={`badge badge--${tone}`}>{label}</span>;
};
export const FlagBadge = ({ children }: { children: ReactNode }) => <span className="badge badge--flag"><TriangleAlert aria-hidden="true" size={14} />{children}</span>;
export function Alert({ role = 'alert', tone = 'danger', className, children, ...rest }: { role?: 'alert' | 'status'; tone?: 'danger' | 'info' | 'success'; ref?: Ref<HTMLDivElement> } & Omit<React.HTMLAttributes<HTMLDivElement>, 'role'>) {
  return <div {...rest} role={role} className={cx('alert', `alert--${tone}`, tone === 'danger' && 'error', className)}>{children}</div>;
}
export const EmptyState = ({ text, action }: { text: string; action?: ReactNode }) => <div className="empty"><p>{text}</p>{action}</div>;
export const PageHeader = ({ title, meta, actions, focusable = true }: { title: string; meta?: ReactNode; actions?: ReactNode; focusable?: boolean }) => (
  <header className="page-header"><h1 tabIndex={focusable ? -1 : undefined}>{title}</h1>{meta}{actions}</header>
);

// ---- Table: <table> at >= 768 px, today's ul.cards markup below. Keep 768 in sync with app.css. ----
const WIDE = '(min-width: 768px)';
const subscribe = (cb: () => void) => { const m = matchMedia(WIDE); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); };
export const useWide = () => useSyncExternalStore(subscribe, () => typeof matchMedia === 'undefined' || matchMedia(WIDE).matches, () => true);

export interface Column<T> { key: string; header: string; cell: (row: T) => ReactNode; numeric?: boolean; primary?: boolean }
export function Table<T>({ columns, rows, rowKey, labelledBy, wide }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; labelledBy?: string; wide?: boolean }) {
  const hookWide = useWide();
  if (wide ?? hookWide) {
    return (
      <table className="table" aria-labelledby={labelledBy}>
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={cx(c.numeric && 'num')}>{c.header}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={rowKey(r)}>{columns.map((c) => <td key={c.key} className={cx(c.numeric && 'num')}>{c.cell(r)}</td>)}</tr>)}</tbody>
      </table>
    );
  }
  const primary = columns.find((c) => c.primary) ?? columns[0];
  return (
    <ul className="cards" aria-labelledby={labelledBy}>
      {rows.map((r) => (
        <li key={rowKey(r)}>
          <h2>{primary.cell(r)}</h2>
          <dl>{columns.filter((c) => c !== primary).map((c) => <Fragment key={c.key}><dt>{c.header}</dt><dd className={cx(c.numeric && 'num')}>{c.cell(r)}</dd></Fragment>)}</dl>
        </li>
      ))}
    </ul>
  );
}

// ---- helper for screens (ADR-66): native validation messages keyed by element id, plus the first invalid element ----
export function fieldErrors(form: HTMLFormElement) {
  const errors: Record<string, string> = {};
  let first: HTMLElement | null = null;
  for (const el of Array.from(form.elements) as (HTMLInputElement)[]) {
    if (el.id && el.willValidate && !el.validity.valid) { errors[el.id] = el.validationMessage; first ??= el; }
  }
  return { errors, first };
}
