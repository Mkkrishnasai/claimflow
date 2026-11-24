import type { SessionUser } from './api';

export interface NavItem { href: string; label: string }

export const navFor = (u: Pick<SessionUser, 'id' | 'role'>): NavItem[] => [
  { href: '/claims', label: 'My claims' },
  ...(u.role === 'manager' ? [{ href: '/approvals', label: 'Approvals' }] : []),
  ...(u.role === 'finance' ? [{ href: '/payments', label: 'Payments' }, { href: '/policy', label: 'Policy' }, { href: '/export', label: 'Export' }] : []),
  ...(u.role === 'admin' ? [{ href: '/users', label: 'Users' }] : []),
  { href: `/users/${u.id}`, label: 'My account' },
];

// Longest matching href wins, so /users/<own id> is "My account" and other /users/* is "Users".
export const activeHref = (path: string, items: NavItem[]): string | undefined =>
  items.filter((i) => path === i.href || path.startsWith(i.href + '/')).sort((a, b) => b.href.length - a.href.length)[0]?.href;
