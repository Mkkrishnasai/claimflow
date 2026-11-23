export interface SessionUser { id: string; name: string; role: string; csrfToken: string }
export class ApiError extends Error {
  constructor(public status: number, public code: string, public reason?: string) { super(code); }
}

let csrf: string | null = null; // session CSRF token, kept in memory (arch ADR-14)
let on401: () => void = () => {};
export const setCsrf = (t: string | null) => { csrf = t; };
export const onUnauthorized = (f: () => void) => { on401 = f; };

// Same-origin cookies; X-CSRF-Token on writes. Before sign-in the token comes from /api/auth/csrf (csrf_pre cookie).
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown, opts: { quiet401?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    let t = csrf;
    if (!t) t = ((await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()) as { csrfToken: string }).csrfToken;
    headers['x-csrf-token'] = t;
  }
  const res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) { setCsrf(null); on401(); }
    throw new ApiError(res.status, data?.error ?? 'error', data?.reason);
  }
  return data as T;
}
