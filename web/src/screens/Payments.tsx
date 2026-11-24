import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { formatCents } from '../money';
import { EmptyState, FlagBadge, PageHeader, StatusBadge, Table, type Column } from '../ui/components';

interface Item { id: string; title: string; claimant: { id: string; name: string }; readyAt: string; totalCents: number; lineCount: number; overLimitCount: number; duplicateCount: number }
interface Queue { count: number; totalCents: number; items: Item[] }

const columns: Column<Item>[] = [
  { key: 'title', header: 'Claim', primary: true, cell: (c) => <a href={`/payments/${c.id}`}>{c.title}</a> },
  { key: 'claimant', header: 'Claimant', cell: (c) => c.claimant.name },
  { key: 'total', header: 'Total', numeric: true, cell: (c) => formatCents(c.totalCents) },
  { key: 'status', header: 'Status', cell: () => <StatusBadge status="ready_to_pay" /> }, // no stage on payments rows (Open Question 3)
  { key: 'flags', header: 'Flags', cell: (c) => <>
    {c.overLimitCount > 0 && <FlagBadge>{`Over limit (${c.overLimitCount})`}</FlagBadge>}
    {c.duplicateCount > 0 && <FlagBadge>{`Possible duplicate (${c.duplicateCount})`}</FlagBadge>}
  </> },
  { key: 'ready', header: 'Ready', cell: (c) => new Date(c.readyAt).toLocaleDateString() },
  { key: 'lines', header: 'Lines', cell: (c) => c.lineCount },
];

export default function Payments() {
  const [q, setQ] = useState<Queue | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Queue>('/payments').then(setQ).catch((e) => setError(e instanceof ApiError && e.status === 403 ? 'Access denied' : 'Could not load payments.'));
  }, []);
  useEffect(() => { if (q || error) document.querySelector('h1')?.focus(); }, [q, error]);

  return (
    <section>
      <PageHeader title="Payments" />
      {error && <p role="alert" className="error">{error}</p>}
      {q?.items.length === 0 && <EmptyState text="No claims waiting for payment" />}
      {!!q?.items.length && (
        <>
          <dl className="summary">
            <div><dt>Ready to pay</dt><dd>{q.count}</dd></div>
            <div><dt>Total</dt><dd className="num">{formatCents(q.totalCents)}</dd></div>
          </dl>
          <Table columns={columns} rows={q.items} rowKey={(c) => c.id} />
        </>
      )}
    </section>
  );
}
