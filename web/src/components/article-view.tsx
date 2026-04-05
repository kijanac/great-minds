import { useCallback, type ComponentProps } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { BtwThread } from "@/components/btw-thread"
import type { BtwThread as BtwThreadType, SelectionInfo } from "@/lib/types"

interface ArticleViewProps {
  title: string
  content: string
  btws: BtwThreadType[]
  onSelection: (info: SelectionInfo) => void
  onBtwReply: (btwId: string, text: string) => void
  documentId: string
}

export function ArticleView({
  title,
  content,
  btws,
  onSelection,
  onBtwReply,
  documentId,
}: ArticleViewProps) {
  const handleMouseUp = useCallback(
    (pi: number) => (e: React.MouseEvent) => {
      e.stopPropagation()
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 5) return

      const rect = sel.getRangeAt(0).getBoundingClientRect()
      onSelection({
        text: sel.toString().trim(),
        x: rect.left + rect.width / 2,
        y: rect.top - 6,
        paragraphIndex: pi,
        exchangeId: documentId,
      })
    },
    [documentId, onSelection],
  )

  let paraCount = 0

  const mdComponents: ComponentProps<typeof Markdown>["components"] = {
    h1: ({ children }) => (
      <h1 className="text-[length:var(--text-heading)] font-bold text-foreground mt-8 mb-4 first:mt-0">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-[length:var(--text-heading)] font-bold text-foreground mt-8 mb-3">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-mono text-[length:var(--text-caption)] font-medium text-gold mt-6 mb-2 tracking-[0.14em] uppercase">
        {children}
      </h3>
    ),
    p: ({ children }) => {
      const pi = paraCount++
      const blockBtws = btws.filter((b) => b.paragraphIndex === pi)
      return (
        <>
          <p
            className="text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4"
            onMouseUp={handleMouseUp(pi)}
          >
            {children}
          </p>
          {blockBtws.map((btw) => (
            <BtwThread key={btw.id} btw={btw} onReply={onBtwReply} />
          ))}
        </>
      )
    },
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
      <ul className="list-disc list-inside text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 ml-2">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal list-inside text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 ml-2">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="mb-1">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-gold-dim pl-4 text-warm-faint italic my-4">
        {children}
      </blockquote>
    ),
    code: ({ children }) => (
      <code className="font-mono text-[length:var(--text-small)] bg-code-bg px-1.5 py-0.5 rounded-sm text-gold">
        {children}
      </code>
    ),
  }

  return (
    <article className="max-w-[740px] mx-auto px-10 pt-10 pb-20 select-text">
      <h1 className="text-[length:var(--text-title)] font-bold text-foreground mb-8">{title}</h1>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {content}
      </Markdown>
    </article>
  )
}
