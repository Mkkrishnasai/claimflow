import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { formatCents, parseEuro } from '../money';

interface Policy { categories: { code: string; label: string; limitCents: number }[]; receiptThresholdCents: number; secondApprovalCents: number }
type Vals = Record<string, string>; // key: category code, or 'receipt' / 'second'
const RECEIPT = 'receipt';
const SECOND = 'second';
const euro = (c: number) => formatCents(c).slice(4);
const toVals = (p: Policy): Vals => ({ ...Object.fromEntries(p.categories.map((c) => [c.code, euro(c.limitCents)])), [RECEIPT]: euro(p.receiptThresholdCents), [SECOND]: euro(p.secondApprovalCents) });

export default function PolicySettings() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [vals, setVals] = useState<Vals>({});
  const [errs, setErrs] = useState<Vals>({});
  const [loadError, setLoadError] = useState('');
  const [alert, setAlert] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const apply = (p: Policy) => { setPolicy(p); setVals(toVals(p)); };
  useEffect(() => {
    api<Policy>('/policy').then(apply).catch((e) => setLoadError(e instanceof ApiError && e.status === 403 ? 'Access denied' : 'Could not load policy.'));
  }, []);
  useEffect(() => { if (policy || loadError) document.querySelector('h1')?.focus(); }, [policy, loadError]);

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!policy || inFlight.current) return;
    setStatus(''); setAlert('');
    const stored: Record<string, number> = { ...Object.fromEntries(policy.categories.map((c) => [c.code, c.limitCents])), [RECEIPT]: policy.receiptThresholdCents, [SECOND]: policy.secondApprovalCents };
    const next: Record<string, number> = {};
    const e: Vals = {};
    for (const k of Object.keys(stored)) {
      const c = parseEuro(vals[k] ?? '');
      if (c === null) e[k] = 'Enter an amount from 0.01 to 10000.00.';
      else if (c !== stored[k]) next[k] = c;
    }
    setErrs(e);
    if (Object.keys(e).length) return;
    if (!Object.keys(next).length) { setStatus('No changes to save'); return; }
    const body: { categoryLimits?: Record<string, number>; receiptThresholdCents?: number; secondApprovalCents?: number } = {};
    const limits = Object.fromEntries(Object.entries(next).filter(([k]) => k !== RECEIPT && k !== SECOND));
    if (Object.keys(limits).length) body.categoryLimits = limits;
    if (RECEIPT in next) body.receiptThresholdCents = next[RECEIPT];
    if (SECOND in next) body.secondApprovalCents = next[SECOND];
    inFlight.current = true; setBusy(true);
    try { apply(await api<Policy>('/policy', 'PATCH', body)); setStatus('Policy saved'); }
    catch (x) { setAlert(x instanceof ApiError ? x.reason ?? x.code : 'Request failed.'); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const field = (k: string, label: string) => (
    <div key={k}>
      <label htmlFor={`p-${k}`}>{label}</label>
      <input id={`p-${k}`} type="text" inputMode="decimal" value={vals[k] ?? ''} aria-invalid={!!errs[k]} aria-describedby={errs[k] ? `e-${k}` : undefined}
        onChange={(ev) => setVals({ ...vals, [k]: ev.target.value })} />
      {errs[k] && <p id={`e-${k}`} className="error">{errs[k]}</p>}
    </div>
  );

  return (
    <section>
      <h1 tabIndex={-1}>Policy settings</h1>
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {policy && (
        <form onSubmit={save} noValidate>
          <p>Changes apply to claims submitted from now on. Claims already submitted keep their current values.</p>
          {policy.categories.map((c) => field(c.code, `${c.label} limit (EUR)`))}
          {field(RECEIPT, 'Receipt required from (EUR)')}
          {field(SECOND, 'Second approval above (EUR)')}
          <button type="submit" className="button" disabled={busy}>Save policy</button>
          <p role="status">{status}</p>
          <p role="alert" className="error">{alert}</p>
        </form>
      )}
    </section>
  );
}
