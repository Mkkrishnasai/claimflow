import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export type LinkKind = 'set_password' | 'reset';
export interface Mailer {
  linkMail(kind: LinkKind, to: string, url: string): Promise<void>;
  reassignedMail(to: string, claimId: string): Promise<void>;
  notifyMail(to: string, subject: string, text: string): Promise<void>;
}

const SUBJECT: Record<LinkKind, string> = { set_password: 'Set your ClaimFlow password', reset: 'Reset your ClaimFlow password' };

// C-19. Timeouts 5/5/10 s; failures throw and the caller maps them to 502 smtp_unavailable (ADR-4). Retry lives in the notify dispatcher (C-40); notifyMail throws and the dispatcher records it.
export function createMailer(config: Pick<Config, 'smtp'>): Mailer {
  const { host, port, user, pass } = config.smtp;
  const transport = nodemailer.createTransport({
    host, port, secure: false, ignoreTLS: !user, requireTLS: process.env.NODE_ENV === 'production',
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
  });
  return {
    async linkMail(kind, to, url) {
      await transport.sendMail({
        from: 'ClaimFlow <no-reply@claimflow.local>', to, subject: SUBJECT[kind],
        text: `Use this link within ${kind === 'reset' ? '1 hour' : '24 hours'}: ${url}\n`, // wording provisional (Q-6)
      });
    },
    async reassignedMail(to, claimId) {
      await transport.sendMail({
        from: 'ClaimFlow <no-reply@claimflow.local>', to, subject: 'Your claim has a new approver',
        text: `Claim ${claimId} now waits on a different approver because the previous one left.\n`,
      });
    },
    async notifyMail(to, subject, text) {
      await transport.sendMail({ from: 'ClaimFlow <no-reply@claimflow.local>', to, subject, text });
    },
  };
}
