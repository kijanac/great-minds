import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

let _nextId = 0;
export function genId(prefix: string) {
  return `${prefix}-${++_nextId}`;
}

export function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function formatShortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function docDisplayName(path: string): string {
  const filename = path.split("/").pop() ?? path;
  return filename.replace(/\.md$/, "");
}

export function buildBtwQuery(paragraph: string, anchor: string, userText: string): string {
  const parts: string[] = [];
  if (paragraph) parts.push(`Passage:\n> ${paragraph}`);
  if (anchor && anchor !== paragraph) parts.push(`Highlighted: "${anchor}"`);
  parts.push(userText);
  return parts.join("\n\n");
}
