import { useMemo, useRef, type ComponentProps } from "react";
import Markdown from "react-markdown";

import { BtwThread } from "@/components/btw-thread";
import { baseMdComponents, remarkPlugins } from "@/lib/markdown";
import type { BtwThread as BtwThreadType, SelectionInfo } from "@/lib/types";

// Obsidian-style block ref markers (`^pN`) get baked into raw markdown at
// ingest time. We strip them from the visible prose and rely on the
// sequential <p> counter to reassign them as anchor ids, so footnote URLs
// like `raw/.../file.md#^p12` scroll to the right paragraph.
const BLOCK_REF_RE = /\s*\^p\d+(?=\n|$)/gm;

interface ArticleViewProps {
  title: string;
  content: string;
  btws: BtwThreadType[];
  onSelection: (info: SelectionInfo) => void;
  onBtwReply: (btwId: string, text: string) => void;
  onBtwDismiss?: (btwId: string) => void;
  documentId: string;
  archived?: boolean;
  supersededBy?: string | null;
  onSupersessorClick?: (slug: string) => void;
}

export function ArticleView({
  title,
  content,
  btws,
  onSelection,
  onBtwReply,
  onBtwDismiss,
  documentId,
  archived = false,
  supersededBy = null,
  onSupersessorClick,
}: ArticleViewProps) {
  // Refs for stable callbacks — avoids recreating mdComponents on every render
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const onBtwReplyRef = useRef(onBtwReply);
  onBtwReplyRef.current = onBtwReply;
  const onBtwDismissRef = useRef(onBtwDismiss);
  onBtwDismissRef.current = onBtwDismiss;
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;
  const btwsRef = useRef(btws);
  btwsRef.current = btws;

  const paraCountRef = useRef(0);

  const mdComponents = useMemo<ComponentProps<typeof Markdown>["components"]>(
    () => ({
      ...baseMdComponents,
      h1: ({ children }) => (
        <h1 className="text-[length:var(--text-heading)] font-bold text-foreground mt-8 mb-4 first:mt-0">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="text-[length:var(--text-heading)] font-bold text-foreground mt-8 mb-3">
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="font-mono text-[length:var(--text-caption)] font-medium text-gold mt-6 mb-2 tracking-[0.14em] uppercase">
          {children}
        </h3>
      ),
      p: ({ children }) => {
        const pi = paraCountRef.current++;
        const blockBtws = btwsRef.current.filter((b) => b.paragraphIndex === pi);
        return (
          <>
            <p
              id={`^p${pi}`}
              className="text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 scroll-mt-20 target:bg-gold/10 target:border-l-2 target:border-gold target:pl-3"
              onMouseUp={(e) => {
                e.stopPropagation();
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed || sel.toString().trim().length < 5) return;
                const rect = sel.getRangeAt(0).getBoundingClientRect();
                const paraText = e.currentTarget.textContent ?? "";
                onSelectionRef.current({
                  text: sel.toString().trim(),
                  x: rect.left + rect.width / 2,
                  y: rect.top - 6,
                  paragraphIndex: pi,
                  exchangeId: documentIdRef.current,
                  paragraph: paraText,
                });
              }}
            >
              {children}
            </p>
            {blockBtws.map((btw) => (
              <BtwThread
                key={btw.id}
                btw={btw}
                onReply={(id, text) => onBtwReplyRef.current(id, text)}
                onDismiss={
                  onBtwDismissRef.current ? (id) => onBtwDismissRef.current!(id) : undefined
                }
              />
            ))}
          </>
        );
      },
      ul: ({ children }) => (
        <ul className="list-disc list-inside text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 ml-2">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="list-decimal list-inside text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 ml-2">
          {children}
        </ol>
      ),
      li: ({ children, id }) => <li id={id} className="mb-1">{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-gold-dim pl-4 text-warm-faint italic my-4">
          {children}
        </blockquote>
      ),
      code: ({ children }) => (
        <code className="font-mono text-[length:var(--text-small)] bg-code-bg px-1.5 py-0.5 rounded-sm text-gold">
          {children}
        </code>
      ),
    }),
    [],
  );

  // Markdown calls p() sequentially during render; reset so indices match BTW paragraphIndex
  paraCountRef.current = 0;

  // Strip `^pN` block-ref markers from visible prose — they're metadata
  // for deep-link fragments, not content.
  const displayContent = useMemo(
    () => content.replace(BLOCK_REF_RE, ""),
    [content],
  );

  return (
    <article className="max-w-[740px] mx-auto px-4 md:px-10 pt-6 md:pt-10 pb-20 select-text">
      {archived && (
        <div className="mb-8 px-4 py-3 rounded-sm border border-gold-dim bg-ink-raised">
          <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted uppercase mb-1">
            archived article
          </p>
          <p className="font-serif text-[length:var(--text-body)] text-warm-dim">
            {supersededBy ? (
              <>
                This concept has been retired. See{" "}
                <button
                  type="button"
                  onClick={() => onSupersessorClick?.(supersededBy)}
                  className="text-gold hover:text-gold-bright underline underline-offset-2"
                >
                  {supersededBy}
                </button>{" "}
                for the current version.
              </>
            ) : (
              <>This concept has been retired. No successor has been identified.</>
            )}
          </p>
        </div>
      )}
      <h1 className="text-[length:var(--text-title)] font-bold text-foreground mb-8">{title}</h1>
      <Markdown remarkPlugins={remarkPlugins} components={mdComponents}>
        {displayContent}
      </Markdown>
    </article>
  );
}
