import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { Api } from './api';
import { reportPath } from './reporting';

const authority = import.meta.env.VITE_OIDC_AUTHORITY as string | undefined;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;
function manager(): UserManager | null {
  if (!authority || !clientId) return null;
  const url = new URL(authority);
  if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(url.hostname) && import.meta.env.DEV)) throw new Error('Sign-in requires a secure identity provider.');
  return new UserManager({ authority, client_id: clientId, response_type: 'code',
    redirect_uri: location.origin + '/auth/callback', post_logout_redirect_uri: location.origin + '/auth/signout-callback',
    silent_redirect_uri: location.origin + '/auth/silent-callback', scope: import.meta.env.VITE_OIDC_SCOPE || 'openid profile email',
    ...(import.meta.env.VITE_OIDC_AUDIENCE ? { extraQueryParams: { audience: import.meta.env.VITE_OIDC_AUDIENCE } } : {}),
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true, silentRequestTimeoutInSeconds: 10, loadUserInfo: false,
  });
}
interface Auth {
  user: User | null; ready: boolean; configured: boolean; error: string;
  signIn: () => Promise<void>; signOut: () => Promise<void>; api: Api;
}
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [client] = useState(manager), [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  const api = useMemo(() => new Api(async () => {
    if (!client) return '';
    let current = await client.getUser();
    if (current?.expired) {
      try { current = await client.signinSilent(); } catch { current = null; }
    }
    return current?.access_token || '';
  }, () => { setUser(null); setError('Your session has ended. Sign in again to continue.'); void client?.removeUser(); }), [client]);
  useEffect(() => {
    let active = true;
    const loaded = (next: User) => { if (active) { setUser(next.expired ? null : next); setError(''); } };
    const unloaded = () => { if (active) setUser(null); };
    client?.events.addUserLoaded(loaded); client?.events.addUserUnloaded(unloaded); client?.events.addAccessTokenExpired(unloaded);
    void (async () => {
      try {
        if (!client) return;
        if (location.pathname === '/auth/callback') {
          const next = await client.signinRedirectCallback();
          if (active) loaded(next);
          history.replaceState(null, '', reportPath((next.state as { returnTo?: unknown } | undefined)?.returnTo));
        } else if (location.pathname === '/auth/signout-callback') {
          await client.signoutRedirectCallback(); history.replaceState(null, '', '/');
        } else if (location.pathname === '/auth/silent-callback') {
          await client.signinSilentCallback();
        } else {
          const next = await client.getUser();
          if (next && active) loaded(next);
        }
      } catch { if (active) setError('Sign-in could not be completed. Please try again.'); }
      finally { if (active) setReady(true); }
    })();
    return () => {
      active = false; client?.events.removeUserLoaded(loaded); client?.events.removeUserUnloaded(unloaded); client?.events.removeAccessTokenExpired(unloaded);
    };
  }, [client]);
  async function signIn() {
    setError('');
    try { await client?.signinRedirect({ state: { returnTo: reportPath(location.pathname + location.search) } }); } catch { setError('We could not open sign-in. Please try again.'); }
  }
  async function signOut() {
    setUser(null);
    try { await client?.removeUser(); await client?.signoutRedirect(); }
    catch { setError('You are signed out of this workspace. Your identity-provider session may still be active.'); }
  }
  return <Context.Provider value={{ user, ready, configured: !!client, error, signIn, signOut, api }}>{children}</Context.Provider>;
}
export function useAuth() { const context = useContext(Context); if (!context) throw new Error('Authentication context required.'); return context; }
