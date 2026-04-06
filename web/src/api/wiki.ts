import { apiFetch } from "./client"

export async function listArticles(): Promise<string[]> {
  const res = await apiFetch("/wiki")
  if (!res.ok) throw new Error(`Failed to list articles: ${res.status}`)
  return res.json()
}

export async function readArticle(
  slug: string,
): Promise<{ slug: string; content: string }> {
  const res = await apiFetch(`/wiki/${slug}`)
  if (!res.ok) throw new Error(`Article not found: ${slug}`)
  return res.json()
}

export async function readIndex(): Promise<string> {
  const res = await apiFetch("/wiki/_index")
  if (!res.ok) throw new Error(`Failed to read index: ${res.status}`)
  const data: { content: string } = await res.json()
  return data.content
}
