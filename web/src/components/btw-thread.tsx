import { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { ChevronDown, ChevronRight, Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ArticleBadge, FilterBadge, SearchBadge } from "@/components/thinking-section";
import { baseMdComponents, remarkPlugins, rehypePlugins } from "@/lib/markdown";
import type { BtwThread as BtwThreadType } from "@/lib/types";

interface BtwThreadProps {
  btw: BtwThreadType;
  onReply: (btwId: string, text: string) => void;
  onDismiss?: (btwId: string) => void;
  // When provided, this BTW is ephemeral and offers a "save as session" action.
  // Session-attached BTWs (which auto-persist) leave this undefined.
  onSpinOff?: (btwId: string) => void;
}

const btwMdComponents = {
  ...baseMdComponents,
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-inside mb-1 ml-2">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-inside mb-1 ml-2">{children}</ol>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-gold-dim pl-2.5 text-warm-faint italic my-1.5">
      {children}
    </blockquote>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="font-mono text-[length:var(--text-chrome)] bg-code-bg px-1 py-0.5 rounded-sm text-gold">
      {children}
    </code>
  ),
};

export const BtwThread = memo(function BtwThread({
  btw,
  onReply,
  onDismiss,
  onSpinOff,
}: BtwThreadProps) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const quote = btw.anchor.quote;
  const shortAnchor = quote.length > 58 ? quote.slice(0, 58) + "..." : quote;
  const isStreaming = btw.exchanges.some((e) => e.streaming);

  // Auto-focus: on mount of a brand-new (empty) BTW, and when this thread's
  // streaming finishes — but never steal focus from something the user is
  // typing in, and never scroll-jump the page to reach the input.
  const wasStreaming = useRef(isStreaming);
  const isFirstRender = useRef(true);
  useEffect(() => {
    const idleFocus = () => {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        inputRef.current?.focus({ preventScroll: true });
      }
    };
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (btw.exchanges.length === 0) {
        inputRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (wasStreaming.current && !isStreaming) {
      idleFocus();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, btw.exchanges.length]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-[10px] mb-3 border-l-2 border-gold-dim pl-3.5"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="flex items-baseline gap-2 w-full pb-[7px] text-left h-auto p-0 rounded-none hover:bg-transparent justify-start"
          />
        }
      >
        <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold uppercase shrink-0">
          BTW
        </span>
        <span className="italic text-[length:var(--text-caption)] text-muted-foreground flex-1 text-left">
          {`"${shortAnchor}"`}
        </span>
        <span className="font-mono text-[length:var(--text-chrome)] text-interactive-dim shrink-0">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {btw.exchanges.map((ex) => {
          const sources = ex.thinking.flatMap((block) => block.sources);
          return (
            <div key={ex.id}>
              <div className="text-[length:var(--text-small)] leading-[1.72] mb-[9px] text-warm-ghost italic">
                <span className="font-mono not-italic text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim mr-0.5">
                  you ·{" "}
                </span>
                {ex.query}
              </div>
              {sources.length > 0 && (
                <div className="flex flex-wrap gap-[5px] mb-[9px]">
                  {sources.map((s, si) => {
                    if (s.type === "search") return <SearchBadge key={si} source={s} />;
                    if (s.type === "query") return <FilterBadge key={si} summary={s.label} />;
                    return (
                      <ArticleBadge
                        key={si}
                        label={s.label}
                        title={s.title}
                        thinking={s.thinking ?? undefined}
                        active={false}
                        icon={
                          s.type === "links" ? (
                            <Waypoints size={9} className="mr-1.5 opacity-60" />
                          ) : undefined
                        }
                      />
                    );
                  })}
                </div>
              )}
              {ex.streaming && !ex.answer ? (
                <div className="text-[length:var(--text-small)] leading-[1.72] mb-[9px] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
                  {sources.length > 0 ? "reading..." : "thinking..."}
                </div>
              ) : (
                <div className="text-[length:var(--text-small)] leading-[1.72] mb-[9px] text-warm-faint">
                  <Markdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={rehypePlugins}
                    components={btwMdComponents}
                  >
                    {ex.answer}
                  </Markdown>
                  {ex.streaming && (
                    <span className="inline-block w-px h-2.5 bg-gold-muted animate-[blink_1s_step-end_infinite] align-middle ml-px" />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {onSpinOff && btw.exchanges.length > 0 && !isStreaming && (
          <div className="text-[length:var(--text-chrome)] tracking-[0.06em] text-interactive-dim italic mb-[6px]">
            ephemeral ·{" "}
            <button
              type="button"
              onClick={() => onSpinOff(btw.id)}
              className="not-italic font-mono tracking-[0.1em] uppercase text-gold hover:text-foreground transition-colors"
            >
              save as session
            </button>
          </div>
        )}

        {!isStreaming && (
          <div className="mt-[5px]" onMouseDown={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              className="bg-transparent border-0 border-b border-b-gold-dim outline-none text-warm-ghost font-serif italic text-[length:var(--text-caption)] py-[3px] w-full caret-gold placeholder:text-interactive-dim focus:border-b-gold transition-colors"
              placeholder="continue..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onBlur={() => {
                if (btw.exchanges.length === 0 && !input.trim() && onDismiss) {
                  onDismiss(btw.id);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim()) {
                  onReply(btw.id, input.trim());
                  setInput("");
                }
              }}
            />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});
