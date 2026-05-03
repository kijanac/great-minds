import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";

const documentSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  file_path: z.string(),
  body_hash: z.string(),
  compiled: z.boolean(),
  doc_kind: z.enum(["raw", "wiki"]),
  metadata: z.object({
    title: z.string(),
    author: z.string().nullable(),
    published_date: z.string().nullable(),
    url: z.string().nullable(),
    origin: z.string().nullable(),
    genre: z.string().nullable(),
    precis: z.string().nullable(),
    source_type: z.string().nullable(),
    tags: z.array(z.string()),
    extra_metadata: z.record(z.string(), z.unknown()),
  }),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const documentResponseSchema = z.object({
  document: documentSchema,
  body: z.string(),
  archived: z.boolean(),
  superseded_by: z.string().nullable(),
});

export type Document = z.infer<typeof documentSchema>;
export type DocumentResponse = z.infer<typeof documentResponseSchema>;

export async function readDocument(
  path: string,
  signal?: AbortSignal,
): Promise<DocumentResponse> {
  const res = await apiFetch(vaultPath(`/doc/${path}`), { signal });
  if (!res.ok) throw new Error(`Document not found: ${path}`);
  return readJson(res, documentResponseSchema);
}
