import { PrismaClient, type Prisma } from '@prisma/client';
import type { Config } from './config.js';

export type Clock = () => Date;
export type Tx = Prisma.TransactionClient;

export const createPrisma = (config: Pick<Config, 'databaseUrl'>) =>
  new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

// ADR-17: process-wide promise-queue lock; the next write starts only after the previous settles.
// Relies on Prisma's interactive-transaction timeout (5 s) to release a hung handler.
let tail: Promise<unknown> = Promise.resolve();
export function withWrite<T>(prisma: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = tail.then(() => prisma.$transaction(fn));
  tail = run.catch(() => undefined);
  return run;
}
