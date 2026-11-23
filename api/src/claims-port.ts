import type { Tx } from './db.js';

export type ClaimStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid';
export interface Claim { id: string; claimantId: string; approverId: string | null; status: ClaimStatus }

// C-20. Methods take tx (ADR-18); S9 uses listWaitingOn and reassign.
export interface ClaimStore {
  get(tx: Tx, id: string): Promise<Claim | null>;
  listWaitingOn(tx: Tx, userId: string): Promise<Claim[]>;
  reassign(tx: Tx, ids: string[], approverId: string): Promise<void>;
}

export const NoClaimStore: ClaimStore = {
  get: async () => null,
  listWaitingOn: async () => [],
  reassign: async () => undefined,
};

// NODE_ENV=test only. ponytail: in-memory; the real Claim table replaces it in the first claims epic.
export class FixtureClaimStore implements ClaimStore {
  private rows = new Map<string, Claim>();
  private seq = 0;
  add(c: Omit<Claim, 'id'> & { id?: string }): Claim {
    const row = { ...c, id: c.id ?? `claim-${++this.seq}` };
    this.rows.set(row.id, row);
    return row;
  }
  reset(): void { this.rows.clear(); }
  async get(_tx: Tx, id: string) { return this.rows.get(id) ?? null; }
  async listWaitingOn(_tx: Tx, userId: string) {
    return [...this.rows.values()].filter((c) => c.approverId === userId && c.status === 'submitted');
  }
  async reassign(_tx: Tx, ids: string[], approverId: string) {
    for (const id of ids) { const c = this.rows.get(id); if (c) c.approverId = approverId; }
  }
}
