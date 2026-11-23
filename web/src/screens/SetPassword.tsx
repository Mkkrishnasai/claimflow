import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

// One screen for set_password and reset links; the token lives in the URL fragment (never sent to the server).
export default function SetPassword({ go }: { go: (to: string) => void }) {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
  const [email] = useState(() => new URLSearchParams(location.hash.slice(1)).get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/set-password', 'POST', { token, password }, { quiet401: true });
      history.replaceState(null, '', location.pathname); // drop the spent token from the URL
      go(`/sign-in?email=${encodeURIComponent(email)}`);
    } catch (err) {
      setError(err instanceof ApiError && err.reason ? err.reason : err instanceof ApiError && err.code === 'invalid_token'
        ? 'This link is invalid or has expired. Request a new one.' : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Set your password</h1>
      <form onSubmit={submit}>
        <label htmlFor="password">New password (at least 12 characters)</label>
        <input id="password" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" disabled={busy}>Set password</button>
      </form>
      <p><a href="/forgot-password">Request a new link</a></p>
    </main>
  );
}
