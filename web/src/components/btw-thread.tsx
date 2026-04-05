import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import type { BtwThread as BtwThreadType } from "@/lib/types"

interface BtwThreadProps {
  btw: BtwThreadType
  onReply: (btwId: string, text: string) => void
}

export function BtwThread({ btw, onReply }: BtwThreadProps) {
  const [input, setInput] = useState("")
  const [open, setOpen] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  const shortAnchor =
    btw.anchor.length > 58 ? btw.anchor.slice(0, 58) + "..." : btw.anchor

  // Auto-focus the reply input when streaming finishes
  const wasStreaming = useRef(btw.streaming)
  useEffect(() => {
    if (wasStreaming.current && !btw.streaming) {
      inputRef.current?.focus()
    }
    wasStreaming.current = btw.streaming
  }, [btw.streaming])

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-[10px] mb-3 border-l-2 border-gold-dim pl-3.5"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="flex items-baseline gap-2 w-full pb-[7px] text-left h-auto p-0 rounded-none hover:bg-transparent justify-start"
          />
        }
      >
        <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold uppercase shrink-0">
          BTW
        </span>
        <span className="italic text-[length:var(--text-caption)] text-muted-foreground flex-1 text-left">
          &ldquo;{shortAnchor}&rdquo;
        </span>
        <span className="font-mono text-[length:var(--text-chrome)] text-interactive-dim shrink-0">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {btw.messages.map((m, i) => (
          <div
            key={i}
            className={`text-[length:var(--text-small)] leading-[1.72] mb-[9px] ${
              m.role === "user"
                ? "text-warm-ghost italic"
                : "text-warm-faint"
            }`}
          >
            {m.role === "user" && (
              <span className="font-mono not-italic text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim mr-0.5">
                you ·{" "}
              </span>
            )}
            {m.text}
          </div>
        ))}

        {btw.streaming && (
          <div className="text-[length:var(--text-small)] leading-[1.72] mb-[9px] text-warm-faint">
            {btw.streamText}
            <span className="inline-block w-px h-2.5 bg-gold-muted animate-[blink_1s_step-end_infinite] align-middle ml-px" />
          </div>
        )}

        {!btw.streaming && (
          <div
            className="mt-[5px]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              className="bg-transparent border-0 border-b border-b-gold-dim outline-none text-warm-ghost font-serif italic text-xs py-[3px] w-full caret-gold placeholder:text-interactive-dim"
              placeholder="continue..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim()) {
                  onReply(btw.id, input.trim())
                  setInput("")
                }
              }}
            />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
