// Matrix fixture list: every claim / user-data route the matrix test exercises.
export const COVERED = [
  'GET /users', 'GET /users/:id', 'POST /users', 'PATCH /users/:id/manager', 'POST /users/:id/resend-link', 'POST /users/:id/deactivate',
  'POST /__test/fixtures/claims', 'GET /__test/claims/:id',
  'GET /claims', 'POST /claims', 'GET /claims/:id',
];
