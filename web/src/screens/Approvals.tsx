import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCents } from '../money';
import { stageStatus } from '../ui/labels';
import { Card, EmptyState, FlagBadge, PageHeader, StatusBadge } from '../ui/components';

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
      <PageHeader title="Approvals" />
      {error && <p role="alert" className="error">{error}</p>}
      {rows?.length === 0 && <EmptyState text="No claims waiting" />}
      {!!rows?.length && (
        <dl className="summary">
          <div><dt>Waiting</dt><dd>{rows.length}</dd></div>
          <div><dt>Total</dt><dd className="num">{formatCents(rows.reduce((s, c) => s + c.totalCents, 0))}</dd></div>
        </dl>
      )}
      <ul className="cards">
        {rows?.map((c) => (
          <Card as="li" key={c.id}>
            <h2><a href={`/approvals/${c.id}`}>{c.title}</a></h2>
            <dl>
              <dt>Claimant</dt><dd>{c.claimant.name}</dd>
              <dt>Total</dt><dd className="num">{formatCents(c.totalCents)}</dd>
              <dt>Stage</dt><dd>{c.stage === 'first' ? 'First approval' : 'Second approval'}</dd>
              <dt>Status</dt><dd><StatusBadge status={stageStatus(c.stage)} /></dd>
              <dt>Submitted</dt><dd>{new Date(c.submittedAt).toLocaleDateString()}</dd>
            </dl>
            {c.overLimitCount > 0 && <FlagBadge>{`Over limit (${c.overLimitCount})`}</FlagBadge>}
            {c.duplicateCount > 0 && <FlagBadge>{`Possible duplicate (${c.duplicateCount})`}</FlagBadge>}
            <ol className="plain">
              {c.lines.map((l) => (
                <li key={l.position}>
                  {`${l.position}. ${l.description} ${formatCents(l.amountCents)}`}
                  {l.receipts.map((r) => <span key={r.id}> <a href={`/api/claims/${c.id}/receipts/${r.id}`}>{`Receipt ${r.originalName ?? ''}`.trim()}</a></span>)}
                </li>
              ))}
            </ol>
          </Card>
        ))}
      </ul>
    </section>
  );
}
