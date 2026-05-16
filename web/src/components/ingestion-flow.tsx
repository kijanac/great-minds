import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { checkDupes, hashFile, ingestStagedFiles, type HashedFile } from "@/api/ingest";
import { useActiveVaultId } from "@/hooks/use-vault";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import type { DroppedFile } from "@/lib/types";

const LAYOUT_ID = "ingestion-zone";

/** Extensions MarkItDown can convert. Unrecognised types get a warning
 *  but aren't blocked — the backend may handle types we don't list. */
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
const LARGE_BATCH_THRESHOLD = 200;

interface FailedUpload {
  name: string;
  error: string;
}

/** Per-file lifecycle in the ingestion preview. */
type FileStatus =
  | "checking" // hash in progress
  | "unique" // fresh content, included by default
  | "duplicate-in-batch" // another selected file has the same hash
  | "duplicate-in-vault" // hash already in this vault
  | "unrecognised" // extension not in RECOGNISED_EXTS
  | "error"; // couldn't read or hash

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(name: string): string {
  return name.includes(".") ? `.${name.split(".").pop()?.toLowerCase()}` : "";
}

async function filesFromDrop(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dataTransfer.items);
  const entries = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => e != null);

  if (entries.length > 0) {
    return collectAll(entries, "");
  }
  return Array.from(dataTransfer.files).map((f) => ({ file: f, path: f.name }));
}

async function collectAll(entries: FileSystemEntry[], prefix: string): Promise<DroppedFile[]> {
  const results: DroppedFile[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      results.push({
        file,
        path: prefix ? `${prefix}/${entry.name}` : entry.name,
      });
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const children: FileSystemEntry[] = [];
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise((resolve) => reader.readEntries((e) => resolve(e)));
        children.push(...batch);
      } while (batch.length > 0);
      const dir = prefix ? `${prefix}/${entry.name}` : entry.name;
      const nested = await collectAll(children, dir);
      results.push(...nested);
    }
  }
  return results;
}

function initialIngestable(dropped: DroppedFile[]): IngestableFile[] {
  return dropped.map((d) => {
    const ext = extOf(d.file.name);
    const recognised = ext === "" || RECOGNISED_EXTS.has(ext);
    return {
      id: crypto.randomUUID(),
      file: d.file,
      path: d.path,
      ext,
      // Start unrecognised files in their terminal state — they don't
      // get a vault check. Everything else starts in checking.
      status: recognised ? "checking" : "unrecognised",
      selected: true,
      // Unrecognised files still upload (backend may handle them);
      // they just don't participate in dupe detection.
    };
  });
}

