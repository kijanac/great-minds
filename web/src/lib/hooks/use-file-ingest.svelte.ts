import type { FileIngestBatch, Uuid } from "@great-minds/domain";
import {
  createMutation,
  createQuery,
  useMutationState,
  useQueryClient,
  type MutationState,
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

type UploadCommand = Pick<UploadDraft, "batchId" | "vaultId"> & {
  readonly files: readonly HashedFile[];
} & (
    | { readonly action: "create"; readonly manifest: UploadDraft["manifest"] }
    | { readonly action: "resume" | "finish" }
  );
type UploadInput = UploadCommand & { readonly userId: string };
type Transfers = Awaited<ReturnType<typeof sendFileIngestFiles>>;

export const fileIngestKey = (batchId: Uuid | null, userId = auth.userId) =>
  ["file-ingest", userId, batchId] as const;
const uploadKey = ["file-ingest", "upload"];

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
        if (!batch || auth.userId !== userId) return batch;
        acknowledgeDraft(batch, userId);
        if (
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
      const sameAccount = () => auth.userId === userId;
      await queryClient.cancelQueries({ queryKey });
      if (!sameAccount()) return [];

      const observe = (receipt: FileIngestBatch | null) => {
        if (!sameAccount()) return;
        if (receipt) acknowledgeDraft(receipt, userId);
        queryClient.setQueryData(queryKey, receipt);
      };
      const refresh = async () => {
        if (sameAccount()) observe(await getFileIngestBatch(batchId));
      };
      let transfers: Transfers = [];
      try {
        if (action !== "finish") {
          const batch =
            action === "create"
              ? await createFileIngestBatch(vaultId, { batch_id: batchId, files: input.manifest })
              : await resumeFileIngestBatch(batchId);
          observe(batch);
          if (!sameAccount() || batch.status !== "uploading") return [];

          transfers = await sendFileIngestFiles(batch, files);
          if (!sameAccount()) return [];
          if (
            transfers.length !== missingUploadFiles(batch).length ||
            transfers.some(({ error }) => error !== null)
          ) {
            if (transfers.length === 0) return transfers;
            const receipt = await resumeFileIngestBatch(batchId);
            observe(receipt);
            if (receipt.status !== "uploading" || missingUploadFiles(receipt).length > 0)
              return transfers;
          }
        }
        if (sameAccount()) await commitFileIngestBatch(batchId);
        await refresh();
        return transfers;
      } catch (error) {
        await refresh().catch(() => undefined);
        throw error;
      }
    },
    onSettled: (_data, _error, { vaultId }) => {
      void queryClient.invalidateQueries({ queryKey: ["vault", vaultId, "active-job"] });
    },
  }));

  const send = (command: UploadCommand) => {
    const userId = auth.userId;
    if (
      !userId ||
      queryClient.isMutating({
        mutationKey: uploadKey,
        exact: true,
        predicate: ({ state: { variables } }) =>
          typeof variables === "object" &&
          variables !== null &&
          "batchId" in variables &&
          variables.batchId === command.batchId,
      })
    )
      return;
    mutation.mutate({ ...command, userId });
  };

  const create = (draft: UploadDraft, files: readonly HashedFile[]) =>
    send({ ...draft, action: "create", files });

  return {
    begin(vaultId: Uuid, files: readonly HashedFile[]) {
      const userId = auth.userId;
      if (!userId) throw new Error("Sign in to start an upload.");
      const draft = rememberUpload(userId, vaultId, fileIngestManifest(files));
      create(draft, files);
      return draft.batchId;
    },
    retryStart: create,
    advance(batch: FileIngestBatch, files: readonly HashedFile[]) {
      if (batch.status !== "uploading" || batch.created_by !== auth.userId) return;
      send({
        batchId: batch.id,
        vaultId: batch.vault_id,
        action: missingUploadFiles(batch).length > 0 ? "resume" : "finish",
        files,
      });
    },
  };
}

export function useUploadState(batchId: () => Uuid | null) {
  const states = useMutationState<MutationState<Transfers, Error, UploadInput>>({
    filters: { mutationKey: uploadKey, exact: true },
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
