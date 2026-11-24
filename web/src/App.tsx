import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CircleUserRound, Download, FileText, ListChecks, SlidersHorizontal, Users, Wallet } from 'lucide-react';
import { api, ApiError, onUnauthorized, setCsrf, type SessionUser } from './api';
import { activeHref, navFor } from './nav';
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
import PolicySettings from './screens/PolicySettings';
import ExportClaims from './screens/ExportClaims';

export const homeFor = (u: SessionUser) => (u.role === 'admin' ? '/users' : '/claims');

const ICON: Record<string, ReactNode> = {
  '/claims': <FileText aria-hidden="true" size={18} />,
  '/approvals': <ListChecks aria-hidden="true" size={18} />,
  '/payments': <Wallet aria-hidden="true" size={18} />,
  '/policy': <SlidersHorizontal aria-hidden="true" size={18} />,
  '/export': <Download aria-hidden="true" size={18} />,
  '/users': <Users aria-hidden="true" size={18} />,
};
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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
  const pay = path.match(/^\/payments\/([^/]+)$/);
  const claim = path.match(/^\/claims\/([^/]+)$/);
  const edit = path === '/claims/new' ? ['', ''] : path.match(/^\/claims\/([^/]+)\/edit$/);
  const items = navFor(user);
  const active = activeHref(path, items);
  return (
    <div className="shell">
      <header className="topbar" onKeyDown={(e) => { if (e.key === 'Escape') setMenuOpen(false); }}>
        <span className="brand"><span className="brand__mark" aria-hidden="true" />ClaimFlow</span>
        <button type="button" className="topbar__toggle" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen((o) => !o)}>Menu</button>
        <nav id="main-nav" aria-label="Main" className={menuOpen ? 'open' : undefined}>
          <span className="nav__label" aria-hidden="true">Workspace</span>
          {items.map((i) => (
            <a key={i.href} href={i.href} aria-current={i.href === active ? 'page' : undefined}>
              {ICON[i.href] ?? <CircleUserRound aria-hidden="true" size={18} />}{i.label}
            </a>
          ))}
          <div className="user-card">
            <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
            <span className="user-card__who"><span className="user-card__name">{user.name}</span><span className="user-card__role">{user.role}</span></span>
            <button type="button" onClick={signOut}>Sign out</button>
          </div>
        </nav>
      </header>
    <main className="wide">
      {path === '/claims' ? <ClaimsList /> : path === '/approvals' ? <Approvals /> : path === '/payments' ? <Payments /> : path === '/policy' ? <PolicySettings /> : path === '/export' ? <ExportClaims /> : pay ? <ClaimDetail key={path} id={pay[1]} viewer={user} go={go} back="/payments" /> : review ? <ClaimDetail key={path} id={review[1]} viewer={user} go={go} back="/approvals" /> : edit ? <ClaimEditor key={path} id={edit[1]} go={go} /> : claim && claim[1] !== 'new' ? <ClaimDetail key={path} id={claim[1]} viewer={user} go={go} /> : path === '/users' ? <UsersList /> : detail ? <UserDetail key={detail[1]} id={detail[1]} viewer={user} /> : <p role="alert">Page not found.</p>}
    </main>
    </div>
  );
}
