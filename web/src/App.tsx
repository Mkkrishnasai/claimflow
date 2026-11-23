import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, onUnauthorized, setCsrf, type SessionUser } from './api';
import SignIn from './screens/SignIn';
import SetPassword from './screens/SetPassword';
import ForgotPassword from './screens/ForgotPassword';
import UsersList from './screens/UsersList';
import UserDetail from './screens/UserDetail';

export const homeFor = (u: SessionUser) => (u.role === 'admin' ? '/users' : `/users/${u.id}`);

export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  const go = useCallback((to: string) => { history.pushState(null, '', to); setPath(location.pathname); }, []);
  useEffect(() => {
    const pop = () => setPath(location.pathname);
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    onUnauthorized(() => { setUser(null); go('/sign-in'); });
    api<SessionUser>('/auth/session', 'GET', undefined, { quiet401: true })
      .then((u) => { setUser(u); setCsrf(u.csrfToken); })
      .catch((e) => { if (!(e instanceof ApiError && e.status === 401)) throw e; })
      .finally(() => setReady(true));
  }, [go]);

  if (!ready) return null;
  const signedIn = (u: SessionUser) => { setUser(u); setCsrf(u.csrfToken); go(homeFor(u)); };
  const signOut = () => api('/auth/sign-out', 'POST').finally(() => { setUser(null); setCsrf(null); go('/sign-in'); });

  if (path === '/sign-in') return <SignIn onSignedIn={signedIn} />;
  if (path === '/set-password' || path === '/reset-password') return <SetPassword go={go} />;
  if (path === '/forgot-password') return <ForgotPassword />;
  if (!user) { queueMicrotask(() => go('/sign-in')); return null; }
  const detail = path.match(/^\/users\/([^/]+)$/);
  return (
    <main className="wide">
      <button type="button" onClick={signOut}>Sign out</button>
      {path === '/users' ? <UsersList /> : detail ? <UserDetail key={detail[1]} id={detail[1]} viewer={user} /> : <p role="alert">Page not found.</p>}
    </main>
  );
}
