import type { FileIngestBatch, Uuid } from "@great-minds/domain";
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
  commitFileIngestBatch,
  createFileIngestBatch,
  fileIngestManifest,
  getFileIngestBatch,
  resumeFileIngestBatch,
  sendFileIngestFiles,
  type HashedFile,
} from "#lib/api/ingest.ts";
import { auth } from "#lib/auth.svelte.ts";
import { forgetUpload, rememberUpload, type UploadDraft } from "./file-ingest-drafts.svelte";

type UploadInput = {
  readonly batchId: Uuid;
  readonly vaultId: Uuid;
  readonly userId: string;
  readonly files: readonly HashedFile[];
} & (
  | { readonly action: "create"; readonly manifest: UploadDraft["manifest"] }
  | { readonly action: "resume" | "finish" }
);
type Transfers = Awaited<ReturnType<typeof sendFileIngestFiles>>;

export const fileIngestKey = (batchId: Uuid | null, userId = auth.userId) =>
  ["file-ingest", userId, batchId] as const;
const uploadKey = ["file-ingest", "upload"];

const isUploading = (queryClient: QueryClient, batchId: Uuid) =>
  queryClient.isMutating({
    mutationKey: uploadKey,
    predicate: (mutation) => (mutation.state.variables as UploadInput)?.batchId === batchId,
  }) > 0;

export const missingUploadFiles = (batch: FileIngestBatch) =>
  batch.files.filter((file) => file.status === "pending");

function acknowledgeDraft(batch: FileIngestBatch, userId: string | null) {
  if (userId && batch.created_by === userId) forgetUpload(userId, batch.id);
}

export function useFileIngestBatch(
  batchId: () => Uuid | null,
  enabled: () => boolean,
  canResume: (batch: FileIngestBatch) => boolean,
) {
  const queryClient = useQueryClient();
  return createQuery(() => {
    const id = batchId();
    const userId = auth.userId;
    const queryKey = fileIngestKey(id, userId);
    return {
      queryKey,
      queryFn: async ({ signal }) => {
        if (!id) return null;
        const batch = await getFileIngestBatch(id, signal);
        if (!batch) return null;
        acknowledgeDraft(batch, userId);
        if (
          auth.userId !== userId ||
          batch.status !== "uploading" ||
          !canResume(batch) ||
          missingUploadFiles(batch).length === 0
        )
          return batch;
        try {
          return await resumeFileIngestBatch(id, signal);
        } catch (error) {
          if (!signal.aborted) queryClient.setQueryData(queryKey, batch);
          throw error;
        }
      },
      enabled: id !== null && enabled(),
      refetchOnWindowFocus: false,
      refetchOnMount: "always",
    };
  });
}

export function useFileUpload() {
  const queryClient = useQueryClient();
  const mutation = createMutation(() => ({
    mutationKey: uploadKey,
    mutationFn: async (input: UploadInput): Promise<Transfers> => {
      const { action, batchId, vaultId, userId, files } = input;
      const queryKey = fileIngestKey(batchId, userId);
      await queryClient.cancelQueries({ queryKey });
      if (auth.userId !== userId) return [];
      const observe = (batch: FileIngestBatch | null) => {
        if (batch) acknowledgeDraft(batch, userId);
        if (auth.userId === userId) queryClient.setQueryData(queryKey, batch);
      };
      const finish = async () => {
        if (auth.userId !== userId) return;
        await commitFileIngestBatch(batchId);
        if (auth.userId === userId) observe(await getFileIngestBatch(batchId));
      };
      try {
        if (action === "finish") {
          await finish();
          return [];
        }
        let batch =
          action === "create"
            ? await createFileIngestBatch(vaultId, { batch_id: batchId, files: input.manifest })
            : await resumeFileIngestBatch(batchId);
        observe(batch);
        if (batch.status !== "uploading" || auth.userId !== userId) return [];

        const transfers = await sendFileIngestFiles(batch, files);
        if (auth.userId !== userId) return [];
        let ready =
          transfers.length === missingUploadFiles(batch).length &&
          transfers.every(({ error }) => error === null);
        if (!ready && transfers.length > 0) {
          batch = await resumeFileIngestBatch(batchId);
          observe(batch);
          ready = batch.status === "uploading" && missingUploadFiles(batch).length === 0;
        }
        if (ready) await finish();
        return transfers;
      } catch (error) {
        if (auth.userId === userId) {
          const receipt = await getFileIngestBatch(batchId).catch(() => undefined);
          if (receipt !== undefined) observe(receipt);
        }
        throw error;
      } finally {
        void queryClient.invalidateQueries({ queryKey: ["vault", vaultId, "active-job"] });
      }
    },
  }));

  const send = (input: UploadInput) => {
    if (!isUploading(queryClient, input.batchId)) mutation.mutate(input);
  };

  return {
    begin(vaultId: Uuid, files: readonly HashedFile[]) {
      const userId = auth.userId;
      if (!userId) throw new Error("Sign in to start an upload.");
      const draft = rememberUpload(userId, vaultId, fileIngestManifest(files));
      send({ ...draft, userId, action: "create", files });
      return draft.batchId;
    },
    retryStart(draft: UploadDraft, files: readonly HashedFile[]) {
      const userId = auth.userId;
      if (userId) send({ ...draft, userId, action: "create", files });
    },
    advance(batch: FileIngestBatch, files: readonly HashedFile[]) {
      const userId = auth.userId;
      if (batch.status !== "uploading" || !userId || userId !== batch.created_by) return;
      send({
        batchId: batch.id,
        vaultId: batch.vault_id,
        userId,
        action: missingUploadFiles(batch).length > 0 ? "resume" : "finish",
        files,
      });
    },
  };
}

export function useUploadState(batchId: () => Uuid | null) {
  const states = useMutationState({
    filters: { mutationKey: uploadKey },
    select: (mutation) => mutation.state as MutationState<Transfers, Error, UploadInput>,
  });
  const latest = $derived(
    states.findLast(
      (state) => state.variables?.batchId === batchId() && state.variables?.userId === auth.userId,
    ),
  );

  return {
    get running() {
      return latest?.status === "pending";
    },
    get files() {
      return latest?.variables?.files ?? [];
    },
    get failures() {
      return latest?.data ?? [];
    },
    get error() {
      return latest?.error ? errorMessage(latest.error, "Couldn’t continue this upload.") : null;
    },
  };
}
