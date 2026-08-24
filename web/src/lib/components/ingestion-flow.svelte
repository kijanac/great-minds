<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade, slide } from "svelte/transition";

  import { checkDupes, hashFile, type HashedFile } from "$lib/api/ingest";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import type { DroppedFile } from "$lib/types";

  const RECOGNISED_EXTS = new Set([
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".pdf",
    ".docx",
    ".doc",
    ".pptx",
    ".ppt",
    ".xlsx",
    ".xls",
    ".csv",
    ".json",
    ".xml",
    ".html",
    ".htm",
    ".epub",
    ".rtf",
    ".odt",
  ]);
  const HASH_CONCURRENCY = 4;

  type FileStatus =
    | "checking"
    | "unique"
    | "duplicate-in-batch"
    | "duplicate-in-vault"
    | "unrecognised"
    | "error";

  interface IngestableFile {
    id: string;
    file: File;
    path: string;
    ext: string;
    status: FileStatus;
    hash?: string;
    selected: boolean;
    error?: string;
  }

  let {
    hasActivePipeline,
    stagedUploads,
    vaultName,
  }: {
    hasActivePipeline: boolean;
    stagedUploads: boolean;
    vaultName: string;
  } = $props();

  let expanded = $state(false);
  let isDragOver = $state(false);
  let url = $state("");
  let files = $state<IngestableFile[]>([]);
  let dragCounter = 0;
  let hashRunId = 0;
  let zone: HTMLDivElement;

  const hasFiles = $derived(files.length > 0);
  const selectedCount = $derived(files.filter((file) => file.selected).length);
  const checkingCount = $derived(
    files.filter((file) => file.status === "checking").length,
  );
  const dupBatchCount = $derived(
    files.filter((file) => file.status === "duplicate-in-batch").length,
  );
  const dupVaultCount = $derived(
    files.filter((file) => file.status === "duplicate-in-vault").length,
  );
  const unrecognisedCount = $derived(
    files.filter((file) => file.status === "unrecognised").length,
  );
  const totalSize = $derived(
    files.reduce((total, file) => total + file.file.size, 0),
  );

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function extOf(name: string): string {
    return name.includes(".") ? `.${name.split(".").pop()?.toLowerCase()}` : "";
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

  async function collectAll(
    entries: FileSystemEntry[],
    prefix: string,
  ): Promise<DroppedFile[]> {
    const results: DroppedFile[] = [];
    for (const entry of entries) {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) =>
          fileEntry.file(resolve, reject),
        );
        results.push({
          file,
          path: prefix ? `${prefix}/${entry.name}` : entry.name,
        });
      } else if (entry.isDirectory) {
        const directory = entry as FileSystemDirectoryEntry;
        const reader = directory.createReader();
        const children: FileSystemEntry[] = [];
        let batch: FileSystemEntry[];
        do {
          batch = await new Promise((resolve) =>
            reader.readEntries((items) => resolve(items)),
          );
          children.push(...batch);
        } while (batch.length > 0);
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        results.push(...(await collectAll(children, path)));
      }
    }
    return results;
  }

  function initialIngestable(dropped: DroppedFile[]): IngestableFile[] {
    return dropped.map(({ file, path }) => {
      const ext = extOf(file.name);
      const recognised = ext === "" || RECOGNISED_EXTS.has(ext);
      return {
        id: crypto.randomUUID(),
        file,
        path,
        ext,
        status: recognised ? "checking" : "unrecognised",
        selected: true,
      };
    });
  }

  function close() {
    expanded = false;
    files = [];
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
    id: string,
    hash: string,
  ): IngestableFile[] {
    const duplicate = current.some(
      (file) => file.id !== id && file.hash === hash,
    );
    return current.map((file) =>
      file.id === id
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
    let cursor = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= initial.length) return;
        const item = initial[index];
        if (item.status !== "checking") continue;
        try {
          const hash = await hashFile(item.file);
          if (hashRunId !== runId) return;
          files = applyHash(files, item.id, hash);
        } catch (error) {
          if (hashRunId !== runId) return;
          files = files.map((file) =>
            file.id === item.id
              ? {
                  ...file,
                  status: "error",
                  error: error instanceof Error ? error.message : "hash failed",
                }
              : file,
          );
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(HASH_CONCURRENCY, initial.length) },
        worker,
      ),
    );
    if (hashRunId !== runId) return;

    const hashes = files
      .filter(
        (file) =>
          file.status === "unique" || file.status === "duplicate-in-batch",
      )
      .map((file) => file.hash!)
      .filter(Boolean);
    const existing = await checkDupes(Array.from(new Set(hashes)));
    if (hashRunId !== runId || existing.size === 0) return;
    files = files.map((file) =>
      file.hash && existing.has(file.hash)
        ? { ...file, status: "duplicate-in-vault", selected: false }
        : file,
    );
  }

  function startWithFiles(dropped: DroppedFile[]) {
    if (dropped.length === 0) return;
    const initial = initialIngestable(dropped);
    files = initial;
    void runHashingPipeline(initial);
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragCounter = 0;
    isDragOver = false;
    startWithFiles(await filesFromDrop(event.dataTransfer!));
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

  function toggleSelected(id: string) {
    files = files.map((file) =>
      file.id === id ? { ...file, selected: !file.selected } : file,
    );
  }

  function deselectDuplicates() {
    files = files.map((file) => ({
      ...file,
      selected:
        file.status === "unique" ||
        file.status === "unrecognised" ||
        file.status === "checking",
    }));
  }

  function confirm() {
    const uploadFiles: HashedFile[] = files
      .filter((file) => file.selected && file.hash && file.status !== "error")
      .map((item) => ({ file: item.file, hash: item.hash! }));
    if (uploadFiles.length === 0) return;

    void goto("/pipeline", {
      state: {
        uploadFiles,
        stableJobId: crypto.randomUUID(),
        uploadMode: stagedUploads ? "staged" : "direct",
      },
    });
    files = [];
  }

  function handleCircleClick() {
    if (hasActivePipeline) void goto("/pipeline");
    else expanded = true;
  }

  function statusIndicator(status: FileStatus) {
    switch (status) {
      case "checking":
        return {
          glyph: "◌",
          label: "checking…",
          className:
            "text-gold-dim animate-[pulse-fade_1.6s_ease-in-out_infinite]",
        };
      case "unique":
        return {
          glyph: "◉",
          label: "unique",
          className: "text-warm-dim",
        };
      case "duplicate-in-batch":
        return {
          glyph: "◯",
          label: "duplicate in batch",
          className: "text-warm-faint",
        };
      case "duplicate-in-vault":
        return {
          glyph: "⊘",
          label: "already in vault",
          className: "text-warm-faint",
        };
      case "unrecognised":
        return {
          glyph: "⚠",
          label: "unrecognised format",
          className: "text-warm-faint",
        };
      case "error":
        return {
          glyph: "✗",
          label: "error",
          className: "text-warm-faint",
        };
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
    tabindex={expanded ? undefined : 0}
    aria-label={expanded
      ? "source ingestion"
      : hasActivePipeline
        ? "view active pipeline"
        : "add sources"}
    onclick={expanded ? undefined : handleCircleClick}
    onkeydown={(event) => {
      if (!expanded && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        handleCircleClick();
      }
    }}
    class={`relative h-12 overflow-hidden border border-solid transition-[width,border-radius,border-color,background-color] ease-[cubic-bezier(0.22,1,0.36,1)] duration-[280ms] ${
      expanded
        ? `w-[min(640px,100%)] rounded-sm ${isDragOver ? "border-gold" : "border-gold-dim"} bg-ink-raised`
        : "w-12 cursor-pointer rounded-[1.5rem] border-transparent bg-transparent delay-[80ms]"
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
            <span>{selectedCount} / {files.length} selected</span>
            <span>{formatSize(totalSize)}</span>
            {#if checkingCount > 0}
              <span class="text-gold-dim">{checkingCount} hashing</span>
            {/if}
            {#if dupBatchCount > 0}
              <span class="text-warm-faint">{dupBatchCount} dup in batch</span>
            {/if}
            {#if dupVaultCount > 0}
              <span class="text-warm-faint"
                >{dupVaultCount} already in vault</span
              >
            {/if}
            {#if unrecognisedCount > 0}
              <span class="text-warm-faint"
                >{unrecognisedCount} unrecognised</span
              >
            {/if}
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
        {#each files as item (item.id)}
          {@const indicator = statusIndicator(item.status)}
          {@const isDupe =
            item.status === "duplicate-in-batch" ||
            item.status === "duplicate-in-vault"}
          <li
            class={`flex items-center gap-3 px-3 py-1.5 transition-opacity ${isDupe && !item.selected ? "opacity-50" : ""}`}
          >
            <input
              type="checkbox"
              checked={item.selected}
              onchange={() => toggleSelected(item.id)}
              aria-label={item.selected
                ? "Click to exclude"
                : "Click to include"}
              class="h-4 w-4 shrink-0 accent-gold"
            />
            <span
              class="min-w-0 flex-1 truncate font-serif text-[length:var(--text-small)] text-warm-dim"
              title={item.path}
            >
              {item.path}
            </span>
            <span
              class="w-16 shrink-0 text-right font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
            >
              {formatSize(item.file.size)}
            </span>
            <span
              class="w-14 shrink-0 truncate font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
              title={item.ext || "no ext"}
            >
              {item.ext || "—"}
            </span>
            <span
              class={`flex w-44 shrink-0 items-center gap-1.5 truncate font-mono text-[length:var(--text-chrome)] tracking-[0.06em] ${indicator.className}`}
              title={item.error ?? indicator.label}
            >
              <span class="shrink-0">{indicator.glyph}</span>
              <span class="truncate">{indicator.label}</span>
            </span>
          </li>
        {/each}
      </ul>

      <div class="border-t border-ink-subtle px-5 py-5">
        <div class="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="ghost"
            size="xs"
            onclick={confirm}
            disabled={selectedCount === 0 || checkingCount > 0}
            class="h-auto rounded-sm px-3 py-0.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-transparent hover:text-gold-hover disabled:cursor-not-allowed disabled:text-warm-ghost"
          >
            ingest {selectedCount} file{selectedCount !== 1 ? "s" : ""}
          </Button>
          {#if dupBatchCount > 0 || dupVaultCount > 0}
            <Button
              variant="ghost"
              size="xs"
              onclick={deselectDuplicates}
              class="h-auto rounded-sm px-3 py-0.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
            >
              deselect duplicates
            </Button>
          {/if}
          <Button
            variant="ghost"
            size="xs"
            onclick={handleBrowse}
            class="h-auto rounded-sm px-3 py-0.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
          >
            replace
          </Button>
        </div>
      </div>
    </div>
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
