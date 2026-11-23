import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCents } from '../money';

interface Row { id: string; title: string; status: string; totalCents: number; updatedAt: string }

export default function ClaimsList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Row[]>('/claims').then(setRows).catch(() => setError('Could not load claims.')); }, []);
  useEffect(() => { document.querySelector('h1')?.focus(); }, [rows, error]);

  return (
    <section>
      <h1 tabIndex={-1}>My claims</h1>
      <a className="button" href="/claims/new">New claim</a>
      {error && <p role="alert" className="error">{error}</p>}
      {rows?.length === 0 && <p>No claims yet</p>}
      <ul className="cards">
        {rows?.map((c) => (
          <li key={c.id}>
            <h2><a href={`/claims/${c.id}`}>{c.title}</a></h2>
            <dl>
              <dt>Status</dt><dd>{c.status}</dd>
              <dt>Total</dt><dd>{formatCents(c.totalCents)}</dd>
              <dt>Last updated</dt><dd>{new Date(c.updatedAt).toLocaleString()}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
