import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { formatCents } from '../money';
import { EmptyState, FlagBadge, PageHeader, StatusBadge, Table, Tiles, type Column } from '../ui/components';

interface Item { id: string; title: string; claimant: { id: string; name: string }; readyAt: string; totalCents: number; lineCount: number; overLimitCount: number; duplicateCount: number }
interface Queue { count: number; totalCents: number; items: Item[] }

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

const columns: Column<Item>[] = [
  { key: 'title', header: 'Claim', primary: true, cell: (c) => <a href={`/payments/${c.id}`}>{c.title}</a> },
  { key: 'claimant', header: 'Claimant', cell: (c) => <span className="cell-who"><span className="avatar avatar--sm" aria-hidden="true">{initials(c.claimant.name)}</span>{c.claimant.name}</span> },
  { key: 'status', header: 'Status', cell: () => <StatusBadge status="ready_to_pay" /> }, // no stage on payments rows (Open Question 3)
  { key: 'flags', header: 'Flags', cell: (c) => <>
    {c.overLimitCount > 0 && <FlagBadge>{`Over limit (${c.overLimitCount})`}</FlagBadge>}
    {c.duplicateCount > 0 && <FlagBadge>{`Possible duplicate (${c.duplicateCount})`}</FlagBadge>}
    {c.overLimitCount === 0 && c.duplicateCount === 0 && <span className="muted">None</span>}
  </> },
  { key: 'ready', header: 'Ready since', cell: (c) => new Date(c.readyAt).toLocaleDateString() },
  { key: 'lines', header: 'Lines', cell: (c) => c.lineCount },
  { key: 'total', header: 'Total', numeric: true, cell: (c) => formatCents(c.totalCents) },
];

export default function Payments() {
  const [q, setQ] = useState<Queue | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Queue>('/payments').then(setQ).catch((e) => setError(e instanceof ApiError && e.status === 403 ? 'Access denied' : 'Could not load payments.'));
  }, []);
  useEffect(() => { if (q || error) document.querySelector('h1')?.focus(); }, [q, error]);

  const flagged = (q?.items ?? []).filter((c) => c.overLimitCount > 0 || c.duplicateCount > 0).length;
  return (
    <section>
      <PageHeader eyebrow="Finance" title="Payments" subtitle="Fully approved claims ready to be paid." />
      {error && <p role="alert" className="error">{error}</p>}
      {q?.items.length === 0 && <EmptyState text="No claims waiting for payment" />}
      {!!q?.items.length && (
        <>
          <Tiles items={[
            { label: 'Ready to pay', value: q.count, tone: 'teal' },
            { label: 'Total', value: formatCents(q.totalCents), money: true, tone: 'violet' },
            { label: 'Flagged', value: flagged, tone: 'amber' },
          ]} />
          <div className="panel">
            <div className="panel__head"><h2 id="queue-h">Payment queue</h2></div>
            <div className="table-scroll"><Table columns={columns} rows={q.items} rowKey={(c) => c.id} labelledBy="queue-h" /></div>
          </div>
        </>
      )}
    </section>
  );
}
