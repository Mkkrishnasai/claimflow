import express, { Router } from 'express';

export const testRouter: Router = Router();

testRouter.post('/__test/echo', express.json({ limit: '100kb' }), (_req, res) => {
  res.status(200).json({ ok: true });
});

testRouter.get('/__test/error', (req, res, next) => {
  const q = (k: string) => String(req.query[k] ?? '');
  const ctx = { password: q('password'), receipt: q('receipt'), bankAccount: q('bankAccount') };
  const err = new Error(`test error ${ctx.password} ${ctx.receipt} ${ctx.bankAccount}`, {
    cause: new Error(`cause ${ctx.password} ${ctx.receipt} ${ctx.bankAccount}`),
  });
  Object.assign(err, { context: ctx });
  next(err);
});
