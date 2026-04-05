import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router"

import { ArticleChrome } from "@/components/article-chrome"
import { ArticleView } from "@/components/article-view"
import { SelectionPopover } from "@/components/selection-popover"
import { useBtw } from "@/hooks/use-btw"
import { useLinkInterceptor } from "@/hooks/use-link-interceptor"
import type { SelectionInfo } from "@/lib/types"

interface ArticleReaderProps {
  slug: string
  content: string | null
  loading: boolean
}

export function ArticleReader({ slug, content, loading }: ArticleReaderProps) {
  const navigate = useNavigate()
  const handleLinkClick = useLinkInterceptor()
  const { btws, startBtw, replyBtw, cleanup } = useBtw()
  const [popover, setPopover] = useState<SelectionInfo | null>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-popover]")) setPopover(null)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  useEffect(() => cleanup(), [slug, cleanup])

  const title = slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")

  const handleBtw = useCallback(() => {
    if (!popover) return
    startBtw(popover)
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [popover, startBtw])

  return (
    <ArticleChrome
      slug={slug}
      onHome={() => navigate("/")}
      onQuery={(q) => navigate(`/?q=${encodeURIComponent(q)}`)}
      onContentClick={handleLinkClick}
    >
      {loading && (
        <div className="max-w-[740px] mx-auto px-10 pt-10">
          <p className="text-[length:var(--text-body)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
            Loading...
          </p>
        </div>
      )}

      {!loading && content && (
        <ArticleView
          title={title}
          content={content}
          btws={btws}
          onSelection={setPopover}
          onBtwReply={replyBtw}
          documentId={slug}
        />
      )}

      {!loading && !content && (
        <div className="max-w-[740px] mx-auto px-10 pt-10">
          <p className="text-[length:var(--text-body)] text-warm-faint">Article not found.</p>
        </div>
      )}

      {popover && (
        <SelectionPopover info={popover} onFollowUp={handleBtw} onBtw={handleBtw} />
      )}
    </ArticleChrome>
  )
}
