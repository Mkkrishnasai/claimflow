import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, onUnauthorized, setCsrf, type SessionUser } from './api';
import SignIn from './screens/SignIn';
import SetPassword from './screens/SetPassword';
import ForgotPassword from './screens/ForgotPassword';
import UsersList from './screens/UsersList';
import UserDetail from './screens/UserDetail';
import ClaimsList from './screens/ClaimsList';
import ClaimEditor from './screens/ClaimEditor';
import ClaimDetail from './screens/ClaimDetail';
import Approvals from './screens/Approvals';
import Payments from './screens/Payments';

export const homeFor = (u: SessionUser) => (u.role === 'admin' ? '/users' : '/claims');

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
  const review = path.match(/^\/approvals\/([^/]+)$/);
  const claim = path.match(/^\/claims\/([^/]+)$/);
  const edit = path === '/claims/new' ? ['', ''] : path.match(/^\/claims\/([^/]+)\/edit$/);
  return (
    <main className="wide">
      <nav aria-label="Main">
        <a href="/claims">My claims</a> {user.role === 'manager' && <><a href="/approvals">Approvals</a> </>}{user.role === 'finance' && <><a href="/payments">Payments</a> </>}<a href={`/users/${user.id}`}>My account</a>
        <button type="button" onClick={signOut}>Sign out</button>
      </nav>
      {path === '/claims' ? <ClaimsList /> : path === '/approvals' ? <Approvals /> : path === '/payments' ? <Payments /> : review ? <ClaimDetail key={path} id={review[1]} viewer={user} go={go} back="/approvals" /> : edit ? <ClaimEditor key={path} id={edit[1]} go={go} /> : claim && claim[1] !== 'new' ? <ClaimDetail key={path} id={claim[1]} viewer={user} go={go} /> : path === '/users' ? <UsersList /> : detail ? <UserDetail key={detail[1]} id={detail[1]} viewer={user} /> : <p role="alert">Page not found.</p>}
    </main>
  );
}
