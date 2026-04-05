import { Maximize2, X } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { Badge } from "@/components/ui/badge"
import { slugToTitle } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface ArticlePanelProps {
  slug: string
  content: string | null
  loading: boolean
  onClose: () => void
  onFullScreen: () => void
}

export function ArticlePanel({
  slug,
  content,
  loading,
  onClose,
  onFullScreen,
}: ArticlePanelProps) {
  const title = slugToTitle(slug)

  return (
    <div className="fixed top-0 right-0 w-[370px] h-screen bg-ink-panel border-l border-ink-subtle flex flex-col z-[200] shadow-[-24px_0_60px_rgba(0,0,0,0.6)] animate-[panel-in_0.28s_cubic-bezier(0.4,0,0.2,1)]">
      <div className="px-5 pt-5 pb-3.5 border-b border-ink-subtle shrink-0">
        <div className="flex items-start justify-between mb-[9px]">
          <span className="text-[length:var(--text-body)] font-bold text-foreground">
            {title}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onFullScreen}
              className="text-muted-foreground hover:text-gold hover:bg-transparent shrink-0"
              title="Open full screen"
            >
              <Maximize2 size={12} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              className="text-muted-foreground hover:text-warm-faint hover:bg-transparent shrink-0"
            >
              <X size={14} />
            </Button>
          </div>
        </div>
        <div className="flex gap-[7px]">
          <Badge
            variant="outline"
            className="rounded-sm h-auto font-mono text-[length:var(--text-chrome)] tracking-[0.1em] px-2 py-[3px] bg-interactive-dim text-gold border-gold-dim"
          >
            {slug}
          </Badge>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-5 py-[18px]">
          {loading && (
            <p className="text-[length:var(--text-small)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
              Loading...
            </p>
          )}
          {!loading && content && (
            <div className="text-[length:var(--text-small)] leading-[1.76] text-warm-faint [&_p]:mb-[13px] [&_h2]:text-[length:var(--text-body)] [&_h2]:font-bold [&_h2]:text-foreground [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-[length:var(--text-caption)] [&_h3]:font-mono [&_h3]:text-gold [&_h3]:tracking-[0.1em] [&_h3]:uppercase [&_h3]:mt-4 [&_h3]:mb-2">
              <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            </div>
          )}
          {!loading && !content && (
            <p className="text-[length:var(--text-small)] text-warm-faint">
              Article not found.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
