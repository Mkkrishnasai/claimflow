import bcrypt from 'bcryptjs';
import { PrismaClient, type Role } from '@prisma/client';
import { loadDotenv } from '../api/src/env.js';
import { checkSeedGuards } from './seed-guards.js';

loadDotenv();

const failure = checkSeedGuards(process.env);
if (failure) {
  console.error(`${failure.code}: ${failure.message}`);
  process.exit(1);
}

const password = process.env.SEED_PASSWORD as string;
const SM = 'senior.manager@claimflow.test';
const MGR = 'manager@claimflow.test';
const users: { email: string; role: Role; manager: string | null }[] = [
  { email: SM, role: 'manager', manager: null },
  { email: MGR, role: 'manager', manager: SM },
  { email: 'employee@claimflow.test', role: 'employee', manager: MGR },
  { email: 'finance@claimflow.test', role: 'finance', manager: SM },
  { email: 'admin@claimflow.test', role: 'admin', manager: SM },
];

const prisma = new PrismaClient();
try {
  // cost 12: PRD NFR-SEC-1 (>=12)
  const hashes = await Promise.all(users.map(() => bcrypt.hash(password, 12)));
  await prisma.$transaction(async (tx) => {
    const ids = new Map<string, string>();
    for (const [i, u] of users.entries()) { // ordered: managers first
      const row = await tx.user.upsert({
        where: { email: u.email },
        update: {}, // never overwrite existing rows
        create: {
          email: u.email,
          role: u.role,
          passwordHash: hashes[i],
          managerId: u.manager ? ids.get(u.manager)! : null,
        },
      });
      ids.set(u.email, row.id);
    }
  });
} finally {
  await prisma.$disconnect();
}
