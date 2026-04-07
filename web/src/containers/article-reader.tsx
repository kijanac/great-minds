import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"

import { ArticleChrome } from "@/components/article-chrome"
import { ArticleView } from "@/components/article-view"
import { SelectionPopover } from "@/components/selection-popover"
import { useArticle } from "@/hooks/use-article"
import { useBtw } from "@/hooks/use-btw"
import { useLinkInterceptor } from "@/hooks/use-link-interceptor"
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss"
import { slugToTitle } from "@/lib/utils"
import type { SelectionInfo } from "@/lib/types"

interface ArticleReaderProps {
  slug: string
}

export function ArticleReader({ slug }: ArticleReaderProps) {
  const navigate = useNavigate()
  const handleLinkClick = useLinkInterceptor()
  const { content, loading } = useArticle(slug)
  const { btws, startBtw, replyBtw, dismissEmpty, cleanup } = useBtw(slug)
  const [popover, setPopover] = useState<SelectionInfo | null>(null)

  usePopoverDismiss(() => setPopover(null))

  const prevSlugRef = useRef(slug)
  useEffect(() => {
    if (prevSlugRef.current !== slug) {
      cleanup()
      prevSlugRef.current = slug
    }
  }, [slug, cleanup])

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
      onQuery={(q) => navigate(`/?q=${encodeURIComponent(q)}&origin=${encodeURIComponent(slug)}`)}
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
          title={slugToTitle(slug)}
          content={content}
          btws={btws}
          onSelection={setPopover}
          onBtwReply={replyBtw}
          onBtwDismiss={dismissEmpty}
          documentId={slug}
        />
      )}

      {!loading && !content && (
        <div className="max-w-[740px] mx-auto px-10 pt-10">
          <p className="text-[length:var(--text-body)] text-warm-faint">Article not found.</p>
        </div>
      )}

      {popover && (
        <SelectionPopover info={popover} onBtw={handleBtw} />
      )}
    </ArticleChrome>
  )
}
