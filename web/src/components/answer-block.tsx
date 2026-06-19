import { memo, useRef, type ComponentProps } from "react";
import Markdown from "react-markdown";

import { useAnchoredBtws } from "@/hooks/use-anchored-btws";
import { baseMdComponents, remarkPlugins, rehypePlugins } from "@/lib/markdown";
import type { BtwThread as BtwThreadType, SelectionInfo } from "@/lib/types";
import { BtwThread } from "./btw-thread";

interface AnswerBlockProps {
  text: string;
  exchangeId: string;
  btws: BtwThreadType[];
  streaming: boolean;
  onSelection: (info: SelectionInfo) => void;
  onBtwReply: (btwId: string, text: string) => void;
  onBtwDismiss?: (btwId: string) => void;
}

// The source offset the markdown parser attaches to each block node — a stable,
// unique, render-independent identity for that block.
function offsetOf(node: { position?: { start?: { offset?: number } } } | undefined): number | undefined {
  return node?.position?.start?.offset;
}

// Non-anchorable leaves (inline marks + inline code).
const leafComponents: ComponentProps<typeof Markdown>["components"] = {
  ...baseMdComponents,
  code: ({ children }) => (
    <code className="font-mono text-[length:var(--text-small)] bg-code-bg px-1.5 py-0.5 rounded-sm text-gold">
      {children}
    </code>
  ),
};

export const AnswerBlock = memo(function AnswerBlock({
  text,
  exchangeId,
  btws,
  streaming,
  onSelection,
  onBtwReply,
  onBtwDismiss,
}: AnswerBlockProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const placement = useAnchoredBtws(rootRef, exchangeId, btws, text);

  const handleSelect = (e: React.MouseEvent<HTMLElement>, offset: number | undefined) => {
    if (streaming || offset == null) return;
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
      exchangeId,
    });
  };

  const renderThreads = (offset: number | undefined) =>
    offset == null
      ? null
      : btws
          .filter((b) => placement.get(b.id) === offset)
          .map((btw) => (
            <BtwThread key={btw.id} btw={btw} onReply={onBtwReply} onDismiss={onBtwDismiss} />
          ));

  // Tags the block with its source offset and a selection handler.
  const anchorProps = (offset: number | undefined) => ({
    "data-block-offset": offset,
    onMouseUp: (e: React.MouseEvent<HTMLElement>) => handleSelect(e, offset),
  });

  const components: ComponentProps<typeof Markdown>["components"] = {
    ...leafComponents,
    h2: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <h2
            {...anchorProps(offset)}
            className="text-[length:var(--text-heading)] font-bold text-foreground mt-[26px] mb-[11px] -tracking-[0.01em] first:mt-0"
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
            className="font-mono text-[length:var(--text-chrome)] font-medium text-gold mt-[18px] mb-2 tracking-[0.14em] uppercase"
          >
            {children}
          </h3>
          {renderThreads(offset)}
        </>
      );
    },
    p: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <p
            {...anchorProps(offset)}
            className="text-[length:var(--text-body)] leading-[1.82] text-warm-dim mb-0.5"
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
            className="list-disc list-inside text-[length:var(--text-body)] leading-[1.82] text-warm-dim mb-2 ml-2"
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
            className="list-decimal list-inside text-[length:var(--text-body)] leading-[1.82] text-warm-dim mb-2 ml-2"
          >
            {children}
          </ol>
          {renderThreads(offset)}
        </>
      );
    },
    blockquote: ({ node, children }) => {
      const offset = offsetOf(node);
      return (
        <>
          <blockquote
            {...anchorProps(offset)}
            className="border-l-2 border-gold-dim pl-3.5 text-warm-faint italic my-3"
          >
            {children}
          </blockquote>
          {renderThreads(offset)}
        </>
      );
    },
  };

  // Threads whose anchored block is gone — render below so they're never lost.
  const orphans = btws.filter((b) => (placement.get(b.id) ?? -1) < 0);

  return (
    <div ref={rootRef} className="select-text">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </Markdown>
      {streaming && (
        <span className="inline-block w-0.5 h-[13px] bg-gold animate-[blink_1s_step-end_infinite] align-middle ml-px" />
      )}
      {orphans.map((btw) => (
        <BtwThread key={btw.id} btw={btw} onReply={onBtwReply} onDismiss={onBtwDismiss} />
      ))}
    </div>
  );
});
