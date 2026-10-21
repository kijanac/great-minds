import { decodeJwt } from "jose";

import { logout } from "$lib/api/auth";
import { readStoredTokens } from "$lib/api/token-store";
import { queryClient } from "$lib/query-client";
import { windowSync } from "$lib/window-sync";

function isTokenValid(token: string | null): boolean {
  if (!token) return false;
  try {
    const { exp } = decodeJwt(token);
    return typeof exp === "number" && exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function userIdFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const { sub } = decodeJwt(token);
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

class AuthState {
  isAuthenticated = $state(false);
  userId = $state<string | null>(null);
  ready = $state(false);

  initialize = windowSync(["auth:changed", "storage"], () => {
    const { access, refresh } = readStoredTokens();
    const authenticated = isTokenValid(access) || refresh !== null;

    this.isAuthenticated = authenticated;
    this.userId = authenticated ? userIdFromToken(access) : null;
    this.ready = true;
  });

  logout(): void {
    queryClient.clear();
    void logout();
  }
}

export const auth = new AuthState();