export function IngestionFlow({ hasActivePipeline }: { hasActivePipeline: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [isDragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<IngestableFile[]>([]);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
  const dragCounter = useRef(0);
  const pendingJobIdRef = useRef<string | null>(null);
  const hashRunIdRef = useRef(0);
  const zoneRef = useRef<HTMLDivElement>(null);
  const navigate = useViewNavigate();
  const queryClient = useQueryClient();
  const vaultId = useActiveVaultId();
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = !prefersReducedMotion;

  // ---- Actions ----

  const close = useCallback(() => {
    setExpanded(false);
    setFiles([]);
    pendingJobIdRef.current = null;
    hashRunIdRef.current += 1; // cancel any in-flight hashing run
    setUrl("");
    setIngestError(null);
    setFailedUploads([]);
  }, []);

  // ---- Side-effect: close on click-outside / Escape ----

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (zoneRef.current && !zoneRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
    };
  }, [expanded, close]);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expanded, close]);

  // ---- Side-effect: document-level drag triggers expansion ----

  useEffect(() => {
    let dragDepth = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragDepth += 1;
      if (dragDepth > 0 && !expanded) setExpanded(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth = 0;
    };

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);

    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [expanded]);

  const invalidateActivePipeline = useCallback(() => {
    if (!vaultId) return;
    queryClient.invalidateQueries({
      queryKey: ["vault", vaultId, "active-job"],
    });
  }, [queryClient, vaultId]);

  const clearError = useCallback(() => {
    setIngestError(null);
    setFailedUploads([]);
  }, []);

  // ---- Hashing pipeline ----
  //
  // Each picked batch increments hashRunIdRef. In-flight workers check
  // the run id before applying their result, so a fresh pick (or
  // close) cancels stale updates.

  const runHashingPipeline = useCallback(async (initial: IngestableFile[]) => {
    hashRunIdRef.current += 1;
    const runId = hashRunIdRef.current;

    // Concurrent hashing — yields per-file updates as each completes.
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= initial.length) return;
        const item = initial[i];
        if (item.status !== "checking") continue;
        try {
          const hash = await hashFile(item.file);
          if (hashRunIdRef.current !== runId) return;
          setFiles((prev) => applyHash(prev, item.id, hash));
        } catch (e) {
          if (hashRunIdRef.current !== runId) return;
          const message = e instanceof Error ? e.message : "hash failed";
          setFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, status: "error", error: message } : f)),
          );
        }
      }
    }
    const workers = Array.from({ length: Math.min(HASH_CONCURRENCY, initial.length) }, worker);
    await Promise.all(workers);
    if (hashRunIdRef.current !== runId) return;

    // Once everyone's hashed, ask the server which already exist.
    const hashes = initial
      .filter((f) => f.status === "checking")
      .map((f) => f.hash)
      .filter((h): h is string => !!h);
    // Some hashes were populated by the setFiles updates above; the
    // initial array still has the snapshot, so use latest state via a
    // setFiles read-then-write. Simpler: read from current state.
    setFiles((current) => {
      const hashList = current
        .filter((f) => f.status === "unique" || f.status === "duplicate-in-batch")
        .map((f) => f.hash!)
        .filter((h) => !!h);
      // Kick off the server check; soft-fail keeps the UI usable
      // even if the endpoint is unreachable.
      void (async () => {
        const existing = await checkDupes(Array.from(new Set(hashList)));
        if (hashRunIdRef.current !== runId) return;
        if (existing.size === 0) return;
        setFiles((prev) =>
          prev.map((f) =>
            f.hash && existing.has(f.hash)
              ? { ...f, status: "duplicate-in-vault", selected: false }
              : f,
          ),
        );
      })();
      return current;
    });
    void hashes; // referenced to keep the compiler quiet about the unused intermediate
  }, []);

  /** Update one file in the list with its computed hash, deriving the
   *  intra-batch dup status against the rest of the list. */
  function applyHash(prev: IngestableFile[], id: string, hash: string): IngestableFile[] {
    const matchesElsewhere = prev.some((f) => f.id !== id && f.hash === hash);
    return prev.map((f) => {
      if (f.id === id) {
        return {
          ...f,
          hash,
          status: matchesElsewhere ? "duplicate-in-batch" : "unique",
          selected: !matchesElsewhere,
        };
      }
      // If this hash already existed on another row, the existing one
      // keeps its status (the FIRST occurrence is "unique"). The new
      // arrival is the duplicate.
      return f;
    });
  }

  const startWithFiles = useCallback(
    (dropped: DroppedFile[]) => {
      if (dropped.length === 0) return;
      const initial = initialIngestable(dropped);
      pendingJobIdRef.current = crypto.randomUUID();
      setIngestError(null);
      setFailedUploads([]);
      setFiles(initial);
      void runHashingPipeline(initial);
    },
    [runHashingPipeline],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const dropped = await filesFromDrop(e.dataTransfer);
      startWithFiles(dropped);
    },
    [startWithFiles],
  );

  const handleBrowse = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.onchange = async () => {
      const picked = Array.from(input.files ?? []);
      if (picked.length === 0) return;
      const dropped: DroppedFile[] = picked.map((f) => {
        const fileWithPath = f as File & { webkitRelativePath?: string };
        return {
          file: f,
          path: fileWithPath.webkitRelativePath || f.name,
        };
      });
      startWithFiles(dropped);
    };
    input.click();
  }, [startWithFiles]);

  const handleUrlSubmit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setConfirming(true);
    navigate(`/pipeline?url=${encodeURIComponent(trimmed)}`);
  }, [navigate, url]);

  const toggleSelected = useCallback((id: string) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f)));
  }, []);

  const selectAllNonDupe = useCallback(() => {
    setFiles((prev) =>
      prev.map((f) => ({
        ...f,
        selected: f.status === "unique" || f.status === "unrecognised" || f.status === "checking",
      })),
    );
  }, []);

  const handleConfirm = useCallback(
    async (retryHashes?: Set<string>) => {
      const candidates = retryHashes
        ? files.filter((f) => f.hash && retryHashes.has(f.hash))
        : files.filter((f) => f.selected && f.hash && f.status !== "error");
      if (candidates.length === 0) return;

      setIngestError(null);
      setFailedUploads([]);
      setConfirming(true);

      const stableJobId = pendingJobIdRef.current ?? crypto.randomUUID();
      pendingJobIdRef.current = stableJobId;
      const hashed: HashedFile[] = candidates.map((f) => ({
        file: f.file,
        hash: f.hash!,
      }));

      let createdJobId: string | null = null;
      let lastFailedUploads: FailedUpload[] = [];
      for await (const event of ingestStagedFiles(hashed, stableJobId)) {
        if (event.phase === "uploading" && event.failed_uploads) {
          lastFailedUploads = event.failed_uploads;
          setFailedUploads(lastFailedUploads);
        }
        if (event.phase === "processing") {
          if (event.id) createdJobId = event.id;
          if (event.failed_uploads && event.failed_uploads.length > 0) {
            lastFailedUploads = event.failed_uploads;
            setFailedUploads(lastFailedUploads);
          }
          break;
        }
        if (event.phase === "error") {
          setConfirming(false);
          setIngestError(event.error ?? "Ingest failed");
          if (event.failed_uploads) setFailedUploads(event.failed_uploads);
          return;
        }
      }

      if (createdJobId) {
        if (lastFailedUploads.length > 0) {
          pendingJobIdRef.current = crypto.randomUUID();
          setConfirming(false);
          const failedNames = new Set(lastFailedUploads.map((f) => f.name));
          const succeeded = candidates.length - failedNames.size;
          setIngestError(
            succeeded > 0
              ? `${succeeded} file${succeeded !== 1 ? "s" : ""} ingested, ${failedNames.size} failed. The pipeline will process successful uploads.`
              : `All ${failedNames.size} upload${failedNames.size !== 1 ? "s" : ""} failed.`,
          );
          invalidateActivePipeline();
        } else {
          setFiles([]);
          pendingJobIdRef.current = null;
          invalidateActivePipeline();
          navigate(`/pipeline/runs/${createdJobId}`);
        }
      } else {
        setConfirming(false);
        setIngestError("No job was created — the server may be unavailable.");
      }
    },
    [files, invalidateActivePipeline, navigate],
  );

  const handleRetry = useCallback(() => {
    const failedNames = new Set(failedUploads.map((f) => f.name));
    const retryHashes = new Set(
      files
        .filter((f) => failedNames.has(f.file.name))
        .map((f) => f.hash!)
        .filter(Boolean),
    );
    if (retryHashes.size > 0) handleConfirm(retryHashes);
  }, [failedUploads, files, handleConfirm]);

  const handleCircleClick = useCallback(() => {
    if (hasActivePipeline) {
      navigate("/pipeline");
    } else {
      setExpanded(true);
    }
  }, [hasActivePipeline, navigate]);

  // ---- Derived state ----

  const isCircle = !expanded && !confirming;
  const showContent = expanded || confirming;
  const hasFiles = files.length > 0;
  const selectedCount = files.filter((f) => f.selected).length;
  const checkingCount = files.filter((f) => f.status === "checking").length;
  const dupBatchCount = files.filter((f) => f.status === "duplicate-in-batch").length;
  const dupVaultCount = files.filter((f) => f.status === "duplicate-in-vault").length;
  const unrecognisedCount = files.filter((f) => f.status === "unrecognised").length;
  const totalSize = files.reduce((s, f) => s + f.file.size, 0);
  const isLargeBatch = files.length > LARGE_BATCH_THRESHOLD;

  // ---- Transition ----

  const shellSpring = shouldAnimate
    ? { type: "spring" as const, stiffness: 300, damping: 28, mass: 0.6 }
    : { duration: 0 };

  const shellClass = isCircle
    ? "w-12 h-12 rounded-full border border-dashed border-ink-border bg-transparent cursor-pointer"
    : "w-full max-w-[800px] rounded-sm border border-solid border-gold-dim bg-ink-raised overflow-hidden";

  // ---- Render ----

  return (
    <div className="flex justify-center" ref={zoneRef}>
      <motion.div
        layout
        layoutId={LAYOUT_ID}
        transition={shellSpring}
        onClick={isCircle ? handleCircleClick : undefined}
        className={`relative ${shellClass}`}
        onDragEnter={
          showContent
            ? (e: React.DragEvent) => {
                e.preventDefault();
                dragCounter.current++;
                setDragOver(true);
              }
            : undefined
        }
        onDragOver={showContent ? (e: React.DragEvent) => e.preventDefault() : undefined}
        onDragLeave={
          showContent
            ? (e: React.DragEvent) => {
                e.preventDefault();
                dragCounter.current--;
                if (dragCounter.current <= 0) {
                  dragCounter.current = 0;
                  setDragOver(false);
                }
              }
            : undefined
        }
        onDrop={showContent ? handleDrop : undefined}
      >
        <motion.span
          animate={{ opacity: isCircle ? 1 : 0 }}
          transition={shouldAnimate ? { duration: 0.1, ease: [0.25, 1, 0.5, 1] } : { duration: 0 }}
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none"
        >
          <span className="font-mono text-[length:var(--text-body)] text-warm-ghost leading-none">
            +
          </span>
          {hasActivePipeline && (
            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-gold animate-[pulse-fade_1.6s_ease-in-out_infinite]" />
          )}
        </motion.span>

        <motion.div
          animate={{ opacity: showContent ? 1 : 0 }}
          transition={
            shouldAnimate
              ? { duration: 0.15, ease: [0.25, 1, 0.5, 1], delay: showContent ? 0.12 : 0 }
              : { duration: 0 }
          }
          className={showContent ? "" : "pointer-events-none"}
        >
          {/* Error state */}
          {expanded && ingestError && (
            <div className="px-10 pt-8 pb-4">
              {hasFiles && (
                <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
                  <span>
                    {files.length} file{files.length !== 1 ? "s" : ""}
                  </span>
                  <span>{formatSize(totalSize)}</span>
                </div>
              )}

              <div className="flex items-start gap-3">
                <span className="text-warm-faint shrink-0 mt-0.5">✗</span>
                <div className="flex-1 min-w-0">
                  <p className="font-serif text-[length:var(--text-small)] text-warm-dim mb-1">
                    {ingestError}
                  </p>
                  {failedUploads.length > 0 && (
                    <div className="mt-2">
                      <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-1.5">
                        {failedUploads.length} file{failedUploads.length !== 1 ? "s" : ""} failed
                      </p>
                      <ScrollArea className="max-h-32 rounded-sm border border-ink-border">
                        <div className="p-3 space-y-1">
                          {failedUploads.map((f, i) => (
                            <div
                              key={i}
                              className="font-mono text-[length:var(--text-chrome)] text-warm-faint truncate"
                            >
                              <span className="text-warm-ghost">{f.name}</span>{" "}
                              <span className="opacity-60">{f.error}</span>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 mt-4 pb-3">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleRetry}
                  className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                             text-gold hover:text-gold-hover hover:bg-transparent
                             rounded-sm h-auto px-3 py-0.5"
                >
                  retry failed
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={clearError}
                  className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                             text-warm-ghost hover:text-warm-faint hover:bg-transparent
                             rounded-sm h-auto px-3 py-0.5"
                >
                  dismiss
                </Button>
              </div>
            </div>
          )}

          {/* Confirming pulse */}
          {confirming && (
            <div className="flex items-center justify-center gap-3 px-10 py-12">
              <span className="text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite] shrink-0 text-lg">
                ◉
              </span>
              <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint">
                uploading to vault…
              </span>
            </div>
          )}

          {/* Expanded zone */}
          {expanded && !confirming && !ingestError && (
            <>
              {hasFiles ? (
                /* ── With files selected ── */
                <div className="px-10 py-8">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-3">
                    <span>
                      {selectedCount} / {files.length} selected
                    </span>
                    <span>{formatSize(totalSize)}</span>
                    {checkingCount > 0 && (
                      <span className="text-gold-dim">{checkingCount} hashing</span>
                    )}
                    {dupBatchCount > 0 && (
                      <span className="text-warm-faint">{dupBatchCount} dup in batch</span>
                    )}
                    {dupVaultCount > 0 && (
                      <span className="text-warm-faint">{dupVaultCount} already in vault</span>
                    )}
                    {unrecognisedCount > 0 && (
                      <span className="text-warm-faint">{unrecognisedCount} unrecognised</span>
                    )}
                  </div>

                  <ScrollArea className="h-[320px] rounded-sm border border-ink-subtle">
                    <ul className="divide-y divide-ink-subtle">
                      {files.map((f) => (
                        <FileRow key={f.id} item={f} onToggle={toggleSelected} />
                      ))}
                    </ul>
                  </ScrollArea>

                  <div className="mt-6 pt-5 border-t border-ink-subtle">
                    {isLargeBatch && (
                      <p className="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint text-center">
                        {files.length} files — a large batch. Ingest may take a while. The pipeline
                        runs in the background if you navigate away.
                      </p>
                    )}
                    <div className="flex items-center justify-center gap-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => handleConfirm()}
                        disabled={selectedCount === 0 || checkingCount > 0}
                        className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                                   text-gold hover:text-gold-hover hover:bg-transparent
                                   disabled:text-warm-ghost disabled:cursor-not-allowed
                                   rounded-sm h-auto px-3 py-0.5"
                      >
                        ingest {selectedCount} file{selectedCount !== 1 ? "s" : ""}
                      </Button>
                      {(dupBatchCount > 0 || dupVaultCount > 0) && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={selectAllNonDupe}
                          className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                                     text-warm-ghost hover:text-warm-faint hover:bg-transparent
                                     rounded-sm h-auto px-3 py-0.5"
                        >
                          deselect duplicates
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={handleBrowse}
                        className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                                   text-warm-ghost hover:text-warm-faint hover:bg-transparent
                                   rounded-sm h-auto px-3 py-0.5"
                      >
                        replace
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                /* ── Empty: generous drop target ── */
                <div className="px-10 py-14 flex flex-col items-center gap-6">
                  <div className="text-center">
                    <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-1">
                      {isDragOver ? "drop to add to knowledge base" : "drop files or folders here"}
                    </p>
                    <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
                      or use the field below
                    </p>
                  </div>

                  <div className="w-full max-w-[420px] flex items-center gap-2">
                    <Input
                      className="flex-1 border-ink-border bg-transparent dark:bg-transparent
                                 font-mono text-[length:var(--text-chrome)] tracking-[0.08em]
                                 text-warm-faint placeholder:text-warm-ghost
                                 caret-gold focus-visible:ring-0 focus-visible:border-gold-dim
                                 h-8 py-0 px-3 rounded-sm"
                      placeholder="paste a link and press Enter"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
                    />
                    {url.trim() && (
                      <span
                        className="font-mono text-[length:var(--text-chrome)] text-warm-ghost select-none shrink-0"
                        title="Press Enter to ingest this URL"
                      >
                        ↵
                      </span>
                    )}
                  </div>

                  <button
                    onClick={handleBrowse}
                    title="Browse for a folder"
                    className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                               text-gold-dim hover:text-gold transition-colors
                               bg-transparent border-0 cursor-pointer"
                  >
                    or browse for a folder
                  </button>
                </div>
              )}
            </>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}

/** Status glyph + label per FileStatus. Kept inline in the row so the
 *  styling lives next to its semantics. */
function statusIndicator(status: FileStatus): { glyph: string; label: string; className: string } {
  switch (status) {
    case "checking":
      return {
        glyph: "◌",
        label: "checking…",
        className: "text-gold-dim animate-[pulse-fade_1.6s_ease-in-out_infinite]",
      };
    case "unique":
      return { glyph: "◉", label: "unique", className: "text-warm-dim" };
    case "duplicate-in-batch":
      return { glyph: "◯", label: "duplicate in batch", className: "text-warm-faint" };
    case "duplicate-in-vault":
      return { glyph: "⊘", label: "already in vault", className: "text-warm-faint" };
    case "unrecognised":
      return { glyph: "⚠", label: "unrecognised format", className: "text-warm-faint" };
    case "error":
      return { glyph: "✗", label: "error", className: "text-warm-faint" };
  }
}

function FileRow({ item, onToggle }: { item: IngestableFile; onToggle: (id: string) => void }) {
  const { glyph, label, className } = statusIndicator(item.status);
  const isDupe = item.status === "duplicate-in-batch" || item.status === "duplicate-in-vault";
  return (
    <li
      className={`flex items-center gap-3 px-3 py-1.5 transition-opacity ${
        isDupe && !item.selected ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => onToggle(item.id)}
        title={item.selected ? "Click to exclude" : "Click to include"}
        className="font-mono text-[length:var(--text-chrome)] text-warm-ghost
                   hover:text-gold transition-colors w-4 text-center shrink-0
                   bg-transparent border-0 cursor-pointer"
      >
        {item.selected ? "☑" : "☐"}
      </button>
      <span
        className="font-serif text-[length:var(--text-small)] text-warm-dim truncate flex-1 min-w-0"
        title={item.path}
      >
        {item.path}
      </span>
      <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost shrink-0 w-16 text-right">
        {formatSize(item.file.size)}
      </span>
      <span
        className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost shrink-0 w-14 truncate"
        title={item.ext || "no ext"}
      >
        {item.ext || "—"}
      </span>
      <span
        className={`font-mono text-[length:var(--text-chrome)] tracking-[0.06em] shrink-0 w-44 truncate flex items-center gap-1.5 ${className}`}
        title={item.error ?? label}
      >
        <span className="shrink-0">{glyph}</span>
        <span className="truncate">{label}</span>
      </span>
    </li>
  );
}
