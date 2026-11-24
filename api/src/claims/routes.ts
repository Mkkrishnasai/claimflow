import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { mount, requireFinance, type RouteDef } from '../auth/authz.js';
import { HttpError } from '../middleware.js';
import { SubmitRefused } from './policy.js';
import { sniff } from './receipt-storage.js';
import { addLine, approveClaim, addReceiptRow, precheckReceipt, createClaim, deleteClaim, deleteLine, deleteReceipt, receiptForRead, editClaim, editLine, getClaim, listApprovals, listCategories, listMine, listPayments, rejectClaim, submitClaim, withdrawClaim, type ClaimDeps } from './service.js';

export const claimRouteDefs = (d: ClaimDeps): RouteDef[] => [
  // E-19
  { method: 'get', path: '/categories', data: 'none', write: false, handler: async (_req, res) => {
    res.json(await listCategories(d));
  } },
  // E-20: own claims only, whatever the caller's role
  { method: 'get', path: '/claims', data: 'claim', write: false, handler: async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated');
    res.json(await listMine(d, req.user.id, req.query));
  } },
  // E-33: the session user's pending approvals; never reads a user from the request
  { method: 'get', path: '/approvals', data: 'claim', write: false, handler: async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated');
    res.json(await listApprovals(d, req.user.id, req.query));
  } },
  // E-36: finance only, checked before the page query is parsed
  { method: 'get', path: '/payments', data: 'claim', write: false, handler: async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated');
    requireFinance(req.user);
    res.json(await listPayments(d, req.query));
  } },
  // E-21
  { method: 'post', path: '/claims', data: 'claim', write: true, handler: async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated');
    const c = await createClaim(d, req.user.id, req.body ?? {});
    res.locals.logFields = { claimEvent: 'claim_created', claimId: c.id, from: null, to: 'draft' };
    res.status(201).location(`/api/claims/${c.id}`).json(c);
  } },
  // E-22: 404 unknown, 403 not allowed (canReadClaim)
  { method: 'get', path: '/claims/:id', data: 'claim', write: false, handler: async (req, res) => {
    res.json(await getClaim(d, req.user, req.params.id as string));
  } },
  // E-23..E-27: claimant-only, authorised in the service before body validation
  { method: 'patch', path: '/claims/:id', data: 'claim', write: true, handler: async (req, res) => {
    res.json(await editClaim(d, req.user, req.params.id as string, req.body ?? {}));
  } },
  { method: 'delete', path: '/claims/:id', data: 'claim', write: true, handler: async (req, res) => {
    await dropFiles(d, res, await deleteClaim(d, req.user, req.params.id as string));
    res.status(204).end();
  } },
  { method: 'post', path: '/claims/:id/lines', data: 'claim', write: true, handler: async (req, res) => {
    res.status(201).json(await addLine(d, req.user, req.params.id as string, req.body ?? {}));
  } },
  { method: 'patch', path: '/claims/:id/lines/:lineId', data: 'claim', write: true, handler: async (req, res) => {
    res.json(await editLine(d, req.user, req.params.id as string, req.params.lineId as string, req.body ?? {}));
  } },
  { method: 'delete', path: '/claims/:id/lines/:lineId', data: 'claim', write: true, handler: async (req, res) => {
    await dropFiles(d, res, await deleteLine(d, req.user, req.params.id as string, req.params.lineId as string));
    res.status(204).end();
  } },
  // E-29: streamed only after canReadClaim; the file is opened before any header is written
  { method: 'get', path: '/claims/:id/receipts/:receiptId', data: 'claim', write: false, handler: async (req, res) => {
    const r = await receiptForRead(d, req.user, req.params.id as string, req.params.receiptId as string);
    const { size, handle } = await d.receipts.open(r.storageKey);
    res.set({ 'Content-Type': r.mime, 'Content-Length': String(size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    await pipeline(handle.createReadStream(), res);
  } },
  // E-31 / E-32: claimant-only; status is never read from the body
  { method: 'post', path: '/claims/:id/submit', data: 'claim', write: true, handler: async (req, res) => {
    let r: Awaited<ReturnType<typeof submitClaim>>;
    try { r = await submitClaim(d, req.user, req.params.id as string); } catch (e) {
      if (e instanceof SubmitRefused) res.locals.logFields = { claimEvent: 'submit_refused', claimId: req.params.id, from: e.from, to: 'submitted', failureCodes: e.failures.map((f) => f.code), failureCount: e.failures.length };
      throw e;
    }
    const { claim, ev } = r;
    res.locals.logFields = { claimEvent: ev.action, claimId: claim.id, from: ev.from, to: ev.to };
    res.json(claim);
  } },
  { method: 'post', path: '/claims/:id/withdraw', data: 'claim', write: true, handler: async (req, res) => {
    const { claim, ev } = await withdrawClaim(d, req.user, req.params.id as string, req.body ?? {});
    res.locals.logFields = { claimEvent: ev.action, claimId: claim.id, from: ev.from, to: ev.to };
    res.json(claim);
  } },
  // E-34: authority comes from approverId in the database; the body is never read
  { method: 'post', path: '/claims/:id/approve', data: 'claim', write: true, handler: async (req, res) => {
    const { claim, ev } = await approveClaim(d, req.user, req.params.id as string);
    res.locals.logFields = { claimEvent: ev.action, claimId: claim.id, from: ev.from, to: ev.to };
    res.json(claim);
  } },
  // E-35: same authority rules as approve; only `reason` is read from the body
  { method: 'post', path: '/claims/:id/reject', data: 'claim', write: true, handler: async (req, res) => {
    const { claim, ev } = await rejectClaim(d, req.user, req.params.id as string, req.body ?? {});
    res.locals.logFields = { claimEvent: ev.action, claimId: claim.id, from: ev.from, to: ev.to };
    res.json(claim);
  } },
  // E-30
  { method: 'delete', path: '/claims/:id/receipts/:receiptId', data: 'claim', write: true, handler: async (req, res) => {
    await dropFiles(d, res, await deleteReceipt(d, req.user, req.params.id as string, req.params.receiptId as string));
    res.status(204).end();
  } },
];

// After commit: a failed removal leaves an orphan file, never a failed request; only a count is logged.
async function dropFiles(d: ClaimDeps, res: Response, keys: string[]) {
  const results = await Promise.allSettled(keys.map((k) => d.receipts.remove(k)));
  const orphans = results.filter((x) => x.status === 'rejected').length;
  if (orphans) res.locals.logFields = { ...res.locals.logFields, orphanFiles: orphans };
}

export const claimRoutes = (d: ClaimDeps): Router => mount(Router(), claimRouteDefs(d));

const MAX_BYTES = 10 * 1024 * 1024;
const SLOTS = 4; // NFR-PERF-2: at most 4 bodies buffered at once
let busy = 0;
const waiting: (() => void)[] = [];
const acquire = async () => { if (busy >= SLOTS) await new Promise<void>((r) => waiting.push(r)); else busy++; };
const release = () => { const n = waiting.shift(); if (n) n(); else busy--; };

// Buffers up to MAX_BYTES; past that keeps draining (discarding) so the client gets the 413, not a reset.
// A declared Content-Length is preallocated so peak memory is one copy; chunked bodies fall back to concat.
async function readBody(req: Request): Promise<Buffer | null> {
  const declared = Number(req.get('content-length'));
  let buf = Number.isInteger(declared) && declared > 0 && declared <= MAX_BYTES ? Buffer.allocUnsafe(declared) : null;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    if (n + c.length <= MAX_BYTES) {
      if (buf && n + c.length <= buf.length) c.copy(buf, n); else { if (buf) { chunks.push(buf.subarray(0, n)); buf = null; } chunks.push(c); }
    } else chunks.length = 0;
    n += c.length;
  }
  if (n > MAX_BYTES) return null;
  return buf && n === buf.length ? buf : Buffer.concat(buf ? [buf.subarray(0, n)] : chunks, n);
}
const TOO_LARGE = new HttpError(413, 'receipt_too_large', 'Receipt must be 10 MB or smaller');
const cleanName = (h: string | undefined): string | null => {
  if (!h) return null;
  let v = h;
  try { v = decodeURIComponent(h); } catch { /* keep raw */ }
  return v.replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 200) || null;
};

