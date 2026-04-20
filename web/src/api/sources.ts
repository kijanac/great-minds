import { z } from "zod";

import { apiFetch, brainPath, readJson } from "./client";

const rawSourceItemSchema = z.object({
  title: z.string(),
  file_path: z.string(),
  author: z.string().nullable(),
  origin: z.string().nullable(),
  published_date: z.string().nullable(),
  compiled: z.boolean(),
  source_type: z.enum(["document", "user"]),
  updated_at: z.string().nullable(),
});

const contentTypeCountSchema = z.object({
  content_type: z.string(),
  count: z.number(),
});

const rawSourcesResponseSchema = z.object({
  items: z.array(rawSourceItemSchema),
  content_types: z.array(contentTypeCountSchema),
});

export type RawSourceItem = z.infer<typeof rawSourceItemSchema>;
export type ContentTypeCount = z.infer<typeof contentTypeCountSchema>;
export type RawSourcesResponse = z.infer<typeof rawSourcesResponseSchema>;

export async function fetchRawSources(params?: {
  content_type?: string;
  search?: string;
  compiled?: boolean;
  limit?: number;
  offset?: number;
}): Promise<RawSourcesResponse> {
  const query = new URLSearchParams();
  if (params?.content_type) query.set("content_type", params.content_type);
  if (params?.search) query.set("search", params.search);
  if (params?.compiled !== undefined) query.set("compiled", String(params.compiled));
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.offset !== undefined) query.set("offset", String(params.offset));

  const qs = query.toString();
  const path = brainPath(`/raw/sources${qs ? `?${qs}` : ""}`);
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Failed to fetch raw sources");
  return readJson(res, rawSourcesResponseSchema);
}
