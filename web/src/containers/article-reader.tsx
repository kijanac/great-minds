import { useCallback, useEffect, useState } from "react";

import type { Document } from "@/api/doc";
import { postUserSuggestion } from "@/api/ingest";
import { ArticleChrome } from "@/components/article-chrome";
import { ArticleView } from "@/components/article-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectionPopover } from "@/components/selection-popover";
import { SuggestionForm, type SuggestionPayload } from "@/components/suggestion-form";
import { useBtw } from "@/hooks/use-btw";
import { useLinkInterceptor } from "@/hooks/use-link-interceptor";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import { docDisplayName } from "@/lib/utils";
import type { SelectionInfo } from "@/lib/types";

interface ArticleReaderProps {
  path: string;
  document: Document | null;
  body: string | null;
  archived?: boolean;
  supersededBy?: string | null;
}

export function ArticleReader({
  path,
  document,
  body,
  archived = false,
  supersededBy = null,
}: ArticleReaderProps) {
  const navigate = useViewNavigate();
  const handleLinkClick = useLinkInterceptor();
  const { btws, startBtw, replyBtw, dismissEmpty, cleanup } = useBtw(path);
  const [popover, setPopover] = useState<SelectionInfo | null>(null);
  const [suggestionTarget, setSuggestionTarget] = useState<SelectionInfo | null>(
    null,
  );
  const [suggestionSubmitted, setSuggestionSubmitted] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem("onboarding-hint-seen") === "true",
  );

  usePopoverDismiss(() => setPopover(null));

  const wikiSlug =
    path.startsWith("wiki/") && path.endsWith(".md")
      ? path.slice("wiki/".length, -".md".length)
      : null;

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [path, cleanup]);

  const handleBtw = useCallback(() => {
    if (!popover) return;
    startBtw(popover);
    setPopover(null);
    window.getSelection()?.removeAllRanges();
  }, [popover, startBtw]);

  const handleSuggest = useCallback(() => {
    if (!popover) return;
    setSuggestionTarget(popover);
    setPopover(null);
    window.getSelection()?.removeAllRanges();
  }, [popover]);

  const handleSuggestionSubmit = useCallback(
    async (payload: SuggestionPayload) => {
      if (!wikiSlug) return;
      await postUserSuggestion({
        body: payload.body,
        intent: payload.intent,
        anchoredTo: wikiSlug,
        anchoredSection: suggestionTarget?.text ?? "",
      });
      setSuggestionSubmitted(true);
      window.setTimeout(() => setSuggestionSubmitted(false), 3000);
    },
    [wikiSlug, suggestionTarget],
  );

  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    localStorage.setItem("onboarding-hint-seen", "true");
  }, []);
  const showHint = !hintDismissed && body !== null;

  const displayName = docDisplayName(path);

  const hint = showHint ? (
    <div className="shrink-0 px-4 md:px-10 py-3 border-t border-ink-subtle animate-[slide-up_0.28s_ease]">
      <div className="flex items-center justify-between max-w-[740px] mx-auto gap-4">
        <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
          <Badge
            variant="outline"
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted border-gold-dim mr-2"
          >
            tip
          </Badge>
          {"highlight any text to start a "}
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
  ) : null;

  return (
    <ArticleChrome
      label={displayName}
      onHome={() => navigate("/")}
      onQuery={(q) => navigate(`/?q=${encodeURIComponent(q)}&origin=${encodeURIComponent(path)}`)}
      onContentClick={handleLinkClick}
      footer={hint}
    >
      {document && body !== null ? (
        <ArticleView
          document={document}
          body={body}
          btws={btws}
          onSelection={setPopover}
          onBtwReply={replyBtw}
          onBtwDismiss={dismissEmpty}
          documentId={path}
          archived={archived}
          supersededBy={supersededBy}
          onSupersessorClick={(slug) => navigate(`/doc/wiki/${slug}.md`)}
        />
      ) : (
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-6 md:pt-10">
          <p className="text-[length:var(--text-body)] text-warm-faint">Document not found.</p>
        </div>
      )}

      {popover && (
        <SelectionPopover
          info={popover}
          onBtw={handleBtw}
          onSuggest={wikiSlug ? handleSuggest : undefined}
        />
      )}

      {wikiSlug && suggestionTarget && (
        <SuggestionForm
          open={suggestionTarget !== null}
          onOpenChange={(open) => {
            if (!open) setSuggestionTarget(null);
          }}
          anchoredTo={wikiSlug}
          anchoredSection={suggestionTarget.text}
          onSubmit={handleSuggestionSubmit}
        />
      )}

      {suggestionSubmitted && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[400] bg-popover border border-gold-dim rounded-sm px-4 py-2 shadow-lg animate-[pop-in_0.14s_ease_forwards]">
          <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted">
            suggestion submitted · will land on the next compile
          </p>
        </div>
      )}
    </ArticleChrome>
  );
}
