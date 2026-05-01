import { useCallback, useState } from "react";

import { useViewNavigate } from "@/hooks/use-view-navigate";

import { readDocument } from "@/api/doc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AnswerBlock } from "@/components/answer-block";
import { ArticlePanel } from "@/components/article-panel";
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
    path: string;
    title: string | null;
    kind: "raw" | "wiki" | null;
    body: string | null;
    loading: boolean;
  } | null>(null);

  const openPanel = useCallback(async (path: string) => {
    setPanel({ path, title: null, kind: null, body: null, loading: true });
    try {
      const data = await readDocument(path);
      setPanel((prev) =>
        prev?.path === path
          ? {
              path,
              title: data.document.metadata.title || null,
              kind: data.document.doc_kind,
              body: data.body,
              loading: false,
            }
          : prev,
      );
    } catch {
      setPanel((prev) =>
        prev?.path === path
          ? { path, title: null, kind: null, body: null, loading: false }
          : prev,
      );
    }
  }, []);

  const togglePanel = useCallback(
    async (path: string) => {
      if (panel?.path === path) {
        setPanel(null);
        return;
      }
      openPanel(path);
    },
    [panel?.path, openPanel],
  );

  const handleLinkClick = useLinkInterceptor(openPanel);

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
        <div className="px-4 md:px-10 pt-7 pb-5 max-w-[740px] mx-auto">
          {session.thread.map((ex, ei) => (
            <div key={ex.id}>
              {ei > 0 && <Separator className="my-8 bg-ink-subtle" />}

              <div className="flex items-center justify-between mb-[18px] gap-3">
                <span className="italic text-[length:var(--text-small)] text-muted-foreground">
                  {`"${ex.query}"`}
                </span>
                {session.sessionId && ex.answer && (
                  <PromoteButton
                    sessionId={session.sessionId}
                    exchangeId={ex.id}
                  />
                )}
              </div>

              <ThinkingSection
                blocks={ex.thinking}
                streaming={false}
                onCardClick={togglePanel}
                activeCard={panel?.path ?? null}
              />

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
                activeCard={panel?.path ?? null}
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
            path={panel.path}
            title={panel.title}
            kind={panel.kind}
            body={panel.body}
            loading={panel.loading}
            onClose={() => setPanel(null)}
            onFullScreen={() => navigate(`/doc/${panel.path}`)}
          />
        </>
      )}
    </>
  );
}
