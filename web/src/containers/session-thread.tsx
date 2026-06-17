import { useCallback, useState } from "react";

import { useViewNavigate } from "@/hooks/use-view-navigate";

import { fetchChunks, fetchLinks, readDocument } from "@/api/doc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AnswerBlock } from "@/components/answer-block";
import { ArticlePanel, type PanelContent } from "@/components/article-panel";
import type { SourceRef } from "@/lib/types";
import { FollowUpBar } from "@/components/follow-up-bar";
import { PromoteButton } from "@/components/promote-button";
import { SelectionPopover } from "@/components/selection-popover";
import { ThinkingSection } from "@/components/thinking-section";
import { useLinkInterceptor } from "@/hooks/use-link-interceptor";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import type { useSession } from "@/hooks/use-session";

type Session = ReturnType<typeof useSession>;

interface SessionThreadProps {
  session: Session;
  onFollowUp: (text: string) => void;
}

export function SessionThread({ session, onFollowUp }: SessionThreadProps) {
  const navigate = useViewNavigate();
  const [panel, setPanel] = useState<{
    card: SourceRef;
    content: PanelContent | null;
    loading: boolean;
  } | null>(null);

  // Open a card showing exactly what entered the agent's context: a full
  // read → the document; expanded chunks → those passages; a links card →
  // the article's connections. Lazy-fetched per mode.
  const openCard = useCallback(async (card: SourceRef) => {
    setPanel({ card, content: null, loading: true });
    try {
      let content: PanelContent;
      if (card.type === "links") {
        content = { mode: "links", links: await fetchLinks(card.label) };
      } else if (!card.full && card.ranges && card.ranges.length > 0) {
        const chunks = (
          await Promise.all(card.ranges.map((r) => fetchChunks(card.label, r.start, r.end)))
        ).flat();
        content = { mode: "chunks", chunks };
      } else {
        const data = await readDocument(card.label);
        content = { mode: "doc", body: data.body };
      }
      setPanel((prev) =>
        prev?.card.label === card.label ? { card, content, loading: false } : prev,
      );
    } catch {
      setPanel((prev) =>
        prev?.card.label === card.label ? { card, content: null, loading: false } : prev,
      );
    }
  }, []);

  // Inline prose links open the full document (no chunk context).
  const openByPath = useCallback(
    (path: string) => {
      const card: SourceRef = {
        label: path,
        type: path.startsWith("wiki/") ? "article" : "raw",
        full: true,
      };
      void openCard(card);
    },
    [openCard],
  );

  const togglePanel = useCallback(
    (card: SourceRef) => {
      if (panel?.card.label === card.label) {
        setPanel(null);
        return;
      }
      void openCard(card);
    },
    [panel?.card.label, openCard],
  );

  const handleLinkClick = useLinkInterceptor(openByPath);

  const { popover, addChip, startBtw, clearPopover } = session;
  usePopoverDismiss(clearPopover);

  const handleAddChip = useCallback(() => {
    if (!popover) return;
    addChip(popover.text);
  }, [popover, addChip]);

  const handleBtw = useCallback(() => {
    if (!popover) return;
    startBtw(popover);
  }, [popover, startBtw]);

  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem("onboarding-hint-seen") === "true",
  );

  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    localStorage.setItem("onboarding-hint-seen", "true");
  }, []);

  const showHint = !hintDismissed && session.phase === "done" && session.thread.length === 1;

  const canFollowUp = session.phase === "done";

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto" onClick={handleLinkClick}>
        <div id="session-print" className="px-4 md:px-10 pt-7 pb-5 max-w-[740px] mx-auto">
          {session.thread.map((ex, ei) => (
            <div key={ex.id}>
              {ei > 0 && <Separator className="my-8 bg-ink-subtle" />}

              <div className="flex items-center justify-between mb-[18px] gap-3">
                <span className="italic text-[length:var(--text-small)] text-muted-foreground">
                  {`"${ex.query}"`}
                </span>
                {session.sessionId && ex.answer && (
                  <span className="print:hidden">
                    <PromoteButton sessionId={session.sessionId} exchangeId={ex.id} />
                  </span>
                )}
              </div>

              <div className="print:hidden">
                <ThinkingSection
                  blocks={ex.thinking}
                  streaming={false}
                  onCardClick={togglePanel}
                  activeCard={panel?.card.label ?? null}
                />
              </div>

              <AnswerBlock
                text={ex.answer}
                exchangeId={ex.id}
                btws={ex.btws}
                streaming={false}
                onSelection={session.handleSelection}
                onBtwReply={session.replyBtw}
                onBtwDismiss={session.dismissBtw}
              />
            </div>
          ))}

          {(session.phase === "searching" || session.phase === "streaming") && (
            <div>
              {session.thread.length > 0 && <Separator className="my-8 bg-ink-subtle" />}

              <ThinkingSection
                blocks={session.liveThinking}
                streaming={session.phase === "searching"}
                onCardClick={togglePanel}
                activeCard={panel?.card.label ?? null}
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

      {showHint && (
        <div className="shrink-0 px-4 md:px-10 py-3 border-t border-ink-subtle animate-[slide-up_0.28s_ease]">
          <div className="flex items-center justify-between max-w-[740px] mx-auto gap-4">
            <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
              <Badge
                variant="outline"
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted border-gold-dim mr-2"
              >
                tip
              </Badge>
              {"highlight any text in the answer to "}
              <span className="text-warm-dim">follow up</span>
              {" or start a "}
              <span className="text-btw">btw</span>
              {" thread"}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={dismissHint}
              className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:text-warm-faint hover:bg-transparent h-auto px-2 py-1 shrink-0"
            >
              dismiss
            </Button>
          </div>
        </div>
      )}

      {canFollowUp && (
        <FollowUpBar
          chips={session.chips}
          onRemoveChip={session.removeChip}
          onSubmit={onFollowUp}
        />
      )}

      {session.popover && (
        <SelectionPopover info={session.popover} onFollowUp={handleAddChip} onBtw={handleBtw} />
      )}

      {panel && (
        <>
          <div className="fixed inset-0 z-[199]" onClick={() => setPanel(null)} />
          <ArticlePanel
            card={panel.card}
            content={panel.content}
            loading={panel.loading}
            onClose={() => setPanel(null)}
            onFullScreen={() => navigate(`/doc/${panel.card.label}`)}
            onOpenPath={(p) => navigate(`/doc/${p}`)}
          />
        </>
      )}
    </>
  );
}
