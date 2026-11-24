import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SessionUser } from '../api';
import type { ListUser } from './UsersList';
import { Alert, Button, FlagBadge, PageHeader, Select } from '../ui/components';

interface Detail extends ListUser { reports: { id: string; name: string }[]; lockedUntil: string | null; passwordSet: boolean }

export default function UserDetail({ id, viewer }: { id: string; viewer: SessionUser }) {
  const admin = viewer.role === 'admin';
  const [u, setU] = useState<Detail | null>(null);
  const [managers, setManagers] = useState<ListUser[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(() => api<Detail>(`/users/${id}`).then(setU).catch((e) => setError(e instanceof ApiError && e.status === 403 ? 'Access denied.' : 'Could not load user.')), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (admin) api<ListUser[]>('/users').then((l) => setManagers(l.filter((m) => m.role === 'manager' && m.active))).catch(() => {}); }, [admin]);
  useEffect(() => { document.querySelector('h1')?.focus(); }, [u, error]);

  // One runner for all three actions: clear messages, report the API reason in the alert.
  async function run(f: () => Promise<void>) {
    setError(''); setNote('');
    try { await f(); await load(); } catch (e) {
      setError(e instanceof ApiError ? (e.status === 502 ? 'Email could not be sent. Try Resend link.' : e.reason ?? e.code) : 'Request failed.');
      load();
    }
  }
  const setManager = (managerId: string) => run(async () => { await api(`/users/${id}/manager`, 'PATCH', { managerId: managerId || null }); });
  const resend = () => run(async () => { await api(`/users/${id}/resend-link`, 'POST'); setNote('Link sent.'); });
  const deactivate = () => run(async () => {
    const r = await api<{ reassignedClaims: number; notified: number }>(`/users/${id}/deactivate`, 'POST');
    setNote(`${r.reassignedClaims} moved / ${r.notified} notified`);
  });

  return (
    <section>
      <PageHeader title="User detail" />
      {error && <Alert>{error}</Alert>}
      {note && <Alert role="status" tone="info">{note}</Alert>}
      {u && (
        <>
          <dl>
            <dt>Name</dt><dd>{u.name}</dd>
            <dt>Email</dt><dd>{u.email}</dd>
            <dt>Role</dt><dd>{u.role}</dd>
            <dt>Manager</dt><dd>{u.managerName ?? 'None'}{u.managerInactive && <FlagBadge>(manager inactive)</FlagBadge>}</dd>
            <dt>State</dt><dd>{u.active ? 'Active' : 'Inactive'}</dd>
            <dt>Reports</dt><dd>{u.reports.length ? u.reports.map((r) => r.name).join(', ') : 'None'}</dd>
            <dt>Lock state</dt><dd>{u.lockedUntil ? `Locked until ${new Date(u.lockedUntil).toLocaleString()}` : 'Not locked'}</dd>
          </dl>
          {admin && (
            <>
              <Select id="manager" label="Manager" value={u.managerId ?? ''} onChange={(e) => setManager(e.target.value)}>
                <option value="">None</option>
                {managers.filter((m) => m.id !== u.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                {u.managerId && !managers.some((m) => m.id === u.managerId) && <option value={u.managerId}>{u.managerName}</option>}
              </Select>
              {!u.passwordSet && u.active && <Button variant="secondary" onClick={resend}>Resend link</Button>}
              {u.active && <Button variant="danger" onClick={deactivate}>Deactivate</Button>}
            </>
          )}
        </>
      )}
      {admin && <p><a href="/users">Back to users</a></p>}
    </section>
  );
}
