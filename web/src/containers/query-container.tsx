import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { AnswerBlock } from "@/components/answer-block"
import { ArticlePanel } from "@/components/article-panel"
import { FollowUpBar } from "@/components/follow-up-bar"
import { SearchBar } from "@/components/search-bar"
import { SelectionPopover } from "@/components/selection-popover"
import { ThinkingSection } from "@/components/thinking-section"
import { useArticle } from "@/hooks/use-article"
import { useLinkInterceptor } from "@/hooks/use-link-interceptor"
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss"
import { useQuerySession } from "@/hooks/use-query-session"

export function QueryContainer() {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [panelSlug, setPanelSlug] = useState<string | null>(null)

  const handleLinkClick = useLinkInterceptor()
  const session = useQuerySession()
  const { content: panelContent, loading: panelLoading } =
    useArticle(panelSlug)

  usePopoverDismiss(session.clearPopover)

  const handleSubmit = useCallback(() => {
    if (!query.trim()) return
    session.submitQuery(query)
  }, [query, session.submitQuery])

  const handleReset = useCallback(() => {
    session.reset()
    setQuery("")
  }, [session.reset])

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

  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem("onboarding-hint-seen") === "true",
  )

  const dismissHint = useCallback(() => {
    setHintDismissed(true)
    localStorage.setItem("onboarding-hint-seen", "true")
  }, [])

  const showHint = useMemo(
    () =>
      !hintDismissed &&
      session.phase === "done" &&
      session.thread.length === 1,
    [hintDismissed, session.phase, session.thread.length],
  )

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
          onReset={handleReset}
        />

        {/* Thread — no auto-scroll, scrollbar appears naturally */}
        {isActive && (
          <div className="flex-1 min-h-0 overflow-y-auto" onClick={handleLinkClick}>
            <div className="px-10 pt-7 pb-5 max-w-[740px] mx-auto">
              {session.thread.map((ex, ei) => (
                <div key={ex.id}>
                  {ei > 0 && <Separator className="my-8 bg-ink-subtle" />}

                  <div className="flex items-center justify-between mb-[18px]">
                    <span className="italic text-[length:var(--text-small)] text-muted-foreground">
                      &ldquo;{ex.query}&rdquo;
                    </span>
                  </div>

                  <ThinkingSection
                    blocks={ex.thinking}
                    streaming={false}
                    onCardClick={togglePanel}
                    activeCard={panelSlug}
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
                    <Separator className="my-8 bg-ink-subtle" />
                  )}

                  <ThinkingSection
                    blocks={session.liveThinking}
                    streaming={session.phase === "searching"}
                    onCardClick={togglePanel}
                    activeCard={panelSlug}
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
            </div>
          </div>
        )}


        {/* Onboarding hint — shown once after first answer */}
        {showHint && (
          <div className="shrink-0 px-10 py-3 border-t border-ink-subtle animate-[slide-up_0.28s_ease]">
            <div className="flex items-center justify-between max-w-[740px] mx-auto gap-4">
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
                <Badge variant="outline" className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted border-gold-dim mr-2">
                  tip
                </Badge>
                {"select any text in the answer to "}
                <span className="text-warm-dim">follow up</span>
                {" or start a "}
                <span className="text-btw">btw</span>
                {" thread"}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={dismissHint}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:text-warm-faint hover:bg-transparent h-auto px-2 py-1"
              >
                dismiss
              </Button>
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
            onFullScreen={() => navigate(`/wiki/${panelSlug}`)}
          />
        </>
      )}
    </div>
  )
}
