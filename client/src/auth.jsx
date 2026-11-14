import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, post, getToken, setToken } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [shop, setShop] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const loadShop = useCallback(() => get('/settings/shop').then(setShop).catch(() => {}), []);

  useEffect(() => {
    if (!getToken()) return;
    get('/auth/me').then((r) => { setUser(r.user); loadShop(); })
      .catch(() => setToken(null)).finally(() => setLoading(false));
  }, [loadShop]);

  useEffect(() => {
    const onUnauth = () => { setToken(null); setUser(null); };
    window.addEventListener('orderpilot:unauthorized', onUnauth);
    return () => window.removeEventListener('orderpilot:unauthorized', onUnauth);
  }, []);

  const login = async (phone, password) => {
    const r = await post('/auth/login', { phone, password });
    setToken(r.token); setUser(r.user); loadShop();
    return r.user;
  };
  const logout = () => { setToken(null); setUser(null); };

  return <AuthContext.Provider value={{ user, shop, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
export const homeFor = (role) => (role === 'owner' ? '/owner' : role === 'staff' ? '/staff' : '/');
