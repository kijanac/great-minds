import { createContext } from "react";

export interface AuthContextValue {
  isAuthenticated: boolean;
  userId: string | null;
  login: () => void;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
