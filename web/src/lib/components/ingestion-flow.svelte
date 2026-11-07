<script lang="ts">
  import { beforeNavigate, goto } from "$app/navigation";
  import { uploadKind, type Uuid } from "@great-minds/domain";
  import { Effect } from "effect";
  import { onMount } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade, slide } from "svelte/transition";

  import {
    checkDupes,
    createFileIngestBatch,
    hashFile,
    type HashedFile,
  } from "$lib/api/ingest";
  import { run } from "$lib/api/app";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { newUuid } from "@great-minds/client";
  import type { DroppedFile } from "$lib/types";

  const HASH_CONCURRENCY = 4;

  interface FileBase {
    id: Uuid;
    file: File;
    path: string;
  }

  interface CheckingFile extends FileBase {
    status: "checking";
    selected: true;
  }

  interface HashedIngestableFile extends FileBase {
    status: "unique" | "duplicate-in-batch" | "duplicate-in-vault";
    hash: HashedFile["hash"];
    selected: boolean;
  }

  interface UnsupportedFile extends FileBase {
    status: "unsupported";
    selected: false;
  }

  interface FailedFile extends FileBase {
    status: "error";
    selected: false;
    error: string;
  }

  type IngestableFile =
    CheckingFile | HashedIngestableFile | UnsupportedFile | FailedFile;

  function isHashedFile(file: IngestableFile): file is HashedIngestableFile {
    return (
      file.status === "unique" ||
      file.status === "duplicate-in-batch" ||
      file.status === "duplicate-in-vault"
    );
  }

  let {
    hasActivePipeline,
    vaultName,
    locked = false,
  }: {
    hasActivePipeline: boolean;
    vaultName: string;
    locked?: boolean;
  } = $props();

  function isSelectableFile(
    file: IngestableFile,
  ): file is HashedIngestableFile {
    return file.status === "unique";
  }

  let expanded = $state(false);
  let isDragOver = $state(false);
  let url = $state("");
  let files = $state<IngestableFile[]>([]);
  let dragCounter = 0;
  let hashRunId = 0;
  let checkingVault = $state(false);
  let creatingBatch = $state(false);
  let importError = $state<string | null>(null);
  let showInVault = $state(false);
  let zone: HTMLDivElement;
  let componentActive = true;
  let navigationEpoch = 0;

  beforeNavigate(() => {
    navigationEpoch += 1;
  });

  function captureNavigationOwnership(): () => boolean {
    const epoch = navigationEpoch;
    return () => componentActive && navigationEpoch === epoch;
  }

  const hasFiles = $derived(files.length > 0);
  const selectedFiles = $derived(
    files.filter(
      (file): file is HashedIngestableFile =>
        isSelectableFile(file) && file.selected,
    ),
  );
  const selectedCount = $derived(selectedFiles.length);
  const checkingCount = $derived(
    files.filter((file) => file.status === "checking").length,
  );
  const dupBatchCount = $derived(
    files.filter((file) => file.status === "duplicate-in-batch").length,
  );
  const dupVaultCount = $derived(
    files.filter((file) => file.status === "duplicate-in-vault").length,
  );
  const unsupportedCount = $derived(
    files.filter((file) => file.status === "unsupported").length,
  );
  const selectedSize = $derived(
    selectedFiles.reduce((total, file) => total + file.file.size, 0),
  );
  const sharedFolder = $derived(commonFolder(files.map((file) => file.path)));
  const shownFiles = $derived(
    showInVault
      ? files
      : files.filter((file) => file.status !== "duplicate-in-vault"),
  );

  function commonFolder(paths: readonly string[]): string {
    const folders = paths.map((path) => path.split("/").slice(0, -1));
    const [first, ...rest] = folders;
    if (first === undefined) return "";
    let depth = 0;
    while (
      depth < first.length &&
      rest.every((folder) => folder[depth] === first[depth])
    )
      depth += 1;
    return depth === 0 ? "" : `${first.slice(0, depth).join("/")}/`;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function supportsUpload(file: File): boolean {
    return uploadKind(file.name, file.type) !== null;
  }

  async function filesFromDrop(
    dataTransfer: DataTransfer,
  ): Promise<DroppedFile[]> {
    const entries = Array.from(dataTransfer.items)
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => entry != null);

    if (entries.length > 0) return collectAll(entries, "");
    return Array.from(dataTransfer.files).map((file) => ({
      file,
      path: file.name,
    }));
  }

  function readFailure(
    kind: "file" | "folder",
    path: string,
    cause: unknown,
  ): Error {
    const reason =
      cause instanceof Error ? cause.message || cause.name : String(cause);
    return new Error(`Unable to read ${kind} ${path}: ${reason}`);
  }

  function readFileEntry(
    entry: FileSystemFileEntry,
    path: string,
  ): Promise<File> {
    return new Promise((resolve, reject) =>
      entry.file(resolve, (cause) => reject(readFailure("file", path, cause))),
    );
  }

  function readDirectoryBatch(
    reader: FileSystemDirectoryReader,
    path: string,
  ): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) =>
      reader.readEntries(resolve, (cause) =>
        reject(readFailure("folder", path, cause)),
      ),
    );
  }

  async function collectAll(
    entries: FileSystemEntry[],
    prefix: string,
  ): Promise<DroppedFile[]> {
    const results: DroppedFile[] = [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile) {
        const file = await readFileEntry(entry as FileSystemFileEntry, path);
        results.push({ file, path });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const children: FileSystemEntry[] = [];
        let batch: FileSystemEntry[];
        do {
          batch = await readDirectoryBatch(reader, path);
          children.push(...batch);
        } while (batch.length > 0);
        results.push(...(await collectAll(children, path)));
      }
    }
    return results;
  }

  function initialIngestable(dropped: DroppedFile[]): IngestableFile[] {
    return dropped.map(({ file, path }) => {
      const base = { id: newUuid(), file, path };
      return supportsUpload(file)
        ? { ...base, status: "checking", selected: true }
        : { ...base, status: "unsupported", selected: false };
    });
  }

  function close() {
    expanded = false;
    files = [];
    checkingVault = false;
    importError = null;
    showInVault = false;
    hashRunId += 1;
    url = "";
  }

  onMount(() => {
    let dragDepth = 0;
    const handleMouseDown = (event: MouseEvent) => {
      if (expanded && zone && !zone.contains(event.target as Node)) close();
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (expanded && event.key === "Escape") close();
    };
    const handleDragEnter = (event: DragEvent) => {
      event.preventDefault();
      dragDepth += 1;
      if (dragDepth > 0 && !expanded) expanded = true;
    };
    const handleDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
    };
    const handleDragOver = (event: DragEvent) => event.preventDefault();
    // Deliberately do not stop propagation. The innermost drop handler must
    // receive the DataTransfer before this document-level cleanup runs.
    const handleDocumentDrop = (event: DragEvent) => {
      event.preventDefault();
      dragDepth = 0;
    };

    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeydown);
    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDocumentDrop);
    return () => {
      componentActive = false;
      hashRunId += 1;
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDocumentDrop);
    };
  });

  function applyHash(
    current: IngestableFile[],
    id: Uuid,
    hash: HashedFile["hash"],
  ): IngestableFile[] {
    const duplicate = current.some(
      (file) => file.id !== id && isHashedFile(file) && file.hash === hash,
    );
    return current.map((file) =>
      file.id === id && file.status === "checking"
        ? {
            ...file,
            hash,
            status: duplicate ? "duplicate-in-batch" : "unique",
            selected: !duplicate,
          }
        : file,
    );
  }

  async function runHashingPipeline(initial: IngestableFile[]) {
    hashRunId += 1;
    const runId = hashRunId;

    await run(
      Effect.forEach(
        initial,
        (item) =>
          Effect.promise(async () => {
            if (hashRunId !== runId || item.status !== "checking") return;
            try {
              const hash = await hashFile(item.file);
              if (hashRunId !== runId) return;
              files = applyHash(files, item.id, hash);
            } catch (error) {
              if (hashRunId !== runId) return;
              files = files.map((file) =>
                file.id === item.id && file.status === "checking"
                  ? {
                      ...file,
                      status: "error",
                      selected: false,
                      error:
                        error instanceof Error ? error.message : "hash failed",
                    }
                  : file,
              );
            }
          }),
        { concurrency: HASH_CONCURRENCY, discard: true },
      ),
    );
    if (hashRunId !== runId) return;

    const hashes = files.filter(isHashedFile).map((file) => file.hash);
    if (hashes.length === 0) return;
    checkingVault = true;
    try {
      const existing = await checkDupes(Array.from(new Set(hashes)));
      if (hashRunId !== runId || existing.size === 0) return;
      files = files.map((file) =>
        isHashedFile(file) && existing.has(file.hash)
          ? { ...file, status: "duplicate-in-vault", selected: false }
          : file,
      );
    } finally {
      if (hashRunId === runId) checkingVault = false;
    }
  }

  function startWithFiles(dropped: DroppedFile[]) {
    if (dropped.length === 0) return;
    checkingVault = false;
    importError = null;
    const initial = initialIngestable(dropped);
    files = initial;
    void runHashingPipeline(initial);
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragCounter = 0;
    isDragOver = false;
    try {
      startWithFiles(await filesFromDrop(event.dataTransfer!));
    } catch (error) {
      importError =
        error instanceof Error ? error.message : "Unable to read dropped items";
    }
  }

  function handleBrowse() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.hidden = true;
    // In the DOM so the document owns it while the native dialog is open;
    // an unreferenced detached input can be GC'd before change fires.
    document.body.appendChild(input);
    input.onchange = () => {
      const picked = Array.from(input.files ?? []);
      input.remove();
      startWithFiles(
        picked.map((file) => ({
          file,
          path:
            (file as File & { webkitRelativePath?: string })
              .webkitRelativePath || file.name,
        })),
      );
    };
    input.oncancel = () => input.remove();
    input.click();
  }

  function submitUrl() {
    const trimmed = url.trim();
    if (trimmed) void goto(`/pipeline?url=${encodeURIComponent(trimmed)}`);
  }

  function toggleSelected(id: Uuid) {
    files = files.map((file) =>
      file.id === id && isSelectableFile(file)
        ? { ...file, selected: !file.selected }
        : file,
    );
  }

  async function confirm() {
    const uploadFiles: HashedFile[] = selectedFiles.map((item) => ({
      file: item.file,
      hash: item.hash,
    }));
    if (uploadFiles.length === 0 || creatingBatch) return;

    const ownsNavigation = captureNavigationOwnership();
    creatingBatch = true;
    importError = null;
    try {
      const batch = await createFileIngestBatch(uploadFiles);
      if (!ownsNavigation()) return;
      files = [];
      await goto(`/pipeline/runs/${batch.id}`, {
        state: { uploadFiles, batch },
      });
    } catch (error) {
      if (!ownsNavigation()) return;
      importError =
        error instanceof Error ? error.message : "Unable to start file upload";
    } finally {
      if (componentActive) creatingBatch = false;
    }
  }

  function handleCircleClick() {
    if (hasActivePipeline) void goto("/pipeline");
    else expanded = true;
  }

  function statusLabel(status: IngestableFile["status"]): string {
    switch (status) {
      case "checking":
        return "checking…";
      case "unique":
        return "";
      case "duplicate-in-batch":
        return "repeated";
      case "duplicate-in-vault":
        return "already in vault";
      case "unsupported":
        return "can't be read";
      case "error":
        return "error";
    }
  }
