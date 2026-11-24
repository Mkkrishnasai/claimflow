import { Fragment, useSyncExternalStore, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ListChecks, TriangleAlert, Upload, Wallet } from 'lucide-react';
import { statusInfo } from './labels';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

// ---- Button ----
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
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
export const PageHeader = ({ title, eyebrow, subtitle, meta, actions, focusable = true }: { title: string; eyebrow?: string; subtitle?: string; meta?: ReactNode; actions?: ReactNode; focusable?: boolean }) => (
  <header className="page-header">
    <div className="page-header__text">
      {eyebrow && <span className="page-header__eyebrow">{eyebrow}</span>}
      <h1 tabIndex={focusable ? -1 : undefined}>{title}</h1>
      {subtitle && <p className="page-header__sub">{subtitle}</p>}
      {meta}
    </div>
    {actions}
  </header>
);

// Summary tiles above lists. Values come from data the screen already loaded.
export type TileTone = 'violet' | 'blue' | 'teal' | 'green' | 'amber';
// Markup stays dl.summary > div > dt + dd (tests read it); `money` adds class num.
export const Tiles = ({ items }: { items: { label: string; value: ReactNode; sub?: string; money?: boolean; tone: TileTone }[] }) => (
  <dl className="summary tiles">
    {items.map((t) => (
      <div key={t.label} className={`tile tile--${t.tone}`}><dt>{t.label}</dt><dd className={t.money ? 'num' : undefined}>{t.value}</dd>{t.sub && <dd className="tile__sub">{t.sub}</dd>}</div>
    ))}
  </dl>
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

// Brand panel on the account screens (hidden below 768px by app.css; decorative, so aria-hidden).
export const AuthAside = () => (
  <aside className="auth__aside" aria-hidden="true">
    <p className="brand"><span className="brand__mark" />ClaimFlow</p>
    <div>
      <p className="auth__headline">Expense claims, approved and paid in days, not weeks.</p>
      <ol className="journey">
        <li><span className="icon-tile"><Upload size={17} /></span><span><strong>Submit with receipts</strong><span>Policy checks run before it leaves you</span></span></li>
        <li><span className="icon-tile"><ListChecks size={17} /></span><span><strong>Manager approves</strong><span>Flags for over-limit and duplicates</span></span></li>
        <li><span className="icon-tile"><Wallet size={17} /></span><span><strong>Finance pays</strong><span>Every step recorded in the history</span></span></li>
      </ol>
    </div>
    <p className="auth__foot">Employee · Manager · Finance</p>
  </aside>
);
