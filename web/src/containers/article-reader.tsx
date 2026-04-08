import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router"

import { ArticleChrome } from "@/components/article-chrome"
import { ArticleView } from "@/components/article-view"
import { SelectionPopover } from "@/components/selection-popover"
import { useDocument } from "@/hooks/use-document"
import { useBtw } from "@/hooks/use-btw"
import { useLinkInterceptor } from "@/hooks/use-link-interceptor"
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss"
import { docDisplayName, slugToTitle } from "@/lib/utils"
import type { SelectionInfo } from "@/lib/types"

interface ArticleReaderProps {
  path: string
}

export function ArticleReader({ path }: ArticleReaderProps) {
  const navigate = useNavigate()
  const handleLinkClick = useLinkInterceptor()
  const { content, loading } = useDocument(path)
  const { btws, startBtw, replyBtw, dismissEmpty, cleanup } = useBtw(path)
  const [popover, setPopover] = useState<SelectionInfo | null>(null)

  usePopoverDismiss(() => setPopover(null))

  useEffect(() => {
    return () => { cleanup() }
  }, [path, cleanup])

  const handleBtw = useCallback(() => {
    if (!popover) return
    startBtw(popover)
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [popover, startBtw])

  const displayName = docDisplayName(path)
  const title = slugToTitle(displayName)

  return (
    <ArticleChrome
      label={displayName}
      onHome={() => navigate("/")}
      onQuery={(q) => navigate(`/?q=${encodeURIComponent(q)}&origin=${encodeURIComponent(path)}`)}
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
          onBtwDismiss={dismissEmpty}
          documentId={path}
        />
      )}

      {!loading && !content && (
        <div className="max-w-[740px] mx-auto px-10 pt-10">
          <p className="text-[length:var(--text-body)] text-warm-faint">Document not found.</p>
        </div>
      )}

      {popover && (
        <SelectionPopover info={popover} onBtw={handleBtw} />
      )}
    </ArticleChrome>
  )
}
