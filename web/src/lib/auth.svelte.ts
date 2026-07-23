import { browser } from "$app/environment";
import { decodeJwt } from "jose";

import { clearTokens, ensureVaultId } from "$lib/api/client";
import { queryClient } from "$lib/query-client";

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
  const token = localStorage.getItem("access_token");
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

  #initialized = false;

  #sync = () => {
    const authenticated =
      isTokenValid(localStorage.getItem("access_token")) ||
      isTokenValid(localStorage.getItem("refresh_token"));

    this.isAuthenticated = authenticated;
    this.userId = authenticated ? getUserIdFromToken() : null;
    this.ready = true;

    if (authenticated) {
      void ensureVaultId();
    }
  };

  initialize(): () => void {
    if (!browser) return () => {};

    this.#sync();
    if (this.#initialized) return () => {};

    this.#initialized = true;
    window.addEventListener("auth:changed", this.#sync);
    window.addEventListener("storage", this.#sync);

    return () => {
      window.removeEventListener("auth:changed", this.#sync);
      window.removeEventListener("storage", this.#sync);
      this.#initialized = false;
    };
  }

  login(): void {
    if (browser) {
      window.dispatchEvent(new Event("auth:changed"));
    }
  }

  logout(): void {
    queryClient.clear();
    clearTokens();
  }
}

export const auth = new AuthState();
