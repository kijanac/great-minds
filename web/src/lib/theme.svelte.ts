import { browser } from "$app/environment";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

function applyTheme(value: Theme): void {
  document.documentElement.classList.toggle("dark", value === "dark");
  document.documentElement.classList.toggle("light", value === "light");
  // Drop app.html's pre-paint inline background; with stylesheets loaded,
  // body's token-driven bg-background propagates to the canvas.
  document.documentElement.style.removeProperty("background-color");
}

class ThemeState {
  private system = $state<Theme>("light");
  private override = $state<Theme | null>(null);
  current = $derived(this.override ?? this.system);

  initialize(): () => void {
    if (!browser) return () => {};
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystem = () => {
      this.system = preference.matches ? "dark" : "light";
      applyTheme(this.current);
    };
    const syncStorage = () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        this.override = stored === "light" || stored === "dark" ? stored : null;
      } catch {}
      applyTheme(this.current);
    };
    this.system = preference.matches ? "dark" : "light";
    syncStorage();
    preference.addEventListener("change", syncSystem);
    window.addEventListener("storage", syncStorage);
    return () => {
      preference.removeEventListener("change", syncSystem);
      window.removeEventListener("storage", syncStorage);
    };
  }

  toggle(): void {
    const next = this.current === "dark" ? "light" : "dark";
    this.override = next === this.system ? null : next;
    try {
      if (this.override === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, this.override);
    } catch {}
    applyTheme(this.current);
  }
}

export const theme = new ThemeState();
