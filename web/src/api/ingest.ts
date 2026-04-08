import { apiFetch } from "./client";

export interface IngestResult {
  status: string;
  name: string;
  chars: number;
}

export async function uploadFile(file: File): Promise<IngestResult> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await apiFetch("/ingest/upload", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }

  return res.json();
}

export async function ingestUrl(url: string): Promise<IngestResult> {
  const res = await apiFetch("/ingest/url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }

  return res.json();
}
