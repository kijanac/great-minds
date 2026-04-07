import { Fragment, useCallback, type ComponentProps } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

import type { BtwThread as BtwThreadType, SelectionInfo } from "@/lib/types"
import { BtwThread } from "./btw-thread"

const remarkPlugins = [remarkGfm]

interface AnswerBlockProps {
  text: string
  exchangeId: string
  btws: BtwThreadType[]
  streaming: boolean
  onSelection: (info: SelectionInfo) => void
  onBtwReply: (btwId: string, text: string) => void
  onBtwDismiss?: (btwId: string) => void
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n\n+/)
    .filter((b) => b.trim())
}

const mdComponents: ComponentProps<typeof Markdown>["components"] = {
  h2: ({ children }) => (
    <h2 className="text-[length:var(--text-heading)] font-bold text-foreground mt-[26px] mb-[11px] -tracking-[0.01em] first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-mono text-[length:var(--text-chrome)] font-medium text-gold mt-[18px] mb-2 tracking-[0.14em] uppercase">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="text-[length:var(--text-body)] leading-[1.82] text-warm-dim mb-0.5">
      {children}
    </p>
  ),
  a: ({ children, href }) => {
    const isExternal = href?.startsWith("http")
    return (
      <a
        href={href}
        className="text-gold underline underline-offset-2 decoration-gold/30 hover:decoration-gold/60 transition-colors"
        {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    )
  },
  em: ({ children }) => <em className="text-warm">{children}</em>,
  strong: ({ children }) => (
    <strong className="text-foreground font-bold">{children}</strong>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-inside text-[length:var(--text-body)] leading-[1.82] text-warm-dim mb-2 ml-2">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside text-[length:var(--text-body)] leading-[1.82] text-warm-dim mb-2 ml-2">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gold-dim pl-3.5 text-warm-faint italic my-3">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="font-mono text-[length:var(--text-small)] bg-code-bg px-1.5 py-0.5 rounded-sm text-gold">
      {children}
    </code>
  ),
}

export function AnswerBlock({
  text,
  exchangeId,
  btws,
  streaming,
  onSelection,
  onBtwReply,
  onBtwDismiss,
}: AnswerBlockProps) {
  const blocks = splitBlocks(text)
  let paraIndex = 0

  const makeSelectionHandler = useCallback(
    (pi: number) => (e: React.MouseEvent) => {
      if (streaming) return
      e.stopPropagation()

      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 5) return

      const rect = sel.getRangeAt(0).getBoundingClientRect()
      onSelection({
        text: sel.toString().trim(),
        x: rect.left + rect.width / 2,
        y: rect.top - 6,
        paragraphIndex: pi,
        exchangeId,
      })
    },
    [streaming, exchangeId, onSelection],
  )

  return (
    <div className="select-text">
      {blocks.map((block, i) => {
        const pi = paraIndex++
        const blockBtws = btws.filter((b) => b.paragraphIndex === pi)
        const isLast = i === blocks.length - 1

        return (
          <Fragment key={i}>
            <div onMouseUp={makeSelectionHandler(pi)}>
              <Markdown remarkPlugins={remarkPlugins} components={mdComponents}>{block}</Markdown>
              {streaming && isLast && (
                <span className="inline-block w-0.5 h-[13px] bg-gold animate-[blink_1s_step-end_infinite] align-middle ml-px" />
              )}
            </div>
            {blockBtws.map((btw) => (
              <BtwThread key={btw.id} btw={btw} onReply={onBtwReply} onDismiss={onBtwDismiss} />
            ))}
          </Fragment>
        )
      })}
    </div>
  )
}
