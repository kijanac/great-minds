import type { Uuid } from "@great-minds/domain";
import {
  createMutation,
  createQuery,
  useMutationState,
  useQueryClient,
  type MutationState,
  type QueryClient,
} from "@tanstack/svelte-query";

import { errorMessage } from "@great-minds/client";
import {
  continueFileIngest,
  getFileIngestBatch,
  resumeFileIngestBatch,
  type FileIngestBatch,
  type HashedFile,
  type UploadFailure,
} from "#lib/api/ingest.ts";
import { auth } from "#lib/auth.svelte.ts";

interface UploadInput {
  readonly batch: FileIngestBatch;
  readonly files: readonly HashedFile[];
}

class UploadIncomplete extends Error {
  constructor(
    message: string,
    readonly failures: readonly UploadFailure[],
  ) {
    super(message);
  }
}

export const fileIngestKey = (batchId: Uuid | null) => ["file-ingest", batchId];
const uploadKey = ["file-ingest", "upload"];

const isUploading = (queryClient: QueryClient, batchId: Uuid | null) =>
  queryClient.isMutating({
    mutationKey: uploadKey,
    predicate: (mutation) => (mutation.state.variables as UploadInput)?.batch.id === batchId,
  }) > 0;

const loadBatch = async (batchId: Uuid) => {
  const batch = await getFileIngestBatch(batchId);
  return batch?.status === "uploading" && batch.created_by === auth.userId
    ? resumeFileIngestBatch(batchId)
    : batch;
};

export function useFileIngestBatch(batchId: () => Uuid | null) {
  const queryClient = useQueryClient();
  return createQuery(() => {
    const id = batchId();
    return {
      queryKey: fileIngestKey(id),
      queryFn: () => (id ? loadBatch(id) : null),
      enabled: id !== null,
      staleTime: () => (isUploading(queryClient, id) ? Infinity : 0),
      refetchOnWindowFocus: false,
    };
  });
}

export function useFileUpload() {
  const queryClient = useQueryClient();
  const mutation = createMutation(() => ({
    mutationKey: uploadKey,
    mutationFn: async ({ batch, files }: UploadInput) => {
      for await (const event of continueFileIngest(batch, files)) {
        if (event.batch) queryClient.setQueryData(fileIngestKey(batch.id), event.batch);
        if (event.phase === "error") {
          throw new UploadIncomplete(event.error ?? "Upload failed", event.failures ?? []);
        }
        if (event.phase === "processing") {
          await queryClient.invalidateQueries({
            queryKey: ["vault", event.batch?.vault_id ?? batch.vault_id, "active-job"],
          });
          return;
        }
      }
    },
    onError: async (error, { batch }) => {
      if (!(error instanceof UploadIncomplete)) {
        await queryClient.invalidateQueries({ queryKey: fileIngestKey(batch.id) });
      }
    },
  }));

  return (batch: FileIngestBatch, files: readonly HashedFile[]) => {
    if (batch.status !== "uploading" || isUploading(queryClient, batch.id)) return;
    queryClient.setQueryData(fileIngestKey(batch.id), batch);
    mutation.mutate({ batch, files });
  };
}

export function useUploadState(batchId: () => Uuid | null) {
  const states = useMutationState({
    filters: { mutationKey: uploadKey },
    select: (mutation) => mutation.state as MutationState<void, Error, UploadInput>,
  });
  const latest = $derived(states.findLast((state) => state.variables?.batch.id === batchId()));

  return {
    get running() {
      return latest?.status === "pending";
    },
    get files() {
      return latest?.variables?.files ?? [];
    },
    get failures() {
      return latest?.error instanceof UploadIncomplete ? latest.error.failures : [];
    },
    get error() {
      return latest?.error ? errorMessage(latest.error, "Upload unavailable") : null;
    },
  };
}
