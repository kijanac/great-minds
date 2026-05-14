import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ingestStagedFiles } from "@/api/ingest";
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

/** Number of files above which we show a "large batch" note. */
const LARGE_BATCH_THRESHOLD = 200;

interface FailedUpload {
  name: string;
  error: string;
}

type FileSummary = {
  count: number;
  byType: Map<string, number>;
  duplicates: number;
  totalSize: number;
  unrecognisedExts: Set<string>;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function computeSummary(files: DroppedFile[]): FileSummary {
  const byType = new Map<string, number>();
  const seen = new Set<string>();
  const unrecognisedExts = new Set<string>();
  let duplicates = 0;
  let totalSize = 0;

  for (const { file } of files) {
    totalSize += file.size;
    const ext = file.name.includes(".") ? `.${file.name.split(".").pop()?.toLowerCase()}` : "other";
    byType.set(ext, (byType.get(ext) ?? 0) + 1);

    if (ext !== "other" && !RECOGNISED_EXTS.has(ext)) {
      unrecognisedExts.add(ext);
    }

    const key = `${file.name}:${file.size}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
    }
  }

  return { count: files.length, byType, duplicates, totalSize, unrecognisedExts };
}

export function IngestionFlow({ hasActivePipeline }: { hasActivePipeline: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [isDragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState("");
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
  const dragCounter = useRef(0);
  const pendingFilesRef = useRef<DroppedFile[]>([]);
  const pendingUrlRef = useRef<string>("");
  const pendingJobIdRef = useRef<string | null>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const navigate = useViewNavigate();
  const queryClient = useQueryClient();
  const vaultId = useActiveVaultId();
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = !prefersReducedMotion;

  // ---- Actions ----

  const close = useCallback(() => {
    setExpanded(false);
    pendingFilesRef.current = [];
    pendingUrlRef.current = "";
    pendingJobIdRef.current = null;
    setUrl("");
    setSummary(null);
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

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    setIngestError(null);
    setFailedUploads([]);
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length > 0) {
      pendingFilesRef.current = files;
      pendingUrlRef.current = "";
      pendingJobIdRef.current = crypto.randomUUID();
      setSummary(computeSummary(files));
    }
  }, []);

  const handleBrowse = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) {
        const dropped: DroppedFile[] = files.map((f) => {
          const fileWithPath = f as File & { webkitRelativePath?: string };
          return {
            file: f,
            path: fileWithPath.webkitRelativePath || f.name,
          };
        });
        pendingFilesRef.current = dropped;
        pendingUrlRef.current = "";
        pendingJobIdRef.current = crypto.randomUUID();
        setIngestError(null);
        setFailedUploads([]);
        setSummary(computeSummary(dropped));
      }
    };
    input.click();
  }, []);

  const handleUrlSubmit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setConfirming(true);
    navigate(`/pipeline?url=${encodeURIComponent(trimmed)}`);
  }, [navigate, url]);

  const handleConfirm = useCallback(
    async (retryOnly?: DroppedFile[]) => {
      const allFiles = pendingFilesRef.current;
      const files = retryOnly ?? allFiles;
      if (files.length === 0) return;

      setIngestError(null);
      setFailedUploads([]);
      setConfirming(true);

      const stableJobId = pendingJobIdRef.current ?? crypto.randomUUID();
      pendingJobIdRef.current = stableJobId;
      let createdJobId: string | null = null;
      let lastFailedUploads: FailedUpload[] = [];
      for await (const event of ingestStagedFiles(
        files.map((f) => f.file),
        stableJobId,
      )) {
        if (event.phase === "uploading" && event.failed_uploads) {
          lastFailedUploads = event.failed_uploads;
          setFailedUploads(lastFailedUploads);
        }
        if (event.phase === "processing") {
          if (event.id) createdJobId = event.id;
          // Capture partial failures on the success path — some files
          // may have uploaded but others failed. Show the error UI even
          // though a pipeline was created for the survivors.
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
          // Partial success: some files made it, others didn't.
          // Show the failures instead of navigating away silently.
          // Keep pendingFilesRef so retry can find the failed subset. A
          // backend pipeline already exists for the successful files, so a
          // later retry of only failed files must be a new job.
          pendingJobIdRef.current = crypto.randomUUID();
          setConfirming(false);
          const failedNames = new Set(lastFailedUploads.map((f) => f.name));
          const succeeded = allFiles.length - failedNames.size;
          setIngestError(
            succeeded > 0
              ? `${succeeded} file${succeeded !== 1 ? "s" : ""} ingested, ${failedNames.size} failed. The pipeline will process successful uploads.`
              : `All ${failedNames.size} upload${failedNames.size !== 1 ? "s" : ""} failed.`,
          );
          invalidateActivePipeline();
        } else {
          pendingFilesRef.current = [];
          pendingJobIdRef.current = null;
          invalidateActivePipeline();
          navigate(`/pipeline/runs/${createdJobId}`);
        }
      } else {
        setConfirming(false);
        setIngestError("No job was created — the server may be unavailable.");
      }
    },
    [invalidateActivePipeline, navigate],
  );

  const handleRetry = useCallback(() => {
    // Retry only the files that failed, looked up by name.
    const failedNames = new Set(failedUploads.map((f) => f.name));
    const retryFiles = pendingFilesRef.current.filter((f) => failedNames.has(f.file.name));
    if (retryFiles.length > 0) {
      // Build a fresh DroppedFile[] from the pending ref so the batch
      // size is accurate for partial-success messaging.
      handleConfirm(retryFiles);
    }
  }, [failedUploads, handleConfirm]);

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
  const hasUnrecognised = summary && summary.unrecognisedExts.size > 0;
  const isLargeBatch = summary && summary.count > LARGE_BATCH_THRESHOLD;

  // ---- Transition ----

  const shellSpring = shouldAnimate
    ? { type: "spring" as const, stiffness: 300, damping: 28, mass: 0.6 }
    : { duration: 0 };

  // ---- Shell classes ----

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
        {/* ── Anchor: "+" — always present, fades as shell expands ── */}
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

        {/* ── Content: revealed after shell opens ── */}
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
              {/* File summary — keep visible for context */}
              {summary && (
                <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
                  <span>
                    {summary.count} file{summary.count !== 1 ? "s" : ""}
                  </span>
                  <span>{formatSize(summary.totalSize)}</span>
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
              {summary && summary.count > 0 ? (
                /* ── With files selected ── */
                <div className="px-10 py-8">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-4">
                    <span>
                      {summary.count} file{summary.count !== 1 ? "s" : ""}
                    </span>
                    <span>{formatSize(summary.totalSize)}</span>
                    {Array.from(summary.byType.entries()).map(([ext, count]) => (
                      <span key={ext} className="text-warm-faint">
                        {ext} · {count}
                      </span>
                    ))}
                  </div>

                  {hasUnrecognised && (
                    <p className="mb-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
                      Unrecognised format{summary.unrecognisedExts.size > 1 ? "s" : ""}:{" "}
                      {Array.from(summary.unrecognisedExts).join(", ")}. These may fail during
                      processing.
                    </p>
                  )}

                  {summary.duplicates > 0 && (
                    <p className="mb-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
                      {summary.duplicates} duplicate
                      {summary.duplicates !== 1 ? "s" : ""} detected — duplicates will be skipped
                    </p>
                  )}

                  {summary.totalSize > 100 * 1024 * 1024 && (
                    <p className="mb-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
                      Large upload — may take a few minutes
                    </p>
                  )}

                  <div className="mt-6 pt-5 border-t border-ink-subtle">
                    {isLargeBatch && (
                      <p className="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint text-center">
                        {summary.count} files — a large batch. Ingest may take a while. The pipeline
                        runs in the background if you navigate away.
                      </p>
                    )}
                    <div className="flex items-center justify-center gap-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => handleConfirm()}
                        className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                                   text-gold hover:text-gold-hover hover:bg-transparent
                                   rounded-sm h-auto px-3 py-0.5"
                      >
                        ingest {summary.count} file
                        {summary.count !== 1 ? "s" : ""}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={handleBrowse}
                        className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                                   text-warm-ghost hover:text-warm-faint hover:bg-transparent
                                   rounded-sm h-auto px-3 py-0.5"
                      >
                        add more
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
