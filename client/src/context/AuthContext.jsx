import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authed, setAuthed] = useState(Boolean(getToken()));

  // api.js dispatches this when any request comes back 401 (expired or
  // invalid token) — without it, authed never changes outside an explicit
  // login()/logout() call, so an expired session left every page stuck on
  // a broken error state instead of returning to the login screen.
  useEffect(() => {
    function onAuthExpired() {
      setAuthed(false);
    }
    window.addEventListener('auth:expired', onAuthExpired);
    return () => window.removeEventListener('auth:expired', onAuthExpired);
  }, []);

  async function login(password) {
    const { token } = await api.login(password);
    setToken(token);
    setAuthed(true);
  }

  function logout() {
    setToken(null);
    setAuthed(false);
  }

  return (
    <AuthContext.Provider value={{ authed, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
