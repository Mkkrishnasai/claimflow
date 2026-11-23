import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SessionUser } from '../api';
import { formatCents } from '../money';

interface Receipt { id: string; originalName: string | null }
interface Line { id: string; date: string; categoryCode: string; amountCents: number; description: string; overLimit: boolean; receipts: Receipt[] }
interface Event { seq: number; action: string; fromStatus: string; toStatus: string; reason: string | null; at: string; actor: { id: string; name: string } }
interface Claim { id: string; claimantId: string; title: string; purpose: string; status: string; totalCents: number; lines: Line[]; history: Event[] }

const NO_MANAGER = 'You have no manager, so you cannot submit claims';

export default function ClaimDetail({ id, viewer, go }: { id: string; viewer: SessionUser; go: (to: string) => void }) {
  const [c, setC] = useState<Claim | null>(null);
  const [hasManager, setHasManager] = useState(true);
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState('');

  const load = useCallback(() => api<Claim>(`/claims/${id}`).then(setC).catch((e) => {
    setFatal(e instanceof ApiError && e.status === 403 ? 'Access denied' : e instanceof ApiError && e.status === 404 ? 'Claim not found' : 'Could not load the claim.');
  }), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api<{ managerId: string | null }>(`/users/${viewer.id}`).then((u) => setHasManager(!!u.managerId)).catch(() => {}); }, [viewer.id]);
  useEffect(() => { document.querySelector('h1')?.focus(); }, [c, fatal]);

  async function run(f: () => Promise<unknown>, after?: () => void) {
    setError('');
    try { await f(); after ? after() : await load(); } catch (e) {
      setError(e instanceof ApiError ? e.reason ?? e.code : 'Request failed.');
      load();
    }
  }

  if (fatal) return <section><h1 tabIndex={-1}>Claim</h1><p role="alert" className="error">{fatal}</p><p><a href="/claims">Back to my claims</a></p></section>;
  if (!c) return <section><h1 tabIndex={-1}>Claim</h1></section>;

  const own = c.claimantId === viewer.id;
  const canSubmit = own && (c.status === 'draft' || c.status === 'rejected');
  const canEdit = canSubmit;
  const canWithdraw = own && c.status === 'submitted';
  const canDelete = own && c.status === 'draft' && c.history.length === 0;

  return (
    <section>
      <h1 tabIndex={-1}>{c.title}</h1>
      <dl>
        <dt>Status</dt><dd>{c.status}</dd>
        <dt>Purpose</dt><dd>{c.purpose}</dd>
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
        {error && <p role="alert" className="error">{error}</p>}
      </div>
      <h2>History</h2>
      {c.history.length === 0 ? <p>No history yet</p> : (
        <ol className="plain">
          {c.history.map((h) => (
            <li key={h.seq}>{h.actor.name}: {h.action} ({h.fromStatus} to {h.toStatus}) on {new Date(h.at).toLocaleString()}{h.reason ? `. Reason: ${h.reason}` : ''}</li>
          ))}
        </ol>
      )}
      <p><a href="/claims">Back to my claims</a></p>
    </section>
  );
}
