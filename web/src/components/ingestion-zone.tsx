import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QueueItem } from "@/hooks/use-ingestion";
import type { DroppedFile } from "@/lib/types";

interface IngestionZoneProps {
  queue: QueueItem[];
  url: string;
  onUrlChange: (url: string) => void;
  onUrlSubmit: () => void;
  onFileDrop: (files: DroppedFile[]) => void;
  onDismiss: (id: string) => void;
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

async function collectFiles(entry: FileSystemEntry, prefix: string): Promise<DroppedFile[]> {
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path: prefix ? `${prefix}/${entry.name}` : entry.name }];
  }
  if (isDirectoryEntry(entry)) {
    const reader = entry.createReader();
    const entries: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];
    do {
      batch = await new Promise((resolve) => reader.readEntries((e) => resolve(e)));
      entries.push(...batch);
    } while (batch.length > 0);
    const dir = prefix ? `${prefix}/${entry.name}` : entry.name;
    const nested = await Promise.all(entries.map((e) => collectFiles(e, dir)));
    return nested.flat();
  }
  return [];
}

async function filesFromDrop(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dataTransfer.items);
  const entries = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => e != null);

  if (entries.length > 0) {
    const nested = await Promise.all(entries.map((e) => collectFiles(e, "")));
    return nested.flat();
  }
  return Array.from(dataTransfer.files).map((f) => ({ file: f, path: f.name }));
}

export function IngestionZone({
  queue,
  url,
  onUrlChange,
  onUrlSubmit,
  onFileDrop,
  onDismiss,
}: IngestionZoneProps) {
  const [isDragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  return (
    <div className="mt-8 max-w-[640px] w-full">
      {/* Label */}
      <div className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost mb-1.5 pl-1">
        add sources
      </div>

      {/* Drop zone — always ready */}
      <div
        className={`
          rounded-sm transition-all duration-200 ease-out
          ${
            isDragOver
              ? "border border-solid border-gold-muted bg-ink-raised py-4"
              : "border border-dashed border-ink-border py-3 focus-within:border-gold-dim focus-within:border-solid"
          }
        `}
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
        onDrop={(e) => {
          e.preventDefault();
          dragCounter.current = 0;
          setDragOver(false);
          filesFromDrop(e.dataTransfer)
            .then((files) => {
              if (files.length > 0) onFileDrop(files);
            })
            .catch((err) => console.error("Failed to read dropped files:", err));
        }}
      >
        <div className="flex items-center">
          <Input
            className="flex-1 border-none bg-transparent dark:bg-transparent font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint placeholder:text-warm-ghost caret-gold focus-visible:ring-0 focus-visible:border-none h-auto py-0 px-4"
            placeholder={
              isDragOver ? "drop to add to knowledge base" : "drop a file or paste a link"
            }
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onUrlSubmit()}
          />
          {url.trim() && (
            <span className="pr-3.5 font-mono text-[length:var(--text-chrome)] text-warm-ghost select-none">
              ↵
            </span>
          )}
        </div>
      </div>

      {/* Queue */}
      {queue.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {queue.map((item) => (
            <QueueRow key={item.id} item={item} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueRow({ item, onDismiss }: { item: QueueItem; onDismiss: (id: string) => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 min-w-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em]">
      {item.status === "queued" && (
        <>
          <span className="text-warm-ghost shrink-0">○</span>
          <span className="text-warm-ghost truncate">{item.name}</span>
          <span className="text-warm-ghost ml-auto shrink-0">queued</span>
        </>
      )}

      {item.status === "processing" && (
        <>
          <span className="text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite] shrink-0">
            ◉
          </span>
          <span className="text-warm-faint truncate">{item.name}</span>
          <span className="text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite] ml-auto shrink-0">
            ingesting…
          </span>
        </>
      )}

      {item.status === "done" && (
        <>
          <span className="text-gold-dim shrink-0">✓</span>
          <span className="font-serif italic text-[length:var(--text-small)] text-warm-faint truncate">
            {item.name}
          </span>
          <span className="text-warm-ghost ml-auto shrink-0">added</span>
        </>
      )}

      {item.status === "error" && (
        <>
          <span className="text-warm-faint shrink-0">✗</span>
          <span className="text-warm-ghost truncate">{item.error}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onDismiss(item.id)}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-dim hover:text-gold hover:bg-transparent rounded-sm h-auto px-1 py-0 ml-auto shrink-0"
          >
            dismiss
          </Button>
        </>
      )}
    </div>
  );
}
