import Markdown from "react-markdown"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

interface ArticlePanelProps {
  slug: string
  content: string | null
  loading: boolean
  onClose: () => void
}

export function ArticlePanel({
  slug,
  content,
  loading,
  onClose,
}: ArticlePanelProps) {
  const title = slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")

  return (
    <div className="fixed top-0 right-0 w-[370px] h-screen bg-[#0e0e0e] border-l border-ink-subtle flex flex-col z-[200] shadow-[-24px_0_60px_rgba(0,0,0,0.6)] animate-[panel-in_0.28s_cubic-bezier(0.4,0,0.2,1)]">
      <div className="px-5 pt-5 pb-3.5 border-b border-ink-subtle shrink-0">
        <div className="flex items-start justify-between mb-[9px]">
          <span className="text-[14.5px] font-bold text-foreground">
            {title}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className="text-[#2e2a28] hover:text-warm-faint hover:bg-transparent shrink-0"
          >
            <span className="text-[17px]">&times;</span>
          </Button>
        </div>
        <div className="flex gap-[7px]">
          <Badge
            variant="outline"
            className="rounded-sm h-auto font-mono text-[8.5px] tracking-[0.1em] px-2 py-[3px] bg-[#100e08] text-gold border-[#241c0e]"
          >
            {slug}
          </Badge>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-5 py-[18px]">
          {loading && (
            <p className="text-[12.5px] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
              Loading...
            </p>
          )}
          {!loading && content && (
            <div className="text-[12.5px] leading-[1.76] text-warm-faint [&_p]:mb-[13px] [&_h2]:text-[14px] [&_h2]:font-bold [&_h2]:text-foreground [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-[11px] [&_h3]:font-mono [&_h3]:text-gold [&_h3]:tracking-[0.1em] [&_h3]:uppercase [&_h3]:mt-4 [&_h3]:mb-2">
              <Markdown>{content}</Markdown>
            </div>
          )}
          {!loading && !content && (
            <p className="text-[12.5px] text-warm-faint">
              Article not found.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
