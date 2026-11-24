import { useEffect, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { api } from '../api';
import { formatCents } from '../money';
import { stageStatus } from '../ui/labels';
import { Card, EmptyState, FlagBadge, PageHeader, StatusBadge, Tiles } from '../ui/components';

interface Receipt { id: string; originalName: string | null }
interface Line { position: number; description: string; amountCents: number; receipts: Receipt[] }
interface Row { id: string; title: string; claimant: { id: string; name: string }; stage: 'first' | 'second'; submittedAt: string; totalCents: number; overLimitCount: number; duplicateCount: number; lines: Line[] }

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export default function Approvals() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Row[]>('/approvals').then(setRows).catch(() => setError('Could not load approvals.')); }, []);
  useEffect(() => { if (rows || error) document.querySelector('h1')?.focus(); }, [rows, error]);

  const flagged = (rows ?? []).filter((c) => c.overLimitCount > 0 || c.duplicateCount > 0).length;
  return (
    <section>
      <PageHeader eyebrow="Team" title="Approvals" subtitle="Claims from your reports waiting for your decision." />
      {error && <p role="alert" className="error">{error}</p>}
      {rows?.length === 0 && <EmptyState text="No claims waiting" />}
      {!!rows?.length && (
        <Tiles items={[
          { label: 'Waiting', value: rows.length, tone: 'blue' },
          { label: 'Total', value: formatCents(rows.reduce((s, c) => s + c.totalCents, 0)), money: true, tone: 'violet' },
          { label: 'Flagged', value: flagged, tone: 'amber' },
        ]} />
      )}
      <ul className="cards">
        {rows?.map((c) => (
          <Card as="li" key={c.id} className="approval">
            <div className="approval__row">
              <span className="avatar" aria-hidden="true">{initials(c.claimant.name)}</span>
              <div className="approval__who">
                <h2><a href={`/approvals/${c.id}`}>{c.title}</a></h2>
                <span className="muted"><span>{c.claimant.name}</span> · submitted {new Date(c.submittedAt).toLocaleDateString()}</span>
              </div>
              <span className="muted">{c.stage === 'first' ? 'First approval' : 'Second approval'}</span>
              <StatusBadge status={stageStatus(c.stage)} />
              <span className="approval__total">{formatCents(c.totalCents)}</span>
            </div>
            <div className="approval__meta">
              {c.overLimitCount > 0 && <FlagBadge>{`Over limit (${c.overLimitCount})`}</FlagBadge>}
              {c.duplicateCount > 0 && <FlagBadge>{`Possible duplicate (${c.duplicateCount})`}</FlagBadge>}
              <ol className="plain">
                {c.lines.map((l) => (
                  <li key={l.position}>
                    {`${l.position}. ${l.description} ${formatCents(l.amountCents)}`}
                    {l.receipts.map((r) => <span key={r.id}> <a className="receipt-chip" href={`/api/claims/${c.id}/receipts/${r.id}`}><Paperclip aria-hidden="true" size={14} />{`Receipt ${r.originalName ?? ''}`.trim()}</a></span>)}
                  </li>
                ))}
              </ol>
            </div>
          </Card>
        ))}
      </ul>
    </section>
  );
}
