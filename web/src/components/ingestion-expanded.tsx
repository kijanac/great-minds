import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DroppedFile } from "@/lib/types";

interface IngestionExpandedProps {
  onFileDrop: (files: DroppedFile[]) => void;
  onUrlSubmit: (url: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  layoutId: string;
}

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

export function IngestionExpanded({
  onFileDrop,
  onUrlSubmit,
  onConfirm,
  onCancel,
  layoutId,
}: IngestionExpandedProps) {
  const [isDragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const [url, setUrl] = useState("");
  const [summary, setSummary] = useState<FileSummary | null>(null);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const files = await filesFromDrop(e.dataTransfer);
      if (files.length > 0) {
        setSummary(computeSummary(files));
        onFileDrop(files);
      }
    },
    [onFileDrop],
  );

  const handleUrlSubmit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    onUrlSubmit(trimmed);
    setUrl("");
  }, [url, onUrlSubmit]);

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
        setSummary(computeSummary(dropped));
        onFileDrop(dropped);
      }
    };
    input.click();
  }, [onFileDrop]);

  // Global Escape to cancel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <motion.div
      layoutId={layoutId}
      className="w-full max-w-[640px] rounded-sm transition-all duration-200 ease-out
                 border border-solid border-gold-dim bg-ink-raised overflow-hidden"
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current--;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={handleDrop}
    >
      {/* Drop target area */}
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <Input
            className="flex-1 border-none bg-transparent dark:bg-transparent
                       font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                       text-warm-faint placeholder:text-warm-ghost
                       caret-gold focus-visible:ring-0 h-auto py-0 px-0"
            placeholder={
              isDragOver ? "drop to add to knowledge base" : "drop files, paste a link, or browse"
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

      {/* Pre-ingest summary */}
      {summary && (
        <div className="px-5 pb-3 border-t border-ink-subtle pt-3">
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
              {summary.duplicates} duplicate{summary.duplicates !== 1 ? "s" : ""} detected —
              duplicates will be skipped
            </p>
          )}

          {summary.totalSize > 100 * 1024 * 1024 && (
            <p className="mt-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
              Large upload — may take a few minutes
            </p>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="px-5 pb-4 flex items-center justify-between gap-3 border-t border-ink-subtle pt-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={onCancel}
          className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                     text-warm-ghost hover:text-warm-faint hover:bg-transparent
                     rounded-sm h-auto px-2 py-0"
        >
          cancel
        </Button>
        {summary && summary.count > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onConfirm}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                       text-gold hover:text-gold-hover hover:bg-transparent
                       rounded-sm h-auto px-3 py-0.5"
          >
            ingest {summary.count} file{summary.count !== 1 ? "s" : ""}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
