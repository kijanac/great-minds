import { useEffect, useRef, useState } from "react"
import Markdown from "react-markdown"
import { ChevronDown, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { baseMdComponents, remarkPlugins } from "@/lib/markdown"
import type { BtwThread as BtwThreadType } from "@/lib/types"

interface BtwThreadProps {
  btw: BtwThreadType
  onReply: (btwId: string, text: string) => void
  onDismiss?: (btwId: string) => void
}

const btwMdComponents = {
  ...baseMdComponents,
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-0.5">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc list-inside mb-1 ml-2">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal list-inside mb-1 ml-2">{children}</ol>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-gold-dim pl-2.5 text-warm-faint italic my-1.5">
      {children}
    </blockquote>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="font-mono text-[length:var(--text-chrome)] bg-code-bg px-1 py-0.5 rounded-sm text-gold">
      {children}
    </code>
  ),
}

export function BtwThread({ btw, onReply, onDismiss }: BtwThreadProps) {
  const [input, setInput] = useState("")
  const [open, setOpen] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  const shortAnchor =
    btw.anchor.length > 58 ? btw.anchor.slice(0, 58) + "..." : btw.anchor

  // Auto-focus: on first render (new BTW) and when streaming finishes
  const wasStreaming = useRef(btw.streaming)
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      inputRef.current?.focus()
      return
    }
    if (wasStreaming.current && !btw.streaming) {
      inputRef.current?.focus()
    }
    wasStreaming.current = btw.streaming
  }, [btw.streaming])

  // Sources sit between the last user message and the assistant
  // response — whether that response is still streaming or final.
  const lastMsg = btw.messages[btw.messages.length - 1]
  const lastAssistant = !btw.streaming && lastMsg?.role === "assistant" ? lastMsg : null
  const visibleMessages = lastAssistant ? btw.messages.slice(0, -1) : btw.messages

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
          {`"${shortAnchor}"`}
        </span>
        <span className="font-mono text-[length:var(--text-chrome)] text-interactive-dim shrink-0">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {visibleMessages.map((m, i) => (
          <div
            key={i}
            className={`text-[length:var(--text-small)] leading-[1.72] mb-[9px] ${
              m.role === "user"
                ? "text-warm-ghost italic"
                : "text-warm-faint"
            }`}
          >
            {m.role === "user" ? (
              <>
                <span className="font-mono not-italic text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim mr-0.5">
                  you ·{" "}
                </span>
                {m.text}
              </>
            ) : (
              <Markdown remarkPlugins={remarkPlugins} components={btwMdComponents}>
                {m.text}
              </Markdown>
            )}
          </div>
        ))}

        {btw.sources.length > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 mb-[7px]">
            {btw.sources.map((s, i) => (
              <span
                key={i}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-interactive-dim"
                title={s.thinking}
              >
                {s.label}
              </span>
            ))}
          </div>
        )}

        {btw.streaming && !btw.streamText && (
          <div className="text-[length:var(--text-small)] leading-[1.72] mb-[9px] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
            {btw.sources.length > 0 ? "reading..." : "thinking..."}
          </div>
        )}

        {btw.streaming && btw.streamText && (
          <div className="text-[length:var(--text-small)] leading-[1.72] mb-[9px] text-warm-faint">
            <Markdown remarkPlugins={remarkPlugins} components={btwMdComponents}>
              {btw.streamText}
            </Markdown>
            <span className="inline-block w-px h-2.5 bg-gold-muted animate-[blink_1s_step-end_infinite] align-middle ml-px" />
          </div>
        )}

        {lastAssistant && (
          <div className="text-[length:var(--text-small)] leading-[1.72] mb-[9px] text-warm-faint">
            <Markdown remarkPlugins={remarkPlugins} components={btwMdComponents}>
              {lastAssistant.text}
            </Markdown>
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
              onBlur={() => {
                if (btw.messages.length === 0 && !input.trim() && onDismiss) {
                  onDismiss(btw.id)
                }
              }}
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
