import { useEffect, useRef, useState } from "react"

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
      className="my-[10px] mb-3 border-l-2 border-[#2a1e0e] pl-3.5"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="flex items-baseline gap-2 w-full pb-[7px] text-left h-auto p-0 rounded-none hover:bg-transparent justify-start"
          />
        }
      >
        <span className="font-mono text-[8.5px] tracking-[0.16em] text-gold uppercase shrink-0">
          BTW
        </span>
        <span className="italic text-[11px] text-muted-foreground flex-1 text-left">
          &ldquo;{shortAnchor}&rdquo;
        </span>
        <span className="font-mono text-[8px] text-[#2e2216] shrink-0">
          {open ? "\u25BE" : "\u25B8"}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {btw.messages.map((m, i) => (
          <div
            key={i}
            className={`text-[12.5px] leading-[1.72] mb-[9px] ${
              m.role === "user"
                ? "text-[#6a5a48] italic"
                : "text-warm-faint"
            }`}
          >
            {m.role === "user" && (
              <span className="font-mono not-italic text-[8.5px] tracking-[0.1em] text-[#3a2e1e] mr-0.5">
                you ·{" "}
              </span>
            )}
            {m.text}
          </div>
        ))}

        {btw.streaming && (
          <div className="text-[12.5px] leading-[1.72] mb-[9px] text-warm-faint">
            {btw.streamText}
            <span className="inline-block w-px h-2.5 bg-[#7a6040] animate-[blink_1s_step-end_infinite] align-middle ml-px" />
          </div>
        )}

        {!btw.streaming && (
          <div
            className="mt-[5px]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              className="bg-transparent border-0 border-b border-b-[#241c0e] outline-none text-[#7a6a58] font-serif italic text-xs py-[3px] w-full caret-[#c9a96e] placeholder:text-[#2a1e10]"
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
