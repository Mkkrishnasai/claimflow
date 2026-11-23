import { useState, type FormEvent } from 'react';
import { api, type SessionUser } from '../api';

export default function SignIn({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
  const [email, setEmail] = useState(() => new URLSearchParams(location.search).get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await api<SessionUser>('/auth/sign-in', 'POST', { email, password }, { quiet401: true }));
    } catch {
      setError('Email or password is incorrect, or the account is locked.'); // one generic message (NFR-SEC-6)
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" disabled={busy}>Sign in</button>
      </form>
      <p><a href="/forgot-password">Forgot password?</a></p>
    </main>
  );
}
