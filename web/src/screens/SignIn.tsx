import { useState, type FormEvent } from 'react';
import { api, type SessionUser } from '../api';
import { Alert, AuthAside, Button, Card, PageHeader, TextField, fieldErrors } from '../ui/components';

export default function SignIn({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
  const [email, setEmail] = useState(() => new URLSearchParams(location.search).get('email') ?? '');
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
      onSignedIn(await api<SessionUser>('/auth/sign-in', 'POST', { email, password }, { quiet401: true }));
    } catch {
      setError('Email or password is incorrect, or the account is locked.'); // one generic message (NFR-SEC-6), never field-specific
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <AuthAside />
      <div className="auth__panel">
        <Card>
          <PageHeader title="Sign in" subtitle="Use the email your admin set up for you." focusable={false} />
          <form onSubmit={submit} noValidate>
            <TextField id="email" label="Email" type="email" autoComplete="username" required value={email} error={errs.email} onChange={(e) => setEmail(e.target.value)} />
            <TextField id="password" label="Password" type="password" autoComplete="current-password" required value={password} error={errs.password} onChange={(e) => setPassword(e.target.value)} />
            {error && <Alert>{error}</Alert>}
            <Button type="submit" disabled={busy}>Sign in</Button>
          </form>
          <p><a href="/forgot-password">Forgot password?</a></p>
        </Card>
      </div>
    </main>
  );
}
