import { useCallback, useEffect, useRef, useState } from "react"

import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { AnswerBlock } from "@/components/answer-block"
import { ArticlePanel } from "@/components/article-panel"
import { FollowUpBar } from "@/components/follow-up-bar"
import { SearchBar } from "@/components/search-bar"
import { SelectionPopover } from "@/components/selection-popover"
import { SourceCards } from "@/components/source-cards"
import { useArticle } from "@/hooks/use-article"
import { useQuerySession } from "@/hooks/use-query-session"

export function QueryContainer() {
  const [query, setQuery] = useState("")
  const [panelSlug, setPanelSlug] = useState<string | null>(null)
  const [cardsCollapsed, setCardsCollapsed] = useState<Record<string, boolean>>(
    {},
  )
  const [saved, setSaved] = useState(false)
  const scrollSentinelRef = useRef<HTMLDivElement>(null)

  const session = useQuerySession()
  const { content: panelContent, loading: panelLoading } =
    useArticle(panelSlug)

  // Dismiss popover on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-popover]")) {
        session.clearPopover()
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [session.clearPopover])

  // Auto-scroll only while actively streaming, not after done
  const isStreaming =
    session.phase === "searching" || session.phase === "streaming"
  useEffect(() => {
    if (isStreaming) {
      scrollSentinelRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [isStreaming, session.liveText])

  const handleSubmit = useCallback(() => {
    if (!query.trim()) return
    session.submitQuery(query)
  }, [query, session.submitQuery])

  const handleFollowUp = useCallback(
    (text: string) => {
      session.submitFollowUp(text)
    },
    [session.submitFollowUp],
  )

  const togglePanel = useCallback((slug: string) => {
    setPanelSlug((prev) => (prev === slug ? null : slug))
  }, [])

  const handleAddChip = useCallback(() => {
    if (!session.popover) return
    session.addChip(session.popover.text)
  }, [session.popover, session.addChip])

  const handleBtw = useCallback(() => {
    if (!session.popover) return
    session.startBtw(session.popover)
  }, [session.popover, session.startBtw])

  const isActive = session.phase !== "idle"
  const canFollowUp = session.phase === "done"

  return (
    <div className="flex h-screen overflow-hidden relative">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Search bar */}
        <SearchBar
          query={query}
          phase={session.phase}
          onQueryChange={setQuery}
          onSubmit={handleSubmit}
          onReset={session.reset}
        />

        {/* Thread */}
        {isActive && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="px-10 pt-7 pb-5 max-w-[740px]">
              {session.thread.map((ex, ei) => (
                <div key={ex.id}>
                  {ei > 0 && <Separator className="my-8 bg-[#141414]" />}

                  <div className="flex items-center justify-between mb-[18px]">
                    <span className="italic text-[12.5px] text-muted-foreground">
                      &ldquo;{ex.query}&rdquo;
                    </span>
                    {ei === session.thread.length - 1 && canFollowUp && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSaved(true)}
                        disabled={saved}
                        className={`rounded-sm h-auto font-mono text-[9px] tracking-[0.1em] py-[5px] px-3 flex items-center gap-[5px] ${
                          saved
                            ? "border-[#1e3a1e] text-[#5a8a5a] cursor-default"
                            : "border-[#1c1c1c] text-[#4a4030] hover:border-gold-dim hover:text-gold"
                        }`}
                      >
                        <span className="w-1 h-1 rounded-full bg-current" />
                        {saved ? "saved" : "save to wiki"}
                      </Button>
                    )}
                  </div>

                  <SourceCards
                    cards={ex.cards}
                    activeCard={panelSlug}
                    collapsed={cardsCollapsed[ex.id] ?? false}
                    onCollapsedChange={(c) =>
                      setCardsCollapsed((prev) => ({ ...prev, [ex.id]: c }))
                    }
                    onCardClick={togglePanel}
                  />

                  <AnswerBlock
                    text={ex.answer}
                    exchangeId={ex.id}
                    btws={ex.btws}
                    streaming={false}
                    onSelection={session.handleSelection}
                    onBtwReply={session.replyBtw}
                  />
                </div>
              ))}

              {/* Live exchange */}
              {(session.phase === "searching" ||
                session.phase === "streaming") && (
                <div>
                  {session.thread.length > 0 && (
                    <Separator className="my-8 bg-[#141414]" />
                  )}

                  {session.phase === "searching" &&
                    session.liveCards.length === 0 && (
                      <div className="font-mono text-[9.5px] tracking-[0.12em] text-gold-muted animate-[pulse-fade_1.6s_ease-in-out_infinite] py-1 pb-4">
                        traversing knowledge base...
                      </div>
                    )}

                  <SourceCards
                    cards={session.liveCards}
                    activeCard={panelSlug}
                    collapsed={false}
                    onCollapsedChange={() => {}}
                    onCardClick={togglePanel}
                  />

                  {session.liveText && (
                    <AnswerBlock
                      text={session.liveText}
                      exchangeId="live"
                      btws={[]}
                      streaming={true}
                      onSelection={() => {}}
                      onBtwReply={() => {}}
                    />
                  )}
                </div>
              )}

              <div ref={scrollSentinelRef} />
            </div>
          </div>
        )}

        {/* Follow-up bar */}
        {canFollowUp && (
          <FollowUpBar
            chips={session.chips}
            onRemoveChip={session.removeChip}
            onSubmit={handleFollowUp}
          />
        )}
      </div>

      {/* Selection popover */}
      {session.popover && (
        <SelectionPopover
          info={session.popover}
          onFollowUp={handleAddChip}
          onBtw={handleBtw}
        />
      )}

      {/* Article panel overlay + backdrop */}
      {panelSlug && (
        <>
          <div
            className="fixed inset-0 z-[199]"
            onClick={() => setPanelSlug(null)}
          />
          <ArticlePanel
            slug={panelSlug}
            content={panelContent}
            loading={panelLoading}
            onClose={() => setPanelSlug(null)}
          />
        </>
      )}
    </div>
  )
}
