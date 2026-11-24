import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { formatCents } from '../money';

interface Item { id: string; title: string; claimant: { id: string; name: string }; readyAt: string; totalCents: number; lineCount: number; overLimitCount: number; duplicateCount: number }
interface Queue { count: number; totalCents: number; items: Item[] }

export default function Payments() {
  const [q, setQ] = useState<Queue | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Queue>('/payments').then(setQ).catch((e) => setError(e instanceof ApiError && e.status === 403 ? 'Access denied' : 'Could not load payments.'));
  }, []);
  useEffect(() => { if (q || error) document.querySelector('h1')?.focus(); }, [q, error]);

  return (
    <section>
      <h1 tabIndex={-1}>Payments</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {q && <p>{`${q.count} ${q.count === 1 ? 'claim' : 'claims'} waiting, total ${formatCents(q.totalCents)}`}</p>}
      {q?.items.length === 0 && <p>No claims waiting for payment</p>}
      <ul className="cards">
        {q?.items.map((c) => (
          <li key={c.id}>
            <h2><a href={`/payments/${c.id}`}>{c.title}</a></h2>
            <dl>
              <dt>Claimant</dt><dd>{c.claimant.name}</dd>
              <dt>Total</dt><dd>{formatCents(c.totalCents)}</dd>
              <dt>Ready</dt><dd>{new Date(c.readyAt).toLocaleDateString()}</dd>
              <dt>Lines</dt><dd>{c.lineCount}</dd>
            </dl>
            {c.overLimitCount > 0 && <p>{`Over limit (${c.overLimitCount})`}</p>}
            {c.duplicateCount > 0 && <p>{`Possible duplicate (${c.duplicateCount})`}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
