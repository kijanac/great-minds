<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";

  import {
    continueFileIngest,
    getFileIngestBatch,
    hashFiles,
    resumeFileIngestBatch,
    type FileIngestBatch,
    type HashedFile,
    type UploadFailure,
  } from "$lib/api/ingest";
  import {
    cancelJob,
    listJobs,
    requestCompile,
    startUrlJob,
  } from "$lib/api/jobs";
  import { fetchArticlesByRun } from "$lib/api/wiki";
  import { auth } from "$lib/auth.svelte";
  import PipelineStageRow from "$lib/components/pipeline-stage-row.svelte";
  import {
    Alert,
    AlertDescription,
    AlertTitle,
  } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { useJobSSE } from "$lib/hooks/use-job-sse.svelte";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";

  interface FileUploadState {
    uploadFiles?: HashedFile[];
    batch?: FileIngestBatch;
  }

  const queryClient = useQueryClient();
  const vaults = useVaults();
  let resolvedJobId = $state<string | null>(null);
  let noJobFound = $state(false);
  let resolveError = $state<string | null>(null);
  let uploadFailures = $state<UploadFailure[]>([]);
  let fileBatch = $state<FileIngestBatch | null>(null);
  let routeContextResolved = $state(false);
  let resolvedRouteId = $state<string | null>(null);
  let availableFiles = $state<HashedFile[]>([]);
  let uploadInProgress = $state(false);
  let resolverStarted = $state(false);
  let showCompletion = $state(false);

  const routeJobId = $derived(
    typeof page.params.jobId === "string" ? page.params.jobId : null,
  );
  const jobId = $derived(routeJobId ?? resolvedJobId);
  const urlParam = $derived(page.url.searchParams.get("url"));
  const fileUpload = $derived(page.state as FileUploadState);
  const currentVault = $derived(
    vaults.data?.find((vault) => vault.id === activeVault.id) ?? null,
  );
  const jobVaultId = $derived(
    routeJobId && !routeContextResolved
      ? null
      : (fileBatch?.vault_id ?? activeVault.id ?? null),
  );
  const canManage = $derived(
    fileBatch
      ? fileBatch.created_by === auth.userId
      : currentVault?.owner_id === auth.userId,
  );
  const progress = useJobSSE(
    () => jobId,
    () => jobVaultId,
  );
  const stages = $derived(progress.stages);
  const firstErrored = $derived(stages.find((stage) => stage.errored));
  const receivedFileCount = $derived(
    fileBatch?.files.filter((file) => file.status !== "pending").length ?? 0,
  );
  const awaitingFiles = $derived(
    fileBatch?.status === "uploading" &&
      !uploadInProgress &&
      !progress.overallCancelled &&
      !progress.overallError,
  );
  const isRunning = $derived(
    !noJobFound &&
      !progress.overallDone &&
      !progress.overallError &&
      !progress.overallCancelled &&
      stages.length > 0,
  );

  const result = createQuery(() => ({
    queryKey: ["vault", jobVaultId, "compile-result", jobId],
    queryFn: () => fetchArticlesByRun(jobId!, 8, jobVaultId!),
    enabled: progress.overallDone && !!jobVaultId && !!jobId,
  }));

  $effect(() => {
    const activeStage = stages.find((stage) => stage.active)?.stage;
    if (!activeStage) return;
    void tick().then(() => {
      document
        .querySelector("[data-active-stage]")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  $effect(() => {
    const done = progress.overallDone && !progress.overallError;
    const timeout = window.setTimeout(
      () => {
        showCompletion = done;
      },
      done ? 300 : 0,
    );
    return () => window.clearTimeout(timeout);
  });

  $effect(() => {
    const id = routeJobId;
    const uploadState = fileUpload;
    if (!id) {
      routeContextResolved = true;
      return;
    }
    if (resolvedRouteId === id) return;

    resolvedRouteId = id;
    routeContextResolved = false;
    resolveError = null;
    uploadFailures = [];
    const stateBatch = uploadState?.batch;
    const stateFiles = uploadState?.uploadFiles ?? [];
    availableFiles = stateFiles;

    if (stateBatch?.id === id) {
      fileBatch = stateBatch;
      routeContextResolved = true;
      if (stateFiles.length > 0) void runBatchUpload(stateBatch, stateFiles);
      return;
    }

    void (async () => {
      try {
        let batch = await getFileIngestBatch(id);
        if (batch?.status === "uploading" && batch.created_by === auth.userId) {
          batch = await resumeFileIngestBatch(id);
        }
        if (routeJobId !== id) return;
        fileBatch = batch;
        routeContextResolved = true;
        if (
          batch?.status === "uploading" &&
          batch.files.every((file) => file.status !== "pending")
        ) {
          void runBatchUpload(batch, []);
        }
      } catch (error) {
        if (routeJobId !== id) return;
        routeContextResolved = true;
        resolveError =
          error instanceof Error ? error.message : "Job unavailable";
      }
    })();
  });

  $effect(() => {
    const currentUrl = urlParam;
    const vaultId = activeVault.id;
    if (resolverStarted || routeJobId || !vaultId) return;
    if (currentUrl && !vaults.isFetched) return;
    resolverStarted = true;
    uploadFailures = [];

    if (currentUrl && !canManage) {
      resolveError = "Only vault owners can add sources or update this vault.";
      return;
    }

    void (async () => {
      try {
        if (currentUrl) {
          const run = await startUrlJob(currentUrl);
          await queryClient.invalidateQueries({
            queryKey: ["vault", vaultId, "active-job"],
          });
          resolvedJobId = run.id;
          await goto(`/pipeline/runs/${run.id}`, { replaceState: true });
          return;
        }

        const activeJobs = await listJobs("active");
        if (activeJobs.items.length === 1) {
          const activeJobId = activeJobs.items[0].id;
          resolvedJobId = activeJobId;
          await goto(`/pipeline/runs/${activeJobId}`, {
            replaceState: true,
          });
        } else {
          noJobFound = true;
        }
      } catch (error) {
        resolveError =
          error instanceof Error ? error.message : "Job unavailable";
      }
    })();
  });

  async function runBatchUpload(batch: FileIngestBatch, files: HashedFile[]) {
    if (uploadInProgress || batch.status !== "uploading") return;
    uploadInProgress = true;
    availableFiles = files;
    resolveError = null;
    uploadFailures = [];
    try {
      for await (const event of continueFileIngest(batch, files)) {
        if (event.batch) fileBatch = event.batch;
        if (event.failures && event.failures.length > 0) {
          uploadFailures = event.failures;
        }
        if (event.phase === "error") {
          resolveError = event.error ?? "Upload failed";
          return;
        }
        if (event.phase === "processing") {
          const vaultId = event.batch?.vault_id ?? batch.vault_id;
          await queryClient.invalidateQueries({
            queryKey: ["vault", vaultId, "active-job"],
          });
          availableFiles = [];
          await goto(`/pipeline/runs/${batch.id}`, {
            replaceState: true,
            state: {},
          });
          return;
        }
      }
    } catch (error) {
      resolveError =
        error instanceof Error ? error.message : "Upload unavailable";
      try {
        fileBatch = await getFileIngestBatch(batch.id);
        if (fileBatch?.status === "cancelled") resolveError = null;
      } catch {
        // Keep the last durable snapshot visible; SSE will continue reconnecting.
      }
    } finally {
      uploadInProgress = false;
    }
  }

  function reselectFiles() {
    if (!fileBatch || fileBatch.status !== "uploading" || uploadInProgress) {
      return;
    }
    const batch = fileBatch;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    document.body.appendChild(input);
    input.onchange = () => {
      const selected = Array.from(input.files ?? []);
      input.remove();
      void hashFiles(selected)
        .then((files) => runBatchUpload(batch, files))
        .catch((error) => {
          resolveError =
            error instanceof Error ? error.message : "Files could not be read";
        });
    };
    input.oncancel = () => input.remove();
    input.click();
  }

  async function cancel() {
    if (canManage && jobId && jobVaultId) {
      await cancelJob(jobId, jobVaultId);
      if (fileBatch) {
        fileBatch = {
          ...fileBatch,
          status: "cancelled",
          error: "Update cancelled",
          targets: [],
        };
      }
      resolveError = null;
    }
  }

  async function retry() {
    if (!canManage || !jobVaultId) return;
    const job = await requestCompile(crypto.randomUUID(), jobVaultId);
    await goto(`/pipeline/runs/${job.id}`, { replaceState: true });
  }
</script>

<svelte:head>
  <title>Pipeline | Great Minds</title>
</svelte:head>

<div class="flex h-screen flex-col overflow-hidden">
  <header
    class="flex shrink-0 items-center gap-4 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"
  >
    <Button
      variant="ghost"
      size="icon-xs"
      onclick={() => void goto("/")}
      aria-label="back to home"
      class="text-muted-foreground hover:bg-transparent hover:text-gold"
    >
      <ArrowLeft size={14} />
    </Button>
    {#if isRunning && jobId && jobVaultId && canManage}
      <Button
        variant="ghost"
        size="xs"
        onclick={() => void cancel()}
        class="ml-auto h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-red-400/90"
      >
        cancel
      </Button>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <main class="mx-auto max-w-[640px] px-4 pt-10 pb-20 md:px-10">
      {#if noJobFound && !resolveError}
        <div class="pt-8 text-center">
          <p
            class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim"
          >
            No active job
          </p>
          <p
            class="mb-5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
          >
            drop sources from the home page to start a new ingest
          </p>
          <Button
            variant="ghost"
            size="xs"
            onclick={() => void goto("/")}
            class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-dim hover:bg-transparent hover:text-gold"
          >
            back to home
          </Button>
        </div>
      {/if}

      {#if !noJobFound && stages.length === 0 && !progress.overallError && !resolveError}
        <div class="space-y-3">
          <Skeleton class="h-4 w-28 bg-ink-raised" />
          <Skeleton class="h-12 w-full bg-ink-raised" />
          <Skeleton class="h-12 w-5/6 bg-ink-raised" />
        </div>
      {/if}

      {#if awaitingFiles && !resolveError}
        <div class="mb-8 rounded-sm border border-gold-dim bg-ink-raised p-5">
          <p
            class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim"
          >
            Upload paused
          </p>
          <p
            class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
          >
            {receivedFileCount} of {fileBatch?.files.length ?? 0} files received ·
            reselect the missing files to continue
          </p>
          {#if canManage}
            <Button
              variant="ghost"
              size="xs"
              onclick={reselectFiles}
              class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover"
            >
              reselect files
            </Button>
          {/if}
        </div>
      {/if}

      {#if progress.overallError || resolveError}
        <Alert
          variant="destructive"
          class="mb-10 rounded-sm border-red-400/25 bg-red-400/5 p-5"
        >
          <AlertTitle
            class="mb-3 font-serif text-[length:var(--text-body)] text-warm-dim"
          >
            Something went wrong during {fileBatch?.status === "uploading"
              ? "uploading"
              : firstErrored
                ? firstErrored.label.toLowerCase()
                : "processing"}.
          </AlertTitle>
          <AlertDescription
            class="mb-4 font-mono text-[length:var(--text-chrome)] text-red-400/90"
          >
            <p>{progress.overallError ?? resolveError}</p>
            {#if uploadFailures.length > 0}
              <ul class="mt-3 space-y-1 text-warm-faint">
                {#each uploadFailures as failure}
                  <li class="[overflow-wrap:anywhere]">
                    <span class="text-warm-dim">{failure.name}</span>: {failure.error}
                  </li>
                {/each}
              </ul>
            {/if}
          </AlertDescription>
          <div class="flex flex-wrap items-center gap-4">
            {#if canManage && fileBatch?.status === "uploading"}
              {#if availableFiles.length > 0}
                <Button
                  variant="ghost"
                  size="xs"
                  onclick={() => {
                    if (fileBatch)
                      void runBatchUpload(fileBatch, availableFiles);
                  }}
                  class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover"
                >
                  retry upload
                </Button>
              {/if}
              <Button
                variant="ghost"
                size="xs"
                onclick={reselectFiles}
                class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover"
              >
                reselect files
              </Button>
            {:else if canManage && !resolveError}
              <Button
                variant="ghost"
                size="xs"
                onclick={() => void retry()}
                class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover"
              >
                {firstErrored?.stage === "uploading"
                  ? "compile saved files"
                  : "run again"}
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="xs"
              onclick={() => void goto("/")}
              class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
            >
              back to home
            </Button>
          </div>
        </Alert>
      {/if}

      {#if progress.overallCancelled}
        <div
          class="mb-10 rounded-sm border border-ink-border bg-ink-raised p-5"
        >
          <p
            class="mb-4 font-serif text-[length:var(--text-body)] text-warm-dim"
          >
            Update cancelled
          </p>
          <div class="flex items-center gap-4">
            {#if canManage}
              <Button
                variant="ghost"
                size="xs"
                onclick={() => void retry()}
                class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover"
              >
                run again
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="xs"
              onclick={() => void goto("/")}
              class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
            >
              back to home
            </Button>
          </div>
        </div>
      {/if}

      {#if !noJobFound && stages.length > 0}
        {#each stages as stage, index (stage.stage)}
          <div
            in:fly={{
              x: -8,
              duration: 250,
              delay: stage.complete ? 0 : Math.min(index * 50, 300),
              easing: cubicOut,
            }}
          >
            <PipelineStageRow {stage} />
          </div>
        {/each}
      {/if}

      {#if !noJobFound && progress.overallDone && !progress.overallError && showCompletion}
        <div
          class="mt-10 rounded-sm border border-gold-dim bg-ink-raised p-6"
          in:fly={{ y: 8, duration: 300, easing: cubicOut }}
        >
          <p
            class="mb-1 font-serif text-[length:var(--text-body)] text-warm-dim"
          >
            Knowledge base updated
          </p>
          {#if result.data}
            <p
              class="mb-5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
            >
              {result.data.pagination.total === 0
                ? "Already up to date — nothing changed"
                : `${result.data.pagination.total} ${result.data.pagination.total === 1 ? "article" : "articles"} written`}
            </p>
            {#if result.data.items.length > 0}
              <ul class="mb-6 space-y-1.5">
                {#each result.data.items as article (article.slug)}
                  <li>
                    <button
                      type="button"
                      onclick={() => void goto(`/doc/${article.file_path}`)}
                      class="text-left font-serif text-[length:var(--text-small)] text-gold-dim transition-colors hover:text-gold"
                    >
                      {article.title}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
          <div class="flex items-center gap-4">
            <Button
              variant="ghost"
              size="xs"
              onclick={() => void goto("/library")}
              class="h-auto rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover"
            >
              browse the library
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onclick={() => void goto("/")}
              class="h-auto rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
            >
              back to home
            </Button>
          </div>
        </div>
      {/if}
    </main>
  </div>
</div>
