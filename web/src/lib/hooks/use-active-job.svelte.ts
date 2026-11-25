import type { JobResponse, Uuid } from "@great-minds/domain";
import { nextPageOffset } from "@great-minds/client";
import { createInfiniteQuery, skipToken } from "@tanstack/svelte-query";

import { listActiveJobs } from "#lib/api/jobs.ts";
import { fileIngestDrafts } from "#lib/hooks/file-ingest-drafts.svelte.ts";
import { activeVault } from "#lib/hooks/use-vault.svelte.ts";

const titles: Record<JobResponse["trigger"], string> = {
  staged_files: "File upload",
  url: "URL import",
  manual: "Update",
};

export function useActiveJobs(vaultId: () => Uuid | null = () => activeVault.id) {
  const query = createInfiniteQuery(() => {
    const id = vaultId();
    return {
      queryKey: ["vault", id, "active-job"],
      queryFn: id ? ({ pageParam, signal }) => listActiveJobs(id, pageParam, signal) : skipToken,
      initialPageParam: 0,
      getNextPageParam: nextPageOffset,
      staleTime: 5_000,
    };
  });
  const entries = $derived.by(() => {
    const byId = new Map<Uuid, { id: Uuid; title: string; detail: string }>();
    for (const { vaultId: draftVault, batchId, manifest } of fileIngestDrafts()) {
      if (draftVault === vaultId()) {
        byId.set(batchId, {
          id: batchId,
          title: "Upload to confirm",
          detail: manifest[0]?.name ?? "",
        });
      }
    }
    for (const page of query.data?.pages ?? []) {
      for (const job of page.items) {
        byId.set(job.id, {
          id: job.id,
          title: titles[job.trigger],
          detail: job.created_at.toLocaleString(),
        });
      }
    }
    return [...byId.values()];
  });
  return {
    query,
    get entries() {
      return entries;
    },
    get href() {
      if (entries.length === 0) return null;
      return entries.length === 1 && query.isSuccess && !query.hasNextPage
        ? `/pipeline/runs/${entries[0].id}`
        : "/pipeline";
    },
  };
}
