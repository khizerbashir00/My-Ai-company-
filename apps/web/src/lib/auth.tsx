import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, UNAUTHORIZED_EVENT, api } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  canWrite: boolean;
  isCeo: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Forget everything cached for the previous session. The session query itself stays so its observer keeps working. */
function dropCachedData(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api.get<{ user: User }>('/auth/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Any 401 elsewhere (expired session) drops back to the login screen.
  useEffect(() => {
    const onUnauthorized = () => {
      qc.setQueryData(['me'], null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { user } = await api.post<{ user: User }>('/auth/login', { email, password });
      dropCachedData(qc);
      qc.setQueryData(['me'], user);
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      dropCachedData(qc);
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  const user = me.data ?? null;
  return (
    <AuthContext.Provider
      value={{
        user,
        loading: me.isPending,
        canWrite: user?.role === 'CEO' || user?.role === 'ADMIN',
        isCeo: user?.role === 'CEO',
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
