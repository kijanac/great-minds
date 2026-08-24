import { browser } from "$app/environment";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

function getTheme(): Theme {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "dark";
}

function applyTheme(value: Theme): void {
  document.documentElement.classList.toggle("dark", value === "dark");
  document.documentElement.classList.toggle("light", value === "light");
  // Drop app.html's pre-paint inline background; with stylesheets loaded,
  // body's token-driven bg-background propagates to the canvas.
  document.documentElement.style.removeProperty("background-color");
}

class ThemeState {
  current = $state<Theme>("dark");
  ready = $state(false);

  #initialized = false;

  #sync = () => {
    this.current = getTheme();
    applyTheme(this.current);
    this.ready = true;
  };

  initialize(): () => void {
    if (!browser) return () => {};

    this.#sync();
    if (this.#initialized) return () => {};

    this.#initialized = true;
    window.addEventListener("storage", this.#sync);

    return () => {
      window.removeEventListener("storage", this.#sync);
      this.#initialized = false;
    };
  }

  toggle(): void {
    const next = this.current === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    window.dispatchEvent(new StorageEvent("storage"));
  }
}

export const theme = new ThemeState();
