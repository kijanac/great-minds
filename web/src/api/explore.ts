import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";
import { wikiArticleOverviewSchema } from "./wiki";

const unmentionedLinkSchema = z.object({
  source_slug: z.string(),
  source_title: z.string(),
  target_slug: z.string(),
  target_title: z.string(),
});

const lintResponseSchema = z.object({
  orphans: z.array(wikiArticleOverviewSchema),
  dirty_topics: z.array(z.string()),
  unmentioned_links: z.array(unmentionedLinkSchema),
});

export type UnmentionedLink = z.infer<typeof unmentionedLinkSchema>;
export type LintResponse = z.infer<typeof lintResponseSchema>;

export async function fetchLintResults(): Promise<LintResponse> {
  const res = await apiFetch(vaultPath("/lint"));
  if (!res.ok) throw new Error("Failed to fetch lint results");
  return readJson(res, lintResponseSchema);
}
