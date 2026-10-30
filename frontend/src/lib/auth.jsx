import React, {createContext, useCallback, useContext, useEffect, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api, setToken, setUnauthorizedHandler} from '../api/client.js';

const AuthContext = createContext(null);

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}

function storage(action) {
  try { return action(window.sessionStorage); } catch { return null; }
}

function loadSession() {
  const token = storage(s => s.getItem('nx_token'));
  if (!token) return null;
  const exp = tokenExpiry(token);
  if (exp && exp <= Date.now()) return null;
  return {token, exp, role: storage(s => s.getItem('nx_role')) || 'admin', email: storage(s => s.getItem('nx_email')) || ''};
}

export function AuthProvider({children}) {
  const qc = useQueryClient();
  const [session, setSession] = useState(() => {
    const s = loadSession();
    setToken(s?.token || null);
    return s;
  });
  const [notice, setNotice] = useState('');

  const logout = useCallback((message = '') => {
    storage(s => ['nx_token', 'nx_role', 'nx_email'].forEach(k => s.removeItem(k)));
    setToken(null);
    setSession(null);
    setNotice(message);
    qc.clear();
  }, [qc]);

  const login = useCallback(async credentials => {
    const r = await api('/auth/login', {method: 'POST', body: credentials});
    const next = {token: r.access_token, role: r.role, email: r.email, exp: tokenExpiry(r.access_token)};
    storage(s => { s.setItem('nx_token', next.token); s.setItem('nx_role', next.role); s.setItem('nx_email', next.email); });
    setToken(next.token);
    setNotice('');
    setSession(next);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => logout('Sesi tidak valid atau kedaluwarsa. Silakan masuk kembali.'));
  }, [logout]);

  // Token JWT berlaku 8 jam; keluar otomatis tepat saat kedaluwarsa.
  useEffect(() => {
    if (!session?.exp) return undefined;
    const timer = setTimeout(() => logout('Sesi 8 jam telah berakhir. Silakan masuk kembali.'), Math.max(0, session.exp - Date.now()));
    return () => clearTimeout(timer);
  }, [session, logout]);

  return <AuthContext.Provider value={{session, login, logout, notice}}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
