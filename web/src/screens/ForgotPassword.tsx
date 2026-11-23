import { useState, type FormEvent } from 'react';
import { api } from '../api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/forgot-password', 'POST', { email }, { quiet401: true });
      setDone(true); // identical text for every email (NFR-SEC-6)
    } catch {
      setError('Enter a valid email address.');
    }
  }

  return (
    <main>
      <h1>Forgot password</h1>
      {done ? (
        <p role="status">If that email belongs to an active account, a reset link has been sent.</p>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <p role="alert" className="error">{error}</p>}
          <button type="submit">Send reset link</button>
        </form>
      )}
      <p><a href="/sign-in">Back to sign in</a></p>
    </main>
  );
}
