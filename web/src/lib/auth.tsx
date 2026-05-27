import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { decodeJwt } from "jose";
import { clearTokens, ensureVaultId, getCurrentAccessToken, hasPersistedAuth } from "@/api/client";
import { AuthContext } from "@/lib/auth-context";
import { queryClient } from "@/lib/query-client";

function isTokenValid(token: string | null): boolean {
  if (!token) return false;
  try {
    const { exp } = decodeJwt(token);
    return typeof exp === "number" && exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function getUserIdFromToken(): string | null {
  const token = getCurrentAccessToken();
  if (!token) return null;
  try {
    const { sub } = decodeJwt(token);
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener("auth:changed", callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener("auth:changed", callback);
    window.removeEventListener("storage", callback);
  };
}

function getSnapshot(): boolean {
  return isTokenValid(getCurrentAccessToken()) || hasPersistedAuth();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const isAuthenticated = useSyncExternalStore(subscribe, getSnapshot);
  const userId = isAuthenticated ? getUserIdFromToken() : null;

  useEffect(() => {
    if (isAuthenticated) ensureVaultId();
  }, [isAuthenticated]);

  const login = useCallback(() => {
    window.dispatchEvent(new Event("auth:changed"));
  }, []);

  const logout = useCallback(() => {
    queryClient.clear();
    void clearTokens();
  }, []);

  const value = useMemo(
    () => ({ isAuthenticated, userId, login, logout }),
    [isAuthenticated, userId, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
