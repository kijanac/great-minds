import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ingestBulk } from "@/api/ingest";
import { useActiveVaultId } from "@/hooks/use-vault";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import type { DroppedFile } from "@/lib/types";

const LAYOUT_ID = "ingestion-zone";

type FileSummary = {
  count: number;
  byType: Map<string, number>;
  duplicates: number;
  totalSize: number;
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
  let duplicates = 0;
  let totalSize = 0;

  for (const { file } of files) {
    totalSize += file.size;
    const ext = file.name.includes(".") ? `.${file.name.split(".").pop()?.toLowerCase()}` : "other";
    byType.set(ext, (byType.get(ext) ?? 0) + 1);

    const key = `${file.name}:${file.size}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
    }
  }

  return { count: files.length, byType, duplicates, totalSize };
}

export function IngestionFlow({ hasActivePipeline }: { hasActivePipeline: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [isDragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState("");
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const dragCounter = useRef(0);
  const pendingFilesRef = useRef<DroppedFile[]>([]);
  const pendingUrlRef = useRef<string>("");
  const zoneRef = useRef<HTMLDivElement>(null);
  const navigate = useViewNavigate();
  const queryClient = useQueryClient();
  const vaultId = useActiveVaultId();
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = !prefersReducedMotion;

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
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expanded]);

  // ---- Side-effect: document-level drag triggers expansion ----

  useEffect(() => {
    let _dragCounter = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      _dragCounter++;
      if (!expanded) setExpanded(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      _dragCounter--;
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      _dragCounter = 0;
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

  // ---- Actions ----

  const close = useCallback(() => {
    setExpanded(false);
    pendingFilesRef.current = [];
    pendingUrlRef.current = "";
    setUrl("");
    setSummary(null);
  }, []);

  const invalidateActivePipeline = useCallback(() => {
    if (!vaultId) return;
    queryClient.invalidateQueries({
      queryKey: ["vault", vaultId, "active-pipeline"],
    });
  }, [queryClient, vaultId]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length > 0) {
      pendingFilesRef.current = files;
      pendingUrlRef.current = "";
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
        const dropped: DroppedFile[] = files.map((f) => ({
          file: f,
          path: (f as any).webkitRelativePath || f.name,
        }));
        pendingFilesRef.current = dropped;
        pendingUrlRef.current = "";
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

  const handleConfirm = useCallback(async () => {
    const files = pendingFilesRef.current;
    if (files.length === 0) return;

    setConfirming(true);

    let pipelineRunId: string | null = null;
    for await (const event of ingestBulk(files.map((f) => f.file))) {
      if (event.phase === "processing" && event.pipeline_run_id) {
        pipelineRunId = event.pipeline_run_id;
        break;
      }
      if (event.phase === "error") {
        setConfirming(false);
        return;
      }
    }

    if (pipelineRunId) {
      invalidateActivePipeline();
      navigate(`/pipeline?pipeline_run_id=${pipelineRunId}`);
    } else {
      setConfirming(false);
    }
  }, [invalidateActivePipeline, navigate]);

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
          {/* Confirming pulse */}
          {confirming && (
            <div className="flex items-center gap-3 px-6 py-5">
              <span className="text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite] shrink-0 text-lg">
                ◉
              </span>
              <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint">
                uploading to vault…
              </span>
            </div>
          )}

          {/* Expanded zone */}
          {expanded && !confirming && (
            <>
              {/* Input row */}
              <div className="px-6 pt-6 pb-5">
                <div className="flex items-center gap-3">
                  <Input
                    className="flex-1 border-none bg-transparent dark:bg-transparent
                               font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                               text-warm-faint placeholder:text-warm-ghost
                               caret-gold focus-visible:ring-0 h-auto py-0 px-0"
                    placeholder={
                      isDragOver
                        ? "drop to add to knowledge base"
                        : "drop files, paste a link, or browse"
                    }
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
                  />
                  {url.trim() && (
                    <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost select-none">
                      ↵
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handleBrowse}
                    className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                               text-gold-dim hover:text-gold hover:bg-transparent
                               rounded-sm h-auto px-2 py-0 shrink-0"
                  >
                    browse
                  </Button>
                </div>
              </div>

              {/* File summary */}
              {summary && (
                <div className="px-6 pb-4 border-t border-ink-subtle pt-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
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

                  {summary.duplicates > 0 && (
                    <p className="mt-2 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
                      {summary.duplicates} duplicate
                      {summary.duplicates !== 1 ? "s" : ""} detected — duplicates will be skipped
                    </p>
                  )}

                  {summary.totalSize > 100 * 1024 * 1024 && (
                    <p className="mt-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
                      Large upload — may take a few minutes
                    </p>
                  )}
                </div>
              )}

              {/* Confirm action */}
              {summary && summary.count > 0 && (
                <div className="px-6 pb-5 flex items-center justify-end gap-3 border-t border-ink-subtle pt-4">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handleConfirm}
                    className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                               text-gold hover:text-gold-hover hover:bg-transparent
                               rounded-sm h-auto px-3 py-0.5"
                  >
                    ingest {summary.count} file
                    {summary.count !== 1 ? "s" : ""}
                  </Button>
                </div>
              )}
            </>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}
