import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Alert, Button, Card, PageHeader, TextField, fieldErrors } from '../ui/components';

// One screen for set_password and reset links; the token lives in the URL fragment (never sent to the server).
export default function SetPassword({ go }: { go: (to: string) => void }) {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
  const [email] = useState(() => new URLSearchParams(location.hash.slice(1)).get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { errors, first } = fieldErrors(e.currentTarget);
    setErrs(errors);
    setError('');
    if (first) { first.focus(); return; }
    setBusy(true);
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
    <main className="auth">
      <aside className="auth__aside" aria-hidden="true"><p>ClaimFlow</p></aside>
      <div className="auth__panel">
        <Card>
          <PageHeader title="Set your password" />
          <form onSubmit={submit} noValidate>
            <TextField id="password" label="New password (at least 12 characters)" type="password" autoComplete="new-password" required minLength={12} value={password} error={errs.password} onChange={(e) => setPassword(e.target.value)} />
            {error && <Alert>{error}</Alert>}
            <Button type="submit" disabled={busy}>Set password</Button>
          </form>
          <p><a href="/forgot-password">Request a new link</a></p>
        </Card>
      </div>
    </main>
  );
}
