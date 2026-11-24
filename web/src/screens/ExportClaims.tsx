import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

const URL_ = '/api/exports/paid-claims.csv';

// Single fetch helper; failures become ApiError so the screen shows `reason ?? code`.
async function request(qs: string): Promise<Response> {
  const res = await fetch(`${URL_}${qs}`, { credentials: 'same-origin' });
  if (res.ok) return res;
  if (res.status === 401) await api('/auth/session').catch(() => {}); // fires the existing onUnauthorized path (api.ts unchanged)
  const d = await res.json().catch(() => null);
  throw new ApiError(res.status, d?.error ?? 'error', d?.reason);
}

export const filenameOf = (cd: string | null, from: string, to: string) => cd?.match(/filename="([^"]+)"/)?.[1] ?? `paid-claims-${from}-to-${to}.csv`;

export default function ExportClaims() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Finance is validated by the API: a bare request is 403 for everyone else, 422 (missing dates) for finance.
  useEffect(() => {
    request('').then(() => setAllowed(true), (e) => {
      if (e instanceof ApiError && e.status === 403) { setError('Access denied'); setAllowed(false); }
      else setAllowed(true);
    });
  }, []);
  useEffect(() => { if (allowed !== null) document.querySelector('h1')?.focus(); }, [allowed]);

  const valid = !!from && !!to && from <= to;
  const download = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!valid || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const res = await request(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const name = filenameOf(res.headers.get('content-disposition'), from, to);
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(href);
    } catch (x) { setError(x instanceof ApiError ? x.reason ?? x.code : 'Download failed.'); }
    finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <section>
      <h1 tabIndex={-1}>Export paid claims</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {allowed && (
        <form onSubmit={download}>
          <div><label htmlFor="x-from">From</label><input id="x-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label htmlFor="x-to">To</label><input id="x-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
          <button type="submit" disabled={!valid || busy}>Download CSV</button>
        </form>
      )}
    </section>
  );
}
