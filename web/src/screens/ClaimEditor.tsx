import { useEffect, useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../api';
import { formatCents, justificationFor, parseEuro } from '../money';

interface Receipt { id: string; originalName: string | null }
interface Line { key: string; id?: string; date: string; categoryCode: string; amount: string; description: string; justification: string; stored: boolean; receipts: Receipt[]; err: string; amountErr: string }
interface Category { code: string; label: string; limitCents: number }
interface ServerLine { id: string; date: string; categoryCode: string; amountCents: number; description: string; justification: string | null; receipts: Receipt[] }
interface ServerClaim { id: string; title: string; purpose: string; status: string; lines: ServerLine[] }

const MAX = 10 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
let seq = 0;
const blank = (categoryCode: string): Line => ({ key: `n${seq++}`, date: '', categoryCode, amount: '', description: '', justification: '', stored: false, receipts: [], err: '', amountErr: '' });
const euro = (c: number) => formatCents(c).slice(4);
const fromServer = (l: ServerLine): Line => ({ key: l.id, id: l.id, date: l.date, categoryCode: l.categoryCode, amount: euro(l.amountCents), description: l.description, justification: l.justification ?? '', stored: !!l.justification, receipts: l.receipts, err: '', amountErr: '' });
const reason = (e: unknown) => (e instanceof ApiError ? e.reason ?? e.code : 'Request failed.');

export default function ClaimEditor({ id, go }: { id: string; go: (to: string) => void }) {
  const [cats, setCats] = useState<Category[]>([]);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const c = await api<Category[]>('/categories');
        setCats(c);
        if (!id) setLines([blank(c[0]?.code ?? '')]);
        else {
          const claim = await api<ServerClaim>(`/claims/${id}`);
          if (claim.status !== 'draft' && claim.status !== 'rejected') { setBlocked(true); setError(`A ${claim.status} claim cannot be edited.`); }
          setTitle(claim.title); setPurpose(claim.purpose); setLines(claim.lines.map(fromServer));
        }
      } catch (e) {
        setBlocked(true);
        setError(e instanceof ApiError && (e.status === 403 || e.status === 404) ? 'Claim not found' : 'Could not load the claim.');
      }
      setReady(true);
    })();
  }, [id]);
  useEffect(() => { if (ready) document.querySelector('h1')?.focus(); }, [ready]);

  const patch = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setNote('');
    const checked = lines.map((l) => ({ l, cents: parseEuro(l.amount) }));
    setLines((ls) => ls.map((l) => ({ ...l, err: '', amountErr: parseEuro(l.amount) === null ? 'Enter an amount from 0.01 to 10000.00, such as 12.50' : '' })));
    if (checked.some((x) => x.cents === null)) return;
    const body = (l: Line, cents: number) => ({ date: l.date, categoryCode: l.categoryCode, amountCents: cents, description: l.description, justification: justificationFor(cents, cats.find((c) => c.code === l.categoryCode)?.limitCents ?? 0, l.justification) }); // CR-1: only while over the limit
    try {
      if (!id) {
        const c = await api<ServerClaim>('/claims', 'POST', { title, purpose, lines: checked.map((x) => body(x.l, x.cents!)) });
        go(`/claims/${c.id}/edit`);
        return;
      }
      await api(`/claims/${id}`, 'PATCH', { title, purpose });
      for (const rid of removed) await api(`/claims/${id}/lines/${rid}`, 'DELETE');
      setRemoved([]);
      for (const { l, cents } of checked) {
        try { await (l.id ? api(`/claims/${id}/lines/${l.id}`, 'PATCH', body(l, cents!)) : api(`/claims/${id}/lines`, 'POST', body(l, cents!))); }
        catch (err) { patch(l.key, { err: reason(err) }); return; }
      }
      const fresh = await api<ServerClaim>(`/claims/${id}`);
      setLines(fresh.lines.map(fromServer));
      setNote('Saved');
    } catch (err) { setError(reason(err)); }
  }

  async function upload(l: Line, ev: ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    if (!f || !l.id) return;
    if (f.size > MAX) return patch(l.key, { err: 'Receipt must be 10 MB or smaller' });
    if (!TYPES.includes(f.type)) return patch(l.key, { err: 'Receipt must be a JPEG, PNG or PDF file' }); // fast feedback only; the server decides
    try {
      const r = await api<Receipt>(`/claims/${id}/lines/${l.id}/receipts`, 'POST', f, { headers: { 'x-filename': encodeURIComponent(f.name) } });
      setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, err: '', receipts: [...x.receipts, r] } : x)));
    } catch (err) { patch(l.key, { err: reason(err) }); }
  }

  async function dropReceipt(l: Line, r: Receipt) {
    try {
      await api(`/claims/${id}/receipts/${r.id}`, 'DELETE');
      setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, err: '', receipts: x.receipts.filter((y) => y.id !== r.id) } : x)));
    } catch (err) { patch(l.key, { err: reason(err) }); }
  }

  const dropLine = (l: Line) => { if (l.id) setRemoved((r) => [...r, l.id!]); setLines((ls) => ls.filter((x) => x.key !== l.key)); };

  return (
    <section>
      <h1 tabIndex={-1}>{id ? 'Edit claim' : 'New claim'}</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {note && <p role="status">{note}</p>}
      {ready && !blocked && (
        <form onSubmit={save}>
          <label htmlFor="title">Title</label>
          <input id="title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor="purpose">Purpose</label>
          <textarea id="purpose" required minLength={10} maxLength={2000} rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          {lines.map((l, i) => {
            const limit = cats.find((c) => c.code === l.categoryCode)?.limitCents ?? 0;
            const cents = parseEuro(l.amount);
            const over = cents !== null && cents > limit;
            return (
            <fieldset key={l.key}>
              <legend>Line {i + 1}</legend>
              <label htmlFor={`date-${l.key}`}>Date</label>
              <input id={`date-${l.key}`} type="date" required value={l.date} onChange={(e) => patch(l.key, { date: e.target.value })} />
              <label htmlFor={`cat-${l.key}`}>Category</label>
              <select id={`cat-${l.key}`} value={l.categoryCode} onChange={(e) => patch(l.key, { categoryCode: e.target.value })}>
                {cats.map((c) => <option key={c.code} value={c.code}>{`${c.label} (limit ${formatCents(c.limitCents)})`}</option>)}
              </select>
              <label htmlFor={`amt-${l.key}`}>Amount (EUR)</label>
              <input id={`amt-${l.key}`} inputMode="decimal" required value={l.amount} aria-invalid={!!l.amountErr} aria-describedby={l.amountErr ? `amt-err-${l.key}` : undefined} onChange={(e) => patch(l.key, { amount: e.target.value })} />
              {l.amountErr && <p id={`amt-err-${l.key}`} className="error">{l.amountErr}</p>}
              <label htmlFor={`desc-${l.key}`}>Description</label>
              <input id={`desc-${l.key}`} required maxLength={200} value={l.description} onChange={(e) => patch(l.key, { description: e.target.value })} />
              {(over || l.stored) && (
                <>
                  <label htmlFor={`just-${l.key}`}>{`Justification (at least 20 characters, required above ${formatCents(limit)})`}</label>
                  <textarea id={`just-${l.key}`} maxLength={500} rows={3} value={l.justification} onChange={(e) => patch(l.key, { justification: e.target.value })} />
                </>
              )}
              {l.id ? (
                <>
                  <ul className="plain">
                    {l.receipts.map((r) => (
                      <li key={r.id}>{r.originalName ?? 'Receipt'} <button type="button" onClick={() => dropReceipt(l, r)} aria-label={`Remove receipt ${r.originalName ?? ''}`.trim()}>Remove</button></li>
                    ))}
                  </ul>
                  <label className="button">Take photo<input type="file" accept="image/*" capture="environment" onChange={(e) => upload(l, e)} /></label>
                  <label className="button">Choose file<input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => upload(l, e)} /></label>
                </>
              ) : <p>Save the claim to add receipts.</p>}
              {l.err && <p role="alert" className="error">{l.err}</p>}
              {lines.length > 1 && <button type="button" onClick={() => dropLine(l)}>Remove line</button>}
            </fieldset>
            );
          })}
          <p><button type="button" onClick={() => setLines((ls) => [...ls, blank(cats[0]?.code ?? '')])}>Add line</button></p>
          <button type="submit">Save claim</button>
        </form>
      )}
      <p><a href="/claims">Back to my claims</a></p>
    </section>
  );
}
