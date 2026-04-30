import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import type { BtwMessage, HistoryMessage } from "@/lib/types";

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

// Fallback used only when no LLM-generated title is available. Include
// parent dir for nested paths so numbered chapter files (e.g.
// .../market/02.md) don't collapse to ambiguous labels like "02".
export function docDisplayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return path;
  const last = parts[parts.length - 1].replace(/\.md$/, "");
  if (parts.length >= 3) {
    return `${parts[parts.length - 2]}/${last}`;
  }
  return last;
}

export function displayTitle(path: string, title?: string | null): string {
  return title || docDisplayName(path);
}

export function buildBtwQuery(paragraph: string, anchor: string, userText: string): string {
  const parts: string[] = [];
  if (paragraph) parts.push(`Passage:\n> ${paragraph}`);
  if (anchor && anchor !== paragraph) parts.push(`Highlighted: "${anchor}"`);
  parts.push(userText);
  return parts.join("\n\n");
}

// First user turn carries the passage prefix so the model has the BTW anchor
// in conversation history; later turns are raw text since context is established.
export function buildBtwHistory(
  priorBtw: BtwMessage[],
  paragraph: string,
  anchor: string,
): HistoryMessage[] {
  return priorBtw.map((m, i) => ({
    role: m.role,
    content: i === 0 && m.role === "user" ? buildBtwQuery(paragraph, anchor, m.text) : m.text,
  }));
}
