import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QueueItem } from "@/hooks/use-ingestion";

interface IngestionZoneProps {
  queue: QueueItem[];
  url: string;
  onUrlChange: (url: string) => void;
  onUrlSubmit: () => void;
  onFileDrop: (file: File) => void;
  onDismiss: (id: string) => void;
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
          const file = e.dataTransfer.files[0];
          if (file) onFileDrop(file);
        }}
      >
        <div className="flex items-center">
          <Input
            className="flex-1 border-none bg-transparent font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint placeholder:text-warm-ghost caret-gold focus-visible:ring-0 focus-visible:border-none h-auto py-0 px-4"
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
