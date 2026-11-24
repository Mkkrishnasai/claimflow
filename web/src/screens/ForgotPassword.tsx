import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Alert, Button, Card, PageHeader, TextField, fieldErrors } from '../ui/components';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { errors, first } = fieldErrors(e.currentTarget);
    setErrs(errors);
    setError('');
    if (first) { first.focus(); return; }
    try {
      await api('/auth/forgot-password', 'POST', { email }, { quiet401: true });
      setDone(true); // identical text for every email (NFR-SEC-6)
    } catch {
      setError('Enter a valid email address.');
    }
  }

  return (
    <main className="auth">
      <aside className="auth__aside" aria-hidden="true"><p>ClaimFlow</p></aside>
      <div className="auth__panel">
        <Card>
          <PageHeader title="Forgot password" />
          {done ? (
            <Alert role="status" tone="info">If that email belongs to an active account, a reset link has been sent.</Alert>
          ) : (
            <form onSubmit={submit} noValidate>
              <TextField id="email" label="Email" type="email" autoComplete="username" required value={email} error={errs.email} onChange={(e) => setEmail(e.target.value)} />
              {error && <Alert>{error}</Alert>}
              <Button type="submit">Send reset link</Button>
            </form>
          )}
          <p><a href="/sign-in">Back to sign in</a></p>
        </Card>
      </div>
    </main>
  );
}
