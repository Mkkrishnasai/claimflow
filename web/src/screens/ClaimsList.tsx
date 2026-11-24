import { useEffect, useState } from 'react';
import { Plus, Receipt } from 'lucide-react';
import { api } from '../api';
import { formatCents } from '../money';
import { Button, EmptyState, PageHeader, StatusBadge, Table, Tiles, type Column } from '../ui/components';

interface Row { id: string; title: string; status: string; totalCents: number; updatedAt: string }

const columns: Column<Row>[] = [
  { key: 'title', header: 'Claim', primary: true, cell: (c) => <span className="cell-title"><span className="icon-tile" aria-hidden="true"><Receipt size={18} /></span><a href={`/claims/${c.id}`}>{c.title}</a></span> },
  { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
  { key: 'updated', header: 'Last updated', cell: (c) => new Date(c.updatedAt).toLocaleString() },
  { key: 'total', header: 'Total', numeric: true, cell: (c) => formatCents(c.totalCents) },
];

// Client-side filter over the list already loaded; no new API.
const FILTERS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'draft', label: 'Drafts', match: (s) => s === 'draft' },
  { key: 'approval', label: 'In approval', match: (s) => s === 'submitted' || s === 'approved' },
  { key: 'ready', label: 'Ready to pay', match: (s) => s === 'ready_to_pay' },
  { key: 'paid', label: 'Paid', match: (s) => s === 'paid' },
];

export default function ClaimsList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  useEffect(() => { api<Row[]>('/claims').then(setRows).catch(() => setError('Could not load claims.')); }, []);
  useEffect(() => { document.querySelector('h1')?.focus(); }, [rows, error]);

  const newClaim = <Button href="/claims/new" icon={<Plus aria-hidden="true" size={16} />}>New claim</Button>;
  const sum = (f: (s: string) => boolean) => {
    const r = (rows ?? []).filter((c) => f(c.status));
    return { n: r.length, cents: r.reduce((s, c) => s + c.totalCents, 0) };
  };
  const all = sum(() => true);
  const inApproval = sum((s) => s === 'submitted' || s === 'approved');
  const ready = sum((s) => s === 'ready_to_pay');
  const paid = sum((s) => s === 'paid');
  const count = (n: number) => `${n} ${n === 1 ? 'claim' : 'claims'}`;
  const active = FILTERS.find((f) => f.key === filter)!;
  const shown = (rows ?? []).filter((c) => active.match(c.status));

  return (
    <section>
      <PageHeader eyebrow="Claims" title="My claims" subtitle="Track every claim from draft to paid." actions={rows?.length ? newClaim : undefined} />
      {error && <p role="alert" className="error">{error}</p>}
      {rows?.length === 0 && <EmptyState text="No claims yet" action={newClaim} />}
      {!!rows?.length && (
        <>
          <Tiles items={[
            { label: 'Total claimed', value: formatCents(all.cents), money: true, sub: count(all.n), tone: 'violet' },
            { label: 'In approval', value: formatCents(inApproval.cents), money: true, sub: count(inApproval.n), tone: 'blue' },
            { label: 'Ready to pay', value: formatCents(ready.cents), money: true, sub: count(ready.n), tone: 'teal' },
            { label: 'Paid', value: formatCents(paid.cents), money: true, sub: count(paid.n), tone: 'green' },
          ]} />
          <div className="panel">
            <div className="panel__head">
              <h2 id="claims-h">{active.key === 'all' ? 'All claims' : active.label}</h2>
              <div className="filters" role="group" aria-label="Filter by status">
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" aria-pressed={f.key === filter} onClick={() => setFilter(f.key)}>{f.label}</button>
                ))}
              </div>
            </div>
            {shown.length
              ? <div className="table-scroll"><Table columns={columns} rows={shown} rowKey={(c) => c.id} labelledBy="claims-h" /></div>
              : <p className="panel__body muted">No claims in this view.</p>}
          </div>
        </>
      )}
    </section>
  );
}
