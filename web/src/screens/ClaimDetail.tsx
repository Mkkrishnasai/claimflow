import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Failure, type SessionUser } from '../api';
import { formatCents } from '../money';

interface Receipt { id: string; originalName: string | null }
interface Line { id: string; date: string; categoryCode: string; amountCents: number; description: string; justification: string | null; overLimit: boolean; duplicate: { claimId: string; basis: string } | null; receipts: Receipt[] }
interface Event { seq: number; action: string; fromStatus: string; toStatus: string; reason: string | null; at: string; actor: { id: string; name: string } }
interface Claim { id: string; claimantId: string; approverId: string | null; claimant?: { id: string; name: string }; title: string; purpose: string; status: string; payment?: { date: string; reference: string } | null; totalCents: number; lines: Line[]; history: Event[] }

const NO_MANAGER = 'A user with no manager cannot submit claims';

export default function ClaimDetail({ id, viewer, go, back = '/claims' }: { id: string; viewer: SessionUser; go: (to: string) => void; back?: '/claims' | '/approvals' | '/payments' }) {
  const [c, setC] = useState<Claim | null>(null);
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

  if (fatal) return <section><h1 tabIndex={-1}>Claim</h1><p role="alert" className="error">{fatal}</p><p>{backLink}</p></section>;
  if (!c) return <section><h1 tabIndex={-1}>Claim</h1></section>;

  const own = c.claimantId === viewer.id;
  const canSubmit = own && (c.status === 'draft' || c.status === 'rejected');
  const canEdit = canSubmit;
  const canWithdraw = own && c.status === 'submitted';
  const canDecide = c.approverId === viewer.id && !own && (c.status === 'submitted' || c.status === 'approved');
  const canPay = viewer.role === 'finance' && !own && c.status === 'ready_to_pay';
  const today = new Date().toISOString().slice(0, 10);
  const canDelete = own && c.status === 'draft' && c.history.length === 0;

  return (
    <section>
      <h1 tabIndex={-1}>{c.title}</h1>
      <dl>
        {c.claimant && <><dt>Claimant</dt><dd>{c.claimant.name}</dd></>}
        <dt>Status</dt><dd>{c.status}</dd>
        <dt>Purpose</dt><dd>{c.purpose}</dd>
        {c.payment && <><dt>Payment date</dt><dd>{c.payment.date}</dd><dt>Payment reference</dt><dd>{c.payment.reference}</dd></>}
      </dl>
      <h2>Lines</h2>
      <ul className="cards">
        {c.lines.map((l) => (
          <li key={l.id}>
            <dl>
              <dt>Date</dt><dd>{l.date}</dd>
              <dt>Category</dt><dd>{l.categoryCode}</dd>
              <dt>Amount</dt><dd>{formatCents(l.amountCents)}{l.overLimit && <> <strong className="flag">Over limit</strong></>}</dd>
              <dt>Description</dt><dd>{l.description}</dd>
              {l.justification && <><dt>Justification</dt><dd>{l.justification}</dd></>}
              {l.duplicate && <><dt>Flag</dt><dd><strong className="flag">Possible duplicate ({l.duplicate.basis === 'receipt' ? 'same receipt file' : 'same date, category and amount'})</strong> <a href={`/claims/${l.duplicate.claimId}`}>View earlier claim</a></dd></>}
              {l.receipts.length > 0 && <><dt>Receipts</dt><dd>{l.receipts.map((r) => <a key={r.id} className="block" href={`/api/claims/${c.id}/receipts/${r.id}`}>{r.originalName ?? 'Receipt'}</a>)}</dd></>}
            </dl>
          </li>
        ))}
      </ul>
      <p><strong>Total: {formatCents(c.totalCents)}</strong></p>
      <div>
        {canSubmit && <button type="button" disabled={!hasManager} aria-describedby={hasManager ? undefined : 'no-mgr'} onClick={() => run(() => api(`/claims/${id}/submit`, 'POST'))}>Submit</button>}
        {canSubmit && !hasManager && <p id="no-mgr">{NO_MANAGER}</p>}
        {canWithdraw && <button type="button" onClick={() => run(() => api(`/claims/${id}/withdraw`, 'POST', {}))}>Withdraw</button>}
        {canEdit && <a className="button" href={`/claims/${id}/edit`}>Edit</a>}
        {canDelete && <button type="button" onClick={() => run(() => api(`/claims/${id}`, 'DELETE'), () => go('/claims'))}>Delete</button>}
        {failures.length > 0 && (
          <div role="alert" tabIndex={-1} ref={alertRef} className="error">
            <p>Submit refused: {failures.length} {failures.length === 1 ? 'problem' : 'problems'}</p>
            <ul>{failures.map((f, i) => <li key={i}>{f.position ? `Line ${f.position}` : 'Claim'}: {f.message}</li>)}</ul>
          </div>
        )}
        {canDecide && (
          <div>
            <button type="button" disabled={busy} onClick={() => decide('approve')}>Approve</button>
            <label htmlFor="reject-reason">Reason for rejection</label>
            <textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="reject-hint" />
            <p id="reject-hint">At least 10 characters</p>
            <button type="button" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          </div>
        )}
        {canPay && (
          <div>
            <label htmlFor="pay-date">Payment date</label>
            <input id="pay-date" type="date" max={today} value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            <label htmlFor="pay-ref">Payment reference</label>
            <input id="pay-ref" type="text" maxLength={100} value={payRef} onChange={(e) => setPayRef(e.target.value)} />
            <button type="button" disabled={busy} onClick={() => decide('pay')}>Mark paid</button>
            <label htmlFor="back-reason">Reason for sending back</label>
            <textarea id="back-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="back-hint" />
            <p id="back-hint">At least 10 characters</p>
            <button type="button" disabled={busy} onClick={() => decide('send-back')}>Send back</button>
          </div>
        )}
        {error && <div role="alert" tabIndex={-1} ref={errRef} className="error">{error}</div>}
      </div>
      <h2>History</h2>
      {c.history.length === 0 ? <p>No history yet</p> : (
        <ol className="plain">
          {c.history.map((h) => (
            <li key={h.seq}>{h.actor.name}: {h.action} ({h.fromStatus} to {h.toStatus}) on {new Date(h.at).toLocaleString()}{h.reason ? `. Reason: ${h.reason}` : ''}</li>
          ))}
        </ol>
      )}
      <p>{backLink}</p>
    </section>
  );
}
