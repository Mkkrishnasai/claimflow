import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Alert, FlagBadge, PageHeader, Table } from '../ui/components';

export interface ListUser { id: string; name: string; email: string; role: string; managerId: string | null; managerName: string | null; active: boolean; managerInactive: boolean }

export default function UsersList() {
  const [users, setUsers] = useState<ListUser[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<ListUser[]>('/users').then(setUsers).catch((e) => setError(e instanceof ApiError && e.status === 403 ? 'Access denied. Only admins can view the users list.' : 'Could not load users.'));
  }, []);
  useEffect(() => { document.querySelector('h1')?.focus(); }, [users, error]);

  return (
    <section>
      <PageHeader title="Users" />
      {error && <Alert>{error}</Alert>}
      {users && <Table<ListUser> rowKey={(u) => u.id} rows={users} columns={[
        { key: 'name', header: 'Name', primary: true, cell: (u) => <a href={`/users/${u.id}`}>{u.name}</a> },
        { key: 'email', header: 'Email', cell: (u) => u.email },
        { key: 'role', header: 'Role', cell: (u) => u.role },
        { key: 'manager', header: 'Manager', cell: (u) => <>{u.managerName ?? 'None'}{u.managerInactive && <FlagBadge>(manager inactive)</FlagBadge>}</> },
        { key: 'state', header: 'State', cell: (u) => (u.active ? 'Active' : 'Inactive') },
      ]} />}
    </section>
  );
}