// E-28. Raw body; mounted after authenticate and before every JSON parser.
export const receiptUploadDefs = (d: ClaimDeps): RouteDef[] => [
  { method: 'post', path: '/claims/:id/lines/:lineId/receipts', data: 'claim', write: true, handler: async (req, res) => {
    const id = req.params.id as string, lineId = req.params.lineId as string;
    await precheckReceipt(d, req.user, id, lineId);
    const declared = Number(req.get('content-length') ?? 0);
    if (declared > MAX_BYTES) { await readBody(req); throw TOO_LARGE; }
    let stored: { storageKey: string; sha256: string; sizeBytes: number; mime: string };
    await acquire(); // the slot is held until the bytes are on disk, so the buffer is bounded
    try {
      const body = await readBody(req);
      if (!body) throw TOO_LARGE;
      if (body.length === 0) throw new HttpError(422, 'receipt_empty', 'Receipt must not be empty');
      const mime = sniff(body);
      if (!mime) throw new HttpError(422, 'receipt_invalid_type', 'Receipt must be a JPEG, PNG or PDF file');
      stored = { storageKey: await d.receipts.put(body), sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length, mime };
    } finally { release(); }
    try {
      res.status(201).json(await addReceiptRow(d, req.user, id, lineId, { ...stored, originalName: cleanName(req.get('x-filename')) }));
    } catch (e) {
      await d.receipts.remove(stored.storageKey);
      throw e;
    }
  } },
];
export const receiptUploadRoutes = (d: ClaimDeps): Router => mount(Router(), receiptUploadDefs(d));
