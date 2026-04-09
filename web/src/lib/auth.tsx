import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { decodeJwt } from "jose";
import { clearTokens, ensureBrainId } from "@/api/client";

function getUserIdFromToken(): string | null {
  const token = localStorage.getItem("access_token");
  if (!token) return null;
  try {
    const { sub } = decodeJwt(token);
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

interface AuthContextValue {
  isAuthenticated: boolean;
  userId: string | null;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getSnapshot(): boolean {
  return localStorage.getItem("access_token") !== null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const isAuthenticated = useSyncExternalStore(subscribe, getSnapshot);
  const userId = isAuthenticated ? getUserIdFromToken() : null;

  useEffect(() => {
    if (isAuthenticated) ensureBrainId();
  }, [isAuthenticated]);

  const login = useCallback(() => {
    window.dispatchEvent(new StorageEvent("storage"));
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    window.dispatchEvent(new StorageEvent("storage"));
  }, []);

  const value = useMemo(
    () => ({ isAuthenticated, userId, login, logout }),
    [isAuthenticated, userId, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
