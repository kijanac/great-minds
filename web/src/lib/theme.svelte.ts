import { windowSync } from "$lib/window-sync";

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

  initialize = windowSync(["storage"], () => {
    this.current = getTheme();
    applyTheme(this.current);
  });

  toggle(): void {
    const next = this.current === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    this.current = next;
    applyTheme(next);
  }
}

export const theme = new ThemeState();
