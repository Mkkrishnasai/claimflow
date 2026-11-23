// Matrix fixture list: every claim / user-data route the matrix test exercises.
export const COVERED = [
  'GET /users', 'GET /users/:id', 'POST /users', 'PATCH /users/:id/manager', 'POST /users/:id/resend-link',
  'POST /__test/fixtures/claims', 'GET /__test/claims/:id',
];
