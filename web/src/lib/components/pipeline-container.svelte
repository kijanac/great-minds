<script lang="ts">
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Uuid } from "@great-minds/domain";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";

  import { errorMessage, newUuid } from "@great-minds/client";
  import { hashFiles, type HashedFile } from "#lib/api/ingest.ts";
  import { cancelJob, requestCompile, retryUrlJob, startUrlJob } from "#lib/api/jobs.ts";
  import { auth } from "#lib/auth.svelte.ts";
  import RunOutcome from "#lib/components/run-outcome.svelte";
  import RunProgress from "#lib/components/run-progress.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { fileIngestDrafts, forgetUpload } from "#lib/hooks/file-ingest-drafts.svelte.ts";
  import { useActiveJobs } from "#lib/hooks/use-active-job.svelte.ts";
  import {
    fileIngestKey,
    missingUploadFiles,
    useFileIngestBatch,
    useFileUpload,
    useUploadState,
  } from "#lib/hooks/use-file-ingest.svelte.ts";
  import { useJobSSE } from "#lib/hooks/use-job-sse.svelte.ts";
  import { useMe } from "#lib/hooks/use-me.svelte.ts";
  import { activeVault, useVaults } from "#lib/hooks/use-vault.svelte.ts";

  let { routeJobId = null }: { routeJobId?: Uuid | null } = $props();

  const queryClient = useQueryClient();
  const vaults = useVaults();
  const me = useMe();
  let pageError = $state<string | null>(null);
  let resolverStarted = $state(false);
  let actionError = $state<string | null>(null);
  let readingFiles = $state(false);
  let picker: HTMLInputElement;
  let componentActive = true;
  let navigationEpoch = 0;

  beforeNavigate(({ shallow, type }) => {
    if (shallow && type === "goto") return;

    navigationEpoch += 1;
  });
  onDestroy(() => {
    componentActive = false;
  });

  const draft = $derived(fileIngestDrafts().find((draft) => draft.batchId === routeJobId));
  const upload = useUploadState(() => routeJobId);
  const sendUpload = useFileUpload();
  const batchQuery = useFileIngestBatch(
    () => routeJobId,
    () => vaults.isFetched && !upload.running,
    (batch) => ownsVault(batch.vault_id) && batch.created_by === auth.userId,
  );
  const fileBatch = $derived(batchQuery.data ?? null);
  const lookupError = $derived(
    batchQuery.error ? errorMessage(batchQuery.error, "Couldn’t check this upload.") : null,
  );
  const resolveError = $derived(pageError ?? (!draft && !fileBatch ? lookupError : null));
  const urlParam = $derived(page.url.searchParams.get("url"));
  const viewingActiveJobs = $derived(!routeJobId && !urlParam);
  const activeJobs = useActiveJobs(() => (viewingActiveJobs ? activeVault.id : null));
  const jobVaultId = $derived(
    fileBatch?.vault_id ?? (routeJobId && (!batchQuery.isSuccess || draft) ? null : activeVault.id),
  );
  const canManage = $derived(
    ownsVault(jobVaultId) && (!fileBatch || fileBatch.created_by === auth.userId),
  );

  const progress = useJobSSE(
    () => routeJobId,
    () => jobVaultId,
  );
  const firstErrored = $derived(progress.track.find((stage) => stage.status === "failed"));
  const isRunning = $derived(
    !progress.overallDone && !progress.overallError && !progress.overallCancelled,
  );
  const missing = $derived(fileBatch ? missingUploadFiles(fileBatch) : []);
  const missingHashes = $derived(new Set(missing.map((file) => file.hash)));
  const retryFiles = $derived(upload.files.filter((file) => missingHashes.has(file.hash)));
  const transferErrors = $derived(new Map(upload.failures.map(({ hash, error }) => [hash, error])));
  const uploadError = $derived(upload.error ?? lookupError);
  const uploadStatus = $derived.by(() => {
    if (readingFiles) return "Checking selected files…";
    if (!fileBatch && upload.running) return "Starting upload…";
    if (!fileBatch && batchQuery.isPending) return "Checking upload…";
    if (!upload.running) return null;
    return missing.length === 0 ? "Finishing upload…" : "Uploading files…";
  });

  function ownsVault(vaultId: Uuid | null) {
    return (
      auth.userId !== null &&
      vaults.data?.some((vault) => vault.id === vaultId && vault.owner_id === auth.userId) === true
    );
  }

  function captureRouteOwnership(predicate: () => boolean): () => boolean {
    const epoch = navigationEpoch;
    return () => componentActive && navigationEpoch === epoch && predicate();
  }

  $effect(() => {
    const currentUrl = urlParam;
    const vaultId = activeVault.id;
    if (resolverStarted || routeJobId || !vaultId || !currentUrl || !vaults.isFetched) return;
    resolverStarted = true;
    const ownsResolver = captureRouteOwnership(
      () => routeJobId === null && page.url.pathname === "/pipeline" && urlParam === currentUrl,
    );
    if (!canManage) {
      pageError = "Only vault owners can add sources or update this vault.";
      return;
    }

    void (async () => {
      try {
        const run = await startUrlJob(currentUrl);
        await queryClient.invalidateQueries({ queryKey: ["vault", vaultId, "active-job"] });
        if (!ownsResolver()) return;
        await goto(`/pipeline/runs/${run.id}`, { replace: true });
      } catch (error) {
        if (ownsResolver()) pageError = errorMessage(error, "Job unavailable");
      }
    })();
  });

  function startAgain() {
    if (!draft || !ownsVault(draft.vaultId) || upload.running) return;
    actionError = null;
    sendUpload.retryStart(draft, upload.files);
  }

  async function discardAttempt() {
    if (!draft || !auth.userId || fileBatch || upload.running) return;
    try {
      forgetUpload(auth.userId, draft.batchId);
      await goto("/", { replace: true });
    } catch {
      actionError = "Couldn’t discard this attempt. Try again.";
    }
  }

  function uploadFiles(files: readonly HashedFile[]) {
    if (!canManage || !fileBatch || !isRunning || upload.running) return;
    actionError = null;
    sendUpload.advance(fileBatch, files);
  }

  async function reselectFiles() {
    const selected = Array.from(picker.files ?? []);
    picker.value = "";
    if (selected.length === 0 || readingFiles || upload.running || !fileBatch || !canManage) return;
    const batchId = fileBatch.id;
    const ownsSelection = captureRouteOwnership(() => routeJobId === batchId);
    readingFiles = true;
    actionError = null;
    try {
      const files = (await hashFiles(selected)).filter((file) => missingHashes.has(file.hash));
      if (!ownsSelection()) return;
      if (files.length > 0) uploadFiles([...retryFiles, ...files]);
      else actionError = "None of the selected files match the files still missing.";
    } catch (error) {
      if (ownsSelection()) actionError = errorMessage(error, "Couldn’t read the selected files.");
    } finally {
      readingFiles = false;
    }
  }

  async function cancel() {
    const id = routeJobId;
    const userId = auth.userId;
    if (!canManage || !id || !jobVaultId) return;
    const ownsAction = captureRouteOwnership(() => routeJobId === id && auth.userId === userId);
    actionError = null;
    try {
      await cancelJob(id, jobVaultId);
      void queryClient.invalidateQueries({ queryKey: fileIngestKey(id, userId) });
    } catch (error) {
      if (ownsAction()) actionError = errorMessage(error, "Couldn’t cancel this run.");
    }
  }

  async function retry() {
    if (!canManage || !jobVaultId || !routeJobId) return;
    actionError = null;
    const nextId = newUuid();
    try {
      const job =
        progress.trigger === "url" && progress.backendPhase === "source_ingest"
          ? await retryUrlJob(routeJobId, nextId, jobVaultId)
          : await requestCompile(nextId, jobVaultId);
      await goto(`/pipeline/runs/${job.id}`, { replace: true });
    } catch (error) {
      actionError = errorMessage(error, "Couldn’t start a new run.");
    }
  }
