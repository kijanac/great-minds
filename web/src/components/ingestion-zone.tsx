import { useRef, useState } from "react"

import { Input } from "@/components/ui/input"
import type { IngestionStatus } from "@/hooks/use-ingestion"

interface IngestionZoneProps {
  status: IngestionStatus
  resultName?: string
  errorMessage?: string
  url: string
  onUrlChange: (url: string) => void
  onUrlSubmit: () => void
  onFileDrop: (file: File) => void
  onReset: () => void
}

export function IngestionZone({
  status,
  resultName,
  errorMessage,
  url,
  onUrlChange,
  onUrlSubmit,
  onFileDrop,
  onReset,
}: IngestionZoneProps) {
  const [isDragOver, setDragOver] = useState(false)
  const dragCounter = useRef(0)

  const isIdle = status === "idle"

  return (
    <div className="mt-8 max-w-[640px] w-full">
      {/* Label */}
      <div className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost mb-1.5 pl-1">
        add sources
      </div>

      {/* Zone */}
      <div
        className={`
          rounded-sm transition-all duration-200 ease-out
          ${
            isDragOver && isIdle
              ? "border border-solid border-gold-muted bg-ink-raised py-4"
              : isIdle
                ? "border border-dashed border-ink-border py-3"
                : "border border-solid border-ink-border py-3"
          }
        `}
        onDragEnter={(e) => {
          e.preventDefault()
          if (!isIdle) return
          dragCounter.current++
          setDragOver(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault()
          dragCounter.current--
          if (dragCounter.current <= 0) {
            dragCounter.current = 0
            setDragOver(false)
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          dragCounter.current = 0
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file && isIdle) onFileDrop(file)
        }}
      >
        {/* Idle / Drag-over: URL input */}
        {isIdle && (
          <div className="flex items-center">
            <Input
              className="flex-1 border-none bg-transparent font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint placeholder:text-warm-ghost caret-gold focus-visible:ring-0 focus-visible:border-none h-auto py-0 px-4"
              placeholder={
                isDragOver
                  ? "drop to add to knowledge base"
                  : "drop a file or paste a link"
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
        )}

        {/* Processing */}
        {status === "processing" && (
          <div className="px-4 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite]">
            ingesting…
          </div>
        )}

        {/* Done */}
        {status === "done" && (
          <div className="px-4 flex items-center gap-2 min-w-0">
            <span className="font-mono text-[length:var(--text-chrome)] text-gold-dim shrink-0">
              ✓
            </span>
            <span className="font-serif italic text-[length:var(--text-small)] text-warm-faint truncate">
              {resultName}
            </span>
            <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0">
              added
            </span>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="px-4 flex items-center gap-2 min-w-0">
            <span className="font-mono text-[length:var(--text-chrome)] text-warm-faint shrink-0">
              failed
            </span>
            <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost">
              —
            </span>
            <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost truncate">
              {errorMessage}
            </span>
            <button
              onClick={onReset}
              className="font-mono text-[length:var(--text-chrome)] text-gold-dim hover:text-gold transition-colors ml-auto shrink-0 cursor-pointer"
            >
              try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
