import { useMemo, useRef, type ComponentProps } from "react";
import Markdown from "react-markdown";

import type { Article } from "@/api/doc";
import { BtwThread } from "@/components/btw-thread";
import { DocHeader } from "@/components/doc-header";
import { useAnchoredBtws } from "@/hooks/use-anchored-btws";
import { baseMdComponents, remarkPlugins, rehypePlugins } from "@/lib/markdown";
import type { BtwThread as BtwThreadType, SelectionInfo } from "@/lib/types";

// Obsidian-style block ref markers (`^pN`) get baked into raw markdown at
// ingest time. We strip them from the visible prose and rely on the
// sequential <p> counter to reassign them as anchor ids, so footnote URLs
// like `raw/.../file.md#^p12` scroll to the right paragraph.
const BLOCK_REF_RE = /\s*\^p\d+(?=\n|$)/gm;

// Stable, unique source offset the markdown parser attaches to each block.
function offsetOf(node: { position?: { start?: { offset?: number } } } | undefined): number | undefined {
  return node?.position?.start?.offset;
}

interface ArticleViewProps {
  document: Article;
  body: string;
  btws: BtwThreadType[];
  onSelection: (info: SelectionInfo) => void;
  onBtwReply: (btwId: string, text: string) => void;
  onBtwDismiss?: (btwId: string) => void;
  onBtwSpinOff?: (btwId: string) => void;
  documentId: string;
  archived?: boolean;
  supersededBy?: string | null;
  onSupersessorClick?: (slug: string) => void;
}

export function ArticleView({
  document,
  body,
  btws,
  onSelection,
  onBtwReply,
  onBtwDismiss,
  onBtwSpinOff,
  documentId,
  archived = false,
  supersededBy = null,
  onSupersessorClick,
}: ArticleViewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const placement = useAnchoredBtws(rootRef, documentId, btws, body);

  // p() is called sequentially during render; `^pN` ids let footnote URLs scroll
  // to a paragraph. Independent of BTW anchoring, which uses source offsets.
  let paraCount = 0;

  const handleSelect = (e: React.MouseEvent<HTMLElement>, offset: number | undefined) => {
    if (offset == null) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const quote = sel.toString().trim();
    if (quote.length < 5) return;
    const range = sel.getRangeAt(0);
    if (!e.currentTarget.contains(range.commonAncestorContainer)) return;
    e.stopPropagation();
    const rect = range.getBoundingClientRect();
    onSelection({
      blockOffset: offset,
      quote,
      context: e.currentTarget.textContent ?? "",
      x: rect.left + rect.width / 2,
      y: rect.top - 6,
      exchangeId: documentId,
    });
  };

  const anchorProps = (offset: number | undefined) => ({
    "data-block-offset": offset,
    onMouseUp: (e: React.MouseEvent<HTMLElement>) => handleSelect(e, offset),
  });

  const renderThreads = (offset: number | undefined) =>
    offset == null
      ? null
      : btws
          .filter((b) => placement.get(b.id) === offset)
          .map((btw) => (
            <BtwThread
              key={btw.id}
              btw={btw}
              onReply={onBtwReply}
              onDismiss={onBtwDismiss}
              onSpinOff={onBtwSpinOff}
            />
          ));

  const mdComponents: ComponentProps<typeof Markdown>["components"] = {
    ...baseMdComponents,
    h1: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <h1
            {...anchorProps(offset)}
            className="text-[length:var(--text-heading)] font-bold text-foreground mt-8 mb-4 first:mt-0"
          >
            {children}
          </h1>
          {renderThreads(offset)}
        </>
      );
    },
    h2: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <h2
            {...anchorProps(offset)}
            className="text-[length:var(--text-heading)] font-bold text-foreground mt-8 mb-3"
          >
            {children}
          </h2>
          {renderThreads(offset)}
        </>
      );
    },
    h3: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <h3
            {...anchorProps(offset)}
            className="font-mono text-[length:var(--text-caption)] font-medium text-gold mt-6 mb-2 tracking-[0.14em] uppercase"
          >
            {children}
          </h3>
          {renderThreads(offset)}
        </>
      );
    },
    p: ({ node, children }) => {
      const pi = paraCount++;
      const offset = offsetOf(node);
      return (
        <>
          <p
            id={`^p${pi}`}
            {...anchorProps(offset)}
            className="text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 scroll-mt-20 target:bg-gold/10 target:border-l-2 target:border-gold target:pl-3"
          >
            {children}
          </p>
          {renderThreads(offset)}
        </>
      );
    },
    ul: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <ul
            {...anchorProps(offset)}
            className="list-disc list-inside text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 ml-2"
          >
            {children}
          </ul>
          {renderThreads(offset)}
        </>
      );
    },
    ol: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <ol
            {...anchorProps(offset)}
            className="list-decimal list-inside text-[length:var(--text-body)] leading-[1.85] text-warm-dim mb-4 ml-2"
          >
            {children}
          </ol>
          {renderThreads(offset)}
        </>
      );
    },
    li: ({ children, id }) => (
      <li id={id} className="mb-1">
        {children}
      </li>
    ),
    blockquote: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <blockquote
            {...anchorProps(offset)}
            className="border-l-2 border-gold-dim pl-4 text-warm-faint italic my-4"
          >
            {children}
          </blockquote>
          {renderThreads(offset)}
        </>
      );
    },
    code: ({ children }) => (
      <code className="font-mono text-[length:var(--text-small)] bg-code-bg px-1.5 py-0.5 rounded-sm text-gold">
        {children}
      </code>
    ),
  };

  // Strip `^pN` block-ref markers from visible prose — they're metadata
  // for deep-link fragments, not content.
  const displayBody = useMemo(() => body.replace(BLOCK_REF_RE, ""), [body]);

  // Threads whose anchored block is gone — render below so they're never lost.
  const orphans = btws.filter((b) => (placement.get(b.id) ?? -1) < 0);

  return (
    <article
      ref={rootRef}
      className="max-w-[740px] mx-auto px-4 md:px-10 pt-6 md:pt-10 pb-20 select-text"
    >
      <DocHeader
        document={document}
        archived={archived}
        supersededBy={supersededBy}
        onSupersessorClick={onSupersessorClick}
      />
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>
        {displayBody}
      </Markdown>
      {orphans.map((btw) => (
        <BtwThread
          key={btw.id}
          btw={btw}
          onReply={onBtwReply}
          onDismiss={onBtwDismiss}
          onSpinOff={onBtwSpinOff}
        />
      ))}
    </article>
  );
}