</script>

<svelte:head>
  <title>Pipeline | Great Minds</title>
</svelte:head>

<div class="flex h-dvh flex-col overflow-hidden">
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
    {#if isRunning && routeJobId && jobVaultId && canManage}
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
      {#if actionError}
        <Alert variant="destructive" class="mb-8 rounded-sm border-red-400/25 bg-red-400/5">
          <AlertDescription
            class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-red-400/90"
          >
            {actionError}
          </AlertDescription>
        </Alert>
      {/if}

      {#snippet uploadButton(label: string, action: () => void, disabled = false)}
        <Button
          variant="outline"
          size="xs"
          onclick={action}
          {disabled}
          class="h-auto rounded-sm border-gold-dim px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold uppercase hover:bg-gold/10"
        >
          {label}
        </Button>
      {/snippet}

      {#if viewingActiveJobs}
        <h1 class="mb-6 font-serif text-[length:var(--text-title)] text-warm">Active runs</h1>
        {#if activeJobs.entries.length > 0}
          <ul class="divide-y divide-ink-subtle border-y border-ink-subtle">
            {#each activeJobs.entries as entry (entry.id)}
              <li>
                <a
                  href={`/pipeline/runs/${entry.id}`}
                  class="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 py-3 text-warm-dim hover:text-gold [overflow-wrap:anywhere]"
                >
                  <span class="font-serif text-[length:var(--text-body)]">{entry.title}</span>
                  <span class="font-mono text-[length:var(--text-chrome)] text-warm-ghost">
                    {entry.detail}
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="mt-4 font-mono text-[length:var(--text-chrome)] text-warm-faint">
          {#if activeJobs.query.isError}
            <p class="mb-3" role="alert">Couldn’t load active runs.</p>
            {@render uploadButton("Try again", () => void activeJobs.query.refetch())}
          {:else if activeJobs.query.isPending}
            <p role="status">Loading runs…</p>
          {:else if activeJobs.entries.length === 0}
            <p>No active runs.</p>
          {:else if activeJobs.query.hasNextPage}
            {@render uploadButton(
              "Load more",
              () => void activeJobs.query.fetchNextPage(),
              activeJobs.query.isFetching,
            )}
          {/if}
        </div>
      {/if}

      {#if (draft && !fileBatch) || (fileBatch?.status === "uploading" && isRunning)}
        {#if uploadStatus}
          <p role="status" class="mb-6 font-serif text-[length:var(--text-body)] text-warm-dim">
            {uploadStatus}
          </p>
        {:else}
          <section class="mb-8 rounded-sm border border-gold-dim bg-ink-raised p-5">
            <h1 class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim">
              {!fileBatch
                ? "Upload not confirmed"
                : missing.length === 0
                  ? "Ready to finish"
                  : "Upload paused"}
            </h1>
            {#if fileBatch}
              <p class="mb-3 font-mono text-[length:var(--text-chrome)] text-warm-faint">
                {fileBatch.files.length - missing.length} of {fileBatch.files.length} files received
              </p>
              {#if missing.length > 0}
                <ul
                  aria-label="Missing files"
                  class="mb-4 max-h-48 space-y-1 overflow-y-auto font-mono text-[length:var(--text-chrome)] text-warm-faint"
                >
                  {#each missing as file (file.hash)}
                    {@const error = transferErrors.get(file.hash)}
                    <li class="[overflow-wrap:anywhere]">
                      {file.name}{error ? ` · ${error}` : ""}
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
            {#if uploadError}
              <p
                role="alert"
                class="mb-4 font-mono text-[length:var(--text-chrome)] text-red-400/90 [overflow-wrap:anywhere]"
              >
                {uploadError}
              </p>
            {/if}
            <div class="flex flex-wrap gap-3">
              {#if !fileBatch && draft}
                {#if ownsVault(draft.vaultId)}
                  {@render uploadButton("Retry starting upload", startAgain, !me.canUseModels)}
                {/if}
                <Button variant="ghost" size="xs" onclick={() => void discardAttempt()}
                  >Discard attempt</Button
                >
              {:else if canManage}
                {#if missing.length === 0}
                  {@render uploadButton("Finish upload", () => uploadFiles([]), !me.canUseModels)}
                {:else}
                  {#if retryFiles.length > 0}
                    {@render uploadButton("Retry upload", () => uploadFiles(retryFiles))}
                  {/if}
                  {@render uploadButton("Reselect files", () => picker.click())}
                {/if}
              {/if}
            </div>
          </section>
        {/if}
      {/if}
      <input type="file" multiple hidden bind:this={picker} onchange={() => void reselectFiles()} />

      {#if progress.streamError && !resolveError}
        <div class="mb-8 rounded-sm border border-gold-dim bg-ink-raised p-5">
          <p
            class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
          >
            Lost touch with this run: {progress.streamError}
          </p>
          <Button
            variant="ghost"
            size="xs"
            onclick={() => progress.reconnect()}
            class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover"
          >
            reconnect
          </Button>
        </div>
      {/if}

      {#snippet browseLibrary()}
        <Button
          variant="ghost"
          size="xs"
          onclick={() => void goto("/library")}
          class="h-auto rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost uppercase hover:bg-transparent hover:text-warm-faint"
        >
          Browse the library
        </Button>
      {/snippet}

      {#if progress.overallError || resolveError}
        {#snippet failedActions()}
          <div class="mb-8 flex flex-wrap items-center gap-3">
            {#if lookupError && resolveError}
              {@render uploadButton("Try again", () => void batchQuery.refetch())}
            {:else if canManage && !resolveError && fileBatch?.status !== "uploading"}
              {@render uploadButton(
                progress.trigger === "url" && progress.backendPhase === "source_ingest"
                  ? "Retry URL"
                  : firstErrored?.key === "upload"
                    ? "Compile saved files"
                    : "Run again",
                () => void retry(),
                !me.canUseModels,
              )}
            {/if}
            {@render browseLibrary()}
          </div>
        {/snippet}
        <div class="mb-10">
          {#if fileBatch?.status === "uploading" || resolveError}
            <h1
              class="mt-1 mb-6 font-serif text-[length:var(--text-title)] leading-[1.25] text-warm"
            >
              {resolveError ? "Couldn’t load this run" : "Upload stopped"}
            </h1>
            {@render failedActions()}
          {:else}
            <RunOutcome
              outcome={progress.outcome}
              onOpen={(filePath) => void goto(`/doc/${filePath}`)}
              stopped={{ kind: "failed", stage: firstErrored?.title ?? null }}
              actions={failedActions}
            />
          {/if}
          <details>
            <summary
              class="cursor-pointer font-mono text-[length:var(--text-chrome)] text-warm-ghost hover:text-warm-faint"
            >
              Details
            </summary>
            <p
              class="mt-2 font-mono text-[length:var(--text-chrome)] text-red-400/90 [overflow-wrap:anywhere]"
            >
              {progress.overallError ?? resolveError}
            </p>
          </details>
        </div>
      {/if}

      {#if progress.overallCancelled}
        {#snippet cancelledActions()}
          <div class="mb-8 flex flex-wrap items-center gap-3">
            {#if canManage}
              <Button
                variant="outline"
                size="xs"
                onclick={() => void retry()}
                disabled={!me.canUseModels}
                class="h-auto rounded-sm border-gold-dim px-3 py-1.5 disabled:opacity-45 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold uppercase hover:bg-gold/10"
              >
                Run again
              </Button>
            {/if}
            {@render browseLibrary()}
          </div>
        {/snippet}
        <div class="mb-10">
          <RunOutcome
            outcome={progress.outcome}
            onOpen={(filePath) => void goto(`/doc/${filePath}`)}
            stopped={{ kind: "cancelled", stage: null }}
            actions={cancelledActions}
          />
        </div>
      {/if}

      {#if progress.overallDone && !progress.overallError}
        <div in:fly={{ y: 8, duration: 300, easing: cubicOut }}>
          <RunOutcome
            outcome={progress.outcome}
            onOpen={(filePath) => void goto(`/doc/${filePath}`)}
          />
          <Button
            variant="outline"
            size="sm"
            onclick={() => void goto("/library")}
            class="mt-1 mb-10 rounded-sm border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold uppercase hover:bg-gold/10"
          >
            Browse the library
          </Button>
        </div>
      {/if}

      {#if progress.track.length > 0}
        <RunProgress
          track={progress.track}
          running={progress.running && fileBatch?.status !== "uploading"}
          startedAt={progress.startedAt}
          completedAt={progress.overallDone ? progress.completedAt : null}
        />
      {/if}
    </main>
  </div>
</div>
