import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCents } from '../money';

interface Receipt { id: string; originalName: string | null }
interface Line { position: number; description: string; amountCents: number; receipts: Receipt[] }
interface Row { id: string; title: string; claimant: { id: string; name: string }; stage: 'first' | 'second'; submittedAt: string; totalCents: number; overLimitCount: number; duplicateCount: number; lines: Line[] }

export default function Approvals() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Row[]>('/approvals').then(setRows).catch(() => setError('Could not load approvals.')); }, []);
  useEffect(() => { if (rows || error) document.querySelector('h1')?.focus(); }, [rows, error]);

  return (
    <section>
      <h1 tabIndex={-1}>Approvals</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {rows?.length === 0 && <p>No claims waiting</p>}
      <ul className="cards">
        {rows?.map((c) => (
          <li key={c.id}>
            <h2><a href={`/approvals/${c.id}`}>{c.title}</a></h2>
            <dl>
              <dt>Claimant</dt><dd>{c.claimant.name}</dd>
              <dt>Total</dt><dd>{formatCents(c.totalCents)}</dd>
              <dt>Stage</dt><dd>{c.stage === 'first' ? 'First approval' : 'Second approval'}</dd>
              <dt>Submitted</dt><dd>{new Date(c.submittedAt).toLocaleDateString()}</dd>
            </dl>
            {c.overLimitCount > 0 && <p>{`Over limit (${c.overLimitCount})`}</p>}
            {c.duplicateCount > 0 && <p>{`Possible duplicate (${c.duplicateCount})`}</p>}
            <ol className="plain">
              {c.lines.map((l) => (
                <li key={l.position}>
                  {`${l.position}. ${l.description} ${formatCents(l.amountCents)}`}
                  {l.receipts.map((r) => <span key={r.id}> <a href={`/api/claims/${c.id}/receipts/${r.id}`}>{`Receipt ${r.originalName ?? ''}`.trim()}</a></span>)}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}
