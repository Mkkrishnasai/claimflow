// Matrix fixture list: every claim / user-data route the matrix test exercises.
export const COVERED = [
  'GET /users', 'GET /users/:id', 'POST /users', 'PATCH /users/:id/manager', 'POST /users/:id/resend-link', 'POST /users/:id/deactivate',
  'POST /__test/fixtures/claims', 'GET /__test/claims/:id',
  'GET /claims', 'GET /approvals', 'GET /payments', 'POST /claims', 'GET /claims/:id',
  'PATCH /claims/:id', 'DELETE /claims/:id', 'POST /claims/:id/lines', 'PATCH /claims/:id/lines/:lineId', 'DELETE /claims/:id/lines/:lineId', 'POST /claims/:id/lines/:lineId/receipts', 'GET /claims/:id/receipts/:receiptId', 'DELETE /claims/:id/receipts/:receiptId', 'POST /claims/:id/submit', 'POST /claims/:id/withdraw', 'POST /claims/:id/approve', 'POST /claims/:id/reject', 'POST /claims/:id/pay',
];