</script>

<div
  role="group"
  class="flex w-full flex-col items-center"
  bind:this={zone}
  ondragenter={expanded
    ? (event) => {
        event.preventDefault();
        dragCounter += 1;
        isDragOver = true;
      }
    : undefined}
  ondragover={expanded ? (event) => event.preventDefault() : undefined}
  ondragleave={expanded
    ? (event) => {
        event.preventDefault();
        dragCounter -= 1;
        if (dragCounter <= 0) {
          dragCounter = 0;
          isDragOver = false;
        }
      }
    : undefined}
  ondrop={expanded ? handleDrop : undefined}
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex - the shell is a keyboard button only while collapsed -->
  <div
    role={expanded ? undefined : "button"}
    tabindex={expanded ? undefined : locked ? -1 : 0}
    aria-disabled={!expanded && locked ? true : undefined}
    aria-label={expanded
      ? "source ingestion"
      : hasActivePipeline
        ? "view active pipeline"
        : "add sources"}
    onclick={expanded || locked ? undefined : handleCircleClick}
    onkeydown={(event) => {
      if (!expanded && !locked && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        handleCircleClick();
      }
    }}
    class={`relative h-12 overflow-hidden border border-solid transition-[width,border-radius,border-color,background-color] ease-[cubic-bezier(0.22,1,0.36,1)] duration-[280ms] ${
      expanded
        ? `w-[min(640px,100%)] rounded-sm ${isDragOver ? "border-gold" : "border-gold-dim"} bg-ink-raised`
        : `w-12 rounded-[1.5rem] border-transparent bg-transparent delay-[80ms] ${locked ? "cursor-default opacity-45" : "cursor-pointer"}`
    }`}
  >
    <!-- dashed ring crossfades instead of border-style flipping (not animatable) -->
    <div
      class={`pointer-events-none absolute inset-0 rounded-[inherit] border border-dashed border-ink-border transition-opacity ease-[cubic-bezier(0.22,1,0.36,1)] ${
        expanded
          ? "opacity-0 duration-[120ms]"
          : "opacity-100 duration-[280ms] delay-[80ms]"
      }`}
    ></div>
    {#if !expanded}
      <span
        class="absolute inset-0 flex items-center justify-center font-mono text-[length:var(--text-body)] leading-none text-warm-ghost select-none"
        in:fade={{ duration: 80, delay: 200 }}
        out:fade={{ duration: 80 }}
      >
        +
        {#if hasActivePipeline}
          <span
            class="absolute -top-1 -right-1 h-3 w-3 animate-[pulse-fade_1.6s_ease-in-out_infinite] rounded-full bg-gold"
          ></span>
        {/if}
      </span>
    {:else}
      <div
        class="flex h-full w-full items-center"
        in:fade={{ duration: 100, delay: 180, easing: cubicOut }}
        out:fade={{ duration: 80 }}
      >
        {#if hasFiles}
          <div
            class="flex min-w-0 flex-1 items-center gap-x-4 overflow-hidden px-4 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap text-warm-ghost"
          >
            <span class="text-warm-dim">{selectedCount} new</span>
            {#if dupVaultCount > 0}
              <span>· {dupVaultCount} already in vault</span>
            {/if}
            {#if dupBatchCount > 0}
              <span>· {dupBatchCount} repeated</span>
            {/if}
            {#if unsupportedCount > 0}
              <span>· {unsupportedCount} can't be read</span>
            {/if}
            {#if checkingCount > 0}
              <span class="text-gold-dim">· {checkingCount} checking</span>
            {:else if checkingVault}
              <span class="text-gold-dim">· checking vault</span>
            {/if}
            <span class="ml-auto">{formatSize(selectedSize)} to upload</span>
          </div>
        {:else}
          <Input
            bind:value={url}
            onkeydown={(event) => event.key === "Enter" && submitUrl()}
            class="h-full flex-1 rounded-none border-0 bg-transparent px-4 py-0 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-faint shadow-none caret-gold placeholder:text-warm-ghost focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            placeholder={isDragOver ? `add to ${vaultName}` : "paste a link"}
          />
          {#if url.trim()}
            <span
              class="mr-3 shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost select-none"
              title="Press Enter to ingest this URL"
            >
              ↵
            </span>
          {/if}
          <div
            class="flex h-full shrink-0 items-center border-l border-ink-subtle"
          >
            <Button
              variant="ghost"
              size="xs"
              onclick={handleBrowse}
              class="h-full rounded-none px-4 py-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-dim hover:bg-transparent hover:text-gold"
            >
              browse
            </Button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if expanded && hasFiles}
    <div
      class="mt-2 w-full max-w-[640px] rounded-sm border border-ink-subtle bg-ink-raised"
      transition:slide={{ duration: 240, easing: cubicOut }}
    >
      <ul class="h-[320px] divide-y divide-ink-subtle overflow-y-auto">
        {#each shownFiles as item (item.id)}
          {@const label = statusLabel(item.status)}
          {@const name = item.path.slice(sharedFolder.length)}
          <li
            class={`flex items-center gap-3 px-3 py-1.5 transition-opacity ${isSelectableFile(item) ? "" : "opacity-60"}`}
          >
            <input
              type="checkbox"
              checked={item.selected}
              disabled={!isSelectableFile(item)}
              onchange={() => toggleSelected(item.id)}
              aria-label={isSelectableFile(item)
                ? item.selected
                  ? `Exclude ${name}`
                  : `Include ${name}`
                : `${name}: ${label}`}
              class="h-4 w-4 shrink-0 accent-gold disabled:cursor-not-allowed"
            />
            <span
              class="min-w-0 flex-1 truncate font-serif text-[length:var(--text-small)] text-warm-dim"
              title={item.path}
            >
              {name}
            </span>
            <span
              class="w-16 shrink-0 text-right font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
            >
              {formatSize(item.file.size)}
            </span>
            <span
              class={`w-32 shrink-0 truncate font-mono text-[length:var(--text-chrome)] tracking-[0.06em] ${item.status === "checking" ? "animate-[pulse-fade_1.6s_ease-in-out_infinite] text-gold-dim" : "text-gold-muted"}`}
              title={item.status === "error" ? item.error : label}
            >
              {label}
            </span>
          </li>
        {/each}
      </ul>

      {#if dupVaultCount > 0}
        <div
          class="flex items-center gap-3 border-t border-ink-subtle px-3 py-2 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
        >
          <span
            >{dupVaultCount} file{dupVaultCount === 1 ? "" : "s"} already in the vault
            {dupVaultCount === 1 ? "is" : "are"} left out.</span
          >
          <button
            type="button"
            onclick={() => (showInVault = !showInVault)}
            class="text-gold-muted underline decoration-gold-dim underline-offset-[3px] hover:text-gold"
          >
            {showInVault ? "hide" : "show"}
          </button>
        </div>
      {/if}

      <div class="border-t border-ink-subtle px-5 py-5">
        {#if importError}
          <p
            role="alert"
            class="mb-3 [overflow-wrap:anywhere] text-center font-mono text-[length:var(--text-chrome)] text-red-400/90"
          >
            {importError}
          </p>
        {/if}
        <div class="flex flex-wrap items-center justify-center gap-4">
          <Button
            onclick={() => void confirm()}
            disabled={selectedCount === 0 ||
              checkingCount > 0 ||
              checkingVault ||
              creatingBatch}
            class="h-auto rounded-sm bg-gold px-4 py-2 font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.1em] text-primary-foreground hover:bg-gold-hover disabled:bg-interactive-ghost disabled:text-muted-foreground disabled:opacity-100"
          >
            {creatingBatch
              ? "Starting…"
              : `Add ${selectedCount} document${selectedCount === 1 ? "" : "s"}`}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onclick={handleBrowse}
            class="h-auto rounded-sm px-3 py-0.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
          >
            Choose other files
          </Button>
        </div>
      </div>
    </div>
  {:else if expanded && importError}
    <p
      role="alert"
      class="mt-3 w-full max-w-[640px] [overflow-wrap:anywhere] text-center font-mono text-[length:var(--text-chrome)] text-red-400/90"
    >
      {importError}
    </p>
  {/if}

  {#if hasActivePipeline && !expanded}
    <a
      href="/pipeline"
      onclick={(event) => {
        event.preventDefault();
        void goto("/pipeline");
      }}
      class="mt-3 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted transition-colors hover:text-gold"
    >
      pipeline active · view progress →
    </a>
  {/if}
</div>
