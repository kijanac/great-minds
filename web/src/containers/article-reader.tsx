import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { ArticleChrome } from "@/components/article-chrome";
import { ArticleView } from "@/components/article-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectionPopover } from "@/components/selection-popover";
import { useDocument } from "@/hooks/use-document";
import { useBtw } from "@/hooks/use-btw";
import { useLinkInterceptor } from "@/hooks/use-link-interceptor";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { docDisplayName, slugToTitle } from "@/lib/utils";
import type { SelectionInfo } from "@/lib/types";

interface ArticleReaderProps {
  path: string;
}

export function ArticleReader({ path }: ArticleReaderProps) {
  const navigate = useNavigate();
  const handleLinkClick = useLinkInterceptor();
  const { content, loading } = useDocument(path);
  const { btws, startBtw, replyBtw, dismissEmpty, cleanup } = useBtw(path);
  const [popover, setPopover] = useState<SelectionInfo | null>(null);
  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem("onboarding-hint-seen") === "true",
  );

  usePopoverDismiss(() => setPopover(null));

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

  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    localStorage.setItem("onboarding-hint-seen", "true");
  }, []);
  const showHint = !hintDismissed && !loading && !!content;

  const displayName = docDisplayName(path);
  const title = slugToTitle(displayName);

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
      {loading && (
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-6 md:pt-10">
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
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-6 md:pt-10">
          <p className="text-[length:var(--text-body)] text-warm-faint">Document not found.</p>
        </div>
      )}

      {popover && <SelectionPopover info={popover} onBtw={handleBtw} />}
    </ArticleChrome>
  );
}
