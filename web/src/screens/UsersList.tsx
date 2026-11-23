import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

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
      <h1 tabIndex={-1}>Users</h1>
      {error && <p role="alert" className="error">{error}</p>}
      <ul className="cards">
        {users?.map((u) => (
          <li key={u.id}>
            <h2><a href={`/users/${u.id}`}>{u.name}</a></h2>
            <dl>
              <dt>Email</dt><dd>{u.email}</dd>
              <dt>Role</dt><dd>{u.role}</dd>
              <dt>Manager</dt><dd>{u.managerName ?? 'None'}{u.managerInactive && <strong className="flag"> (manager inactive)</strong>}</dd>
              <dt>State</dt><dd>{u.active ? 'Active' : 'Inactive'}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
