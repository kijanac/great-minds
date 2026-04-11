import { apiFetch } from "./client";

export interface R2Object {
  key: string;
  size: number;
  last_modified: string;
}

export async function listObjects(prefix = ""): Promise<R2Object[]> {
  const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
  const res = await apiFetch(`/v1/corpus/objects${params}`);
  if (!res.ok) throw new Error(`Failed to list objects: ${res.statusText}`);
  const data = await res.json();
  return data.objects as R2Object[];
}

export async function getObject(key: string): Promise<string> {
  const res = await apiFetch(`/v1/corpus/object?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Failed to fetch object: ${res.statusText}`);
  const data = await res.json();
  return data.content as string;
}

export async function listModels(): Promise<string[]> {
  const res = await apiFetch("/v1/corpus/models");
  if (!res.ok) throw new Error("Failed to fetch models");
  const data = await res.json();
  return data.models as string[];
}

export async function* streamSummarize(
  key: string,
  contextPrompt: string,
  modelId: string,
): AsyncGenerator<string> {
  const res = await apiFetch("/v1/corpus/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, context_prompt: contextPrompt, model_id: modelId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Summarize failed (${res.status}): ${text}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}
