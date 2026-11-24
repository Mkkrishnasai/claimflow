import { expect, test } from 'vitest';
import { activeHref, navFor } from './nav';

const labels = (role: string) => navFor({ id: 'u1', role }).map((i) => i.label);

test('navFor lists exactly the items for each role', () => {
  expect(labels('employee')).toEqual(['My claims', 'My account']);
  expect(labels('manager')).toEqual(['My claims', 'Approvals', 'My account']);
  expect(labels('finance')).toEqual(['My claims', 'Payments', 'Policy', 'Export', 'My account']);
  expect(labels('admin')).toEqual(['My claims', 'Users', 'My account']);
});
test('navFor points My account at /users/:id and Users at /users', () => {
  const items = navFor({ id: 'u1', role: 'admin' });
  expect(items.map((i) => i.href)).toEqual(['/claims', '/users', '/users/u1']);
});
test('activeHref picks the longest matching item', () => {
  const admin = navFor({ id: 'u1', role: 'admin' });
  expect(activeHref('/users', admin)).toBe('/users');
  expect(activeHref('/users/u1', admin)).toBe('/users/u1');
  expect(activeHref('/users/other', admin)).toBe('/users');
  expect(activeHref('/claims/new', admin)).toBe('/claims');
  expect(activeHref('/approvals', navFor({ id: 'u1', role: 'manager' }))).toBe('/approvals');
  expect(activeHref('/approvals/c1', navFor({ id: 'u1', role: 'manager' }))).toBe('/approvals');
  expect(activeHref('/nope', admin)).toBeUndefined();
});
