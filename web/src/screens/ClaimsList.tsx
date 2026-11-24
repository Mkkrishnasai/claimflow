import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCents } from '../money';
import { Button, EmptyState, PageHeader, StatusBadge, Table, type Column } from '../ui/components';

interface Row { id: string; title: string; status: string; totalCents: number; updatedAt: string }

const columns: Column<Row>[] = [
  { key: 'title', header: 'Title', primary: true, cell: (c) => <a href={`/claims/${c.id}`}>{c.title}</a> },
  { key: 'total', header: 'Total', numeric: true, cell: (c) => formatCents(c.totalCents) },
  { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
  { key: 'updated', header: 'Last updated', cell: (c) => new Date(c.updatedAt).toLocaleString() },
];

export default function ClaimsList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Row[]>('/claims').then(setRows).catch(() => setError('Could not load claims.')); }, []);
  useEffect(() => { document.querySelector('h1')?.focus(); }, [rows, error]);

  const newClaim = <Button href="/claims/new">New claim</Button>;
  return (
    <section>
      <PageHeader title="My claims" actions={rows?.length ? newClaim : undefined} />
      {error && <p role="alert" className="error">{error}</p>}
      {rows?.length === 0 && <EmptyState text="No claims yet" action={newClaim} />}
      {!!rows?.length && (
        <>
          <dl className="summary">
            <div><dt>Claims</dt><dd>{rows.length}</dd></div>
            <div><dt>Total</dt><dd className="num">{formatCents(rows.reduce((s, c) => s + c.totalCents, 0))}</dd></div>
          </dl>
          <Table columns={columns} rows={rows} rowKey={(c) => c.id} />
        </>
      )}
    </section>
  );
}
