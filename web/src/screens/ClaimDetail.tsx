import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { api, ApiError, type Failure, type SessionUser } from '../api';
import { formatCents } from '../money';
import { FlagBadge, StatusBadge } from '../ui/components';
import { actionLabel, statusLabel } from '../ui/labels';

interface Receipt { id: string; originalName: string | null }
interface Line { id: string; date: string; categoryCode: string; amountCents: number; description: string; justification: string | null; overLimit: boolean; duplicate: { claimId: string; basis: string } | null; receipts: Receipt[] }
interface Event { seq: number; action: string; fromStatus: string; toStatus: string; reason: string | null; at: string; actor: { id: string; name: string } }
interface Claim { id: string; claimantId: string; approverId: string | null; claimant?: { id: string; name: string }; title: string; purpose: string; status: string; payment?: { date: string; reference: string } | null; totalCents: number; lines: Line[]; history: Event[] }

const NO_MANAGER = 'A user with no manager cannot submit claims';

export default function ClaimDetail({ id, viewer, go, back = '/claims' }: { id: string; viewer: SessionUser; go: (to: string) => void; back?: '/claims' | '/approvals' | '/payments' }) {
  const [c, setC] = useState<Claim | null>(null);
  const [cats, setCats] = useState<Record<string, string>>({});
  const [hasManager, setHasManager] = useState(true);
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState('');
  const [failures, setFailures] = useState<Failure[]>([]);
  const alertRef = useRef<HTMLDivElement>(null);
  const errRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [payDate, setPayDate] = useState('');
  const [payRef, setPayRef] = useState('');
  const backLink = back === '/approvals' ? <a href="/approvals">Back to approvals</a> : back === '/payments' ? <a href="/payments">Back to payments</a> : <a href="/claims">Back to my claims</a>;

  const load = useCallback(() => api<Claim>(`/claims/${id}`).then(setC).catch((e) => {
    setFatal(e instanceof ApiError && e.status === 403 ? 'Access denied' : e instanceof ApiError && e.status === 404 ? 'Claim not found' : 'Could not load the claim.');
  }), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api<{ code: string; label: string }[]>('/categories').then((l) => setCats(Object.fromEntries(l.map((x) => [x.code, x.label])))).catch(() => {}); }, []);
  useEffect(() => { api<{ managerId: string | null }>(`/users/${viewer.id}`).then((u) => setHasManager(!!u.managerId)).catch(() => {}); }, [viewer.id]);
  useEffect(() => { document.querySelector('h1')?.focus(); }, [c?.id, fatal]);
  useEffect(() => { if (failures.length) alertRef.current?.focus(); }, [failures]);
  useEffect(() => { if (error) errRef.current?.focus(); }, [error]);

  async function run(f: () => Promise<unknown>, after?: () => void) {
    if (inFlight.current) return; // double-click guard: state updates lag the second click
    inFlight.current = true; setBusy(true);
    setError(''); setFailures([]);
    try { await f(); setReason(''); setPayDate(''); setPayRef(''); after ? after() : await load(); } catch (e) {
      if (e instanceof ApiError && e.failures?.length) setFailures(e.failures);
      else if (e instanceof ApiError && e.status === 409 && decision.current) setError('This claim was already actioned');
      else setError(e instanceof ApiError ? e.reason ?? e.code : 'Request failed.');
      load();
    } finally { inFlight.current = false; setBusy(false); decision.current = false; }
  }
  const decision = useRef(false);
  const decide = (action: 'approve' | 'reject' | 'pay' | 'send-back') => { decision.current = true; return run(() => api(`/claims/${id}/${action}`, 'POST', action === 'pay' ? { paymentDate: payDate, reference: payRef } : action === 'approve' ? {} : { reason })); };

  if (fatal) return <section><nav aria-label="Breadcrumb" className="crumbs">{backLink}</nav><h1 tabIndex={-1}>Claim</h1><p role="alert" className="error">{fatal}</p></section>;
  if (!c) return <section><h1 tabIndex={-1}>Claim</h1></section>;

  const own = c.claimantId === viewer.id;
  const canSubmit = own && (c.status === 'draft' || c.status === 'rejected');
  const canEdit = canSubmit;
  const canWithdraw = own && c.status === 'submitted';
  const canDecide = c.approverId === viewer.id && !own && (c.status === 'submitted' || c.status === 'approved');
  const canPay = viewer.role === 'finance' && !own && c.status === 'ready_to_pay';
  const today = new Date().toISOString().slice(0, 10);
  const canDelete = own && c.status === 'draft' && c.history.length === 0;
  const receipts = c.lines.reduce((n, l) => n + l.receipts.length, 0);

  return (
    <section>
      <nav aria-label="Breadcrumb" className="crumbs">{backLink}</nav>

      <div className="card claim-head">
        <div className="page-header__text">
          <div className="claim-head__title"><h1 tabIndex={-1}>{c.title}</h1><StatusBadge status={c.status} /></div>
          <p className="page-header__sub">{c.lines.length} {c.lines.length === 1 ? 'line' : 'lines'} · {receipts} {receipts === 1 ? 'receipt' : 'receipts'}</p>
        </div>
        <div className="actions">
          <div className="claim-head__total"><span>Total</span><span>{formatCents(c.totalCents)}</span></div>
          {canSubmit && <button type="button" disabled={!hasManager} aria-describedby={hasManager ? undefined : 'no-mgr'} onClick={() => run(() => api(`/claims/${id}/submit`, 'POST'))}>Submit</button>}
          {canWithdraw && <button type="button" className="btn--secondary" onClick={() => run(() => api(`/claims/${id}/withdraw`, 'POST', {}))}>Withdraw</button>}
          {canEdit && <a className="button btn--secondary" href={`/claims/${id}/edit`}>Edit</a>}
          {canDelete && <button type="button" className="btn--danger" onClick={() => run(() => api(`/claims/${id}`, 'DELETE'), () => go('/claims'))}>Delete</button>}
        </div>
        {canSubmit && !hasManager && <p id="no-mgr" className="muted">{NO_MANAGER}</p>}
      </div>

      {failures.length > 0 && (
        <div role="alert" tabIndex={-1} ref={alertRef} className="alert error">
          <p>Submit refused: {failures.length} {failures.length === 1 ? 'problem' : 'problems'}</p>
          <ul>{failures.map((f, i) => <li key={i}>{f.position ? `Line ${f.position}` : 'Claim'}: {f.message}</li>)}</ul>
        </div>
      )}
      {error && <div role="alert" tabIndex={-1} ref={errRef} className="alert error">{error}</div>}

      <div className="two-col">
        <div className="two-col__main">
          {canDecide && (
            <div className="card decision">
              <h2>Your decision</h2>
              <label htmlFor="reject-reason">Reason for rejection</label>
              <textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="reject-hint" />
              <p id="reject-hint" className="muted">At least 10 characters</p>
              <div className="actions">
                <button type="button" disabled={busy} onClick={() => decide('approve')}>Approve</button>
                <button type="button" className="btn--danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
              </div>
            </div>
          )}
          {canPay && (
            <div className="card decision">
              <h2>Record payment</h2>
              <div className="line-grid">
                <div>
                  <label htmlFor="pay-date">Payment date</label>
                  <input id="pay-date" type="date" max={today} value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="pay-ref">Payment reference</label>
                  <input id="pay-ref" type="text" maxLength={100} value={payRef} onChange={(e) => setPayRef(e.target.value)} />
                </div>
              </div>
              <div className="actions"><button type="button" disabled={busy} onClick={() => decide('pay')}>Mark paid</button></div>
              <label htmlFor="back-reason">Reason for sending back</label>
              <textarea id="back-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="back-hint" />
              <p id="back-hint" className="muted">At least 10 characters</p>
              <div className="actions"><button type="button" className="btn--secondary" disabled={busy} onClick={() => decide('send-back')}>Send back</button></div>
            </div>
          )}

          <div className="panel">
            <div className="panel__head"><h2>Expense lines</h2><span className="muted">{c.lines.length} {c.lines.length === 1 ? 'line' : 'lines'}</span></div>
            <ul className="plain">
              {c.lines.map((l, i) => (
                <li key={l.id} className="line-item">
                  <div className="line-item__top">
                    <div className="line-item__who">
                      <span className="line-item__n" aria-hidden="true">{i + 1}</span>
                      <span className="page-header__text">
                        <span className="line-item__desc">{l.description}</span>
                        <span className="muted">{cats[l.categoryCode] ?? l.categoryCode} · {l.date}</span>
                      </span>
                    </div>
                    <span className="line-item__amount">{formatCents(l.amountCents)}</span>
                  </div>
                  {(l.overLimit || l.duplicate || l.justification) && (
                    <div className="line-item__extra">
                      {l.overLimit && <FlagBadge>Over limit</FlagBadge>}
                      {l.duplicate && <><FlagBadge>Possible duplicate ({l.duplicate.basis === 'receipt' ? 'same receipt file' : 'same date, category and amount'})</FlagBadge> <a href={`/claims/${l.duplicate.claimId}`}>View earlier claim</a></>}
                      {l.justification && <span>Justification: {l.justification}</span>}
                    </div>
                  )}
                  {l.receipts.length > 0 && (
                    <div className="line-item__extra">
                      {l.receipts.map((r) => <a key={r.id} className="receipt-chip" href={`/api/claims/${c.id}/receipts/${r.id}`}><Paperclip aria-hidden="true" size={15} />{r.originalName ?? 'Receipt'}</a>)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="two-col__side">
          <div className="card">
            <h2>Details</h2>
            <dl className="facts">
              {c.claimant && <div><dt>Claimant</dt><dd>{c.claimant.name}</dd></div>}
              <div><dt>Total</dt><dd>{formatCents(c.totalCents)}</dd></div>
              <div className="wide-fact"><dt>Purpose</dt><dd>{c.purpose}</dd></div>
              {c.payment && <><div><dt>Payment date</dt><dd>{c.payment.date}</dd></div><div><dt>Payment reference</dt><dd>{c.payment.reference}</dd></div></>}
            </dl>
          </div>
          <div className="card">
            <h2>History</h2>
            {c.history.length === 0 ? <p className="muted">No history yet</p> : (
              <ol className="plain timeline">
                {[...c.history].sort((a, b) => a.seq - b.seq).map((h) => (
                  <li key={h.seq}><strong>{h.actor.name}: {actionLabel(h.action)}</strong> ({statusLabel(h.fromStatus)} to {statusLabel(h.toStatus)}) on {new Date(h.at).toLocaleString()}{h.reason ? `. Reason: ${h.reason}` : ''}</li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
