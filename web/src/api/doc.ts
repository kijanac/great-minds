import { apiFetch } from "./client";

export async function listArticles(): Promise<string[]> {
  const res = await apiFetch("/wiki");
  if (!res.ok) throw new Error(`Failed to list articles: ${res.status}`);
  return res.json();
}

export async function readDocument(
  path: string,
  signal?: AbortSignal,
): Promise<{ path: string; content: string }> {
  const res = await apiFetch(`/doc/${path}`, { signal });
  if (!res.ok) throw new Error(`Document not found: ${path}`);
  return res.json();
}
