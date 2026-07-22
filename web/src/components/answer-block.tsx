import {
  createContext,
  memo,
  useContext,
  useMemo,
  useRef,
  type ComponentProps,
  type RefObject,
} from "react";
import Markdown from "react-markdown";

import { useAnchoredBtws } from "@/hooks/use-anchored-btws";
import { baseMdComponents, remarkPlugins, rehypePlugins } from "@/lib/markdown";
import { splitStreamingMarkdown } from "@/lib/streaming-markdown";
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

// Everything the markdown components read at render time. Kept in a ref so the
// component functions themselves stay referentially stable across renders —
// inline closures would change identity every render, making React remount the
// whole rendered tree (and every mounted BtwThread with it) on each streaming
// token.
interface BlockState {
  exchangeId: string;
  streaming: boolean;
  onSelection: (info: SelectionInfo) => void;
}

interface BtwRenderState {
  btws: BtwThreadType[];
  placement: Map<string, number>;
  onReply: (btwId: string, text: string) => void;
  onDismiss?: (btwId: string) => void;
}

const BtwRenderContext = createContext<BtwRenderState>({
  btws: [],
  placement: new Map(),
  onReply: () => undefined,
});

function AnchoredThreads({ offset }: { offset: number | undefined }) {
  const state = useContext(BtwRenderContext);
  if (offset == null) return null;

  return state.btws
    .filter((btw) => state.placement.get(btw.id) === offset)
    .map((btw) => (
      <BtwThread key={btw.id} btw={btw} onReply={state.onReply} onDismiss={state.onDismiss} />
    ));
}

const MemoMarkdown = memo(function MemoMarkdown({
  text,
  components,
}: {
  text: string;
  components: ComponentProps<typeof Markdown>["components"];
}) {
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {text}
    </Markdown>
  );
});

// The source offset the markdown parser attaches to each block node — a stable,
// unique, render-independent identity for that block.
function offsetOf(
  node: { position?: { start?: { offset?: number } } } | undefined,
): number | undefined {
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

function buildComponents(
  stateRef: RefObject<BlockState>,
): ComponentProps<typeof Markdown>["components"] {
  const handleSelect = (e: React.MouseEvent<HTMLElement>, offset: number | undefined) => {
    const state = stateRef.current;
    if (state.streaming || offset == null) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const quote = sel.toString().trim();
    if (quote.length < 5) return;
    const range = sel.getRangeAt(0);
    if (!e.currentTarget.contains(range.commonAncestorContainer)) return;
    e.stopPropagation();
    const rect = range.getBoundingClientRect();
    state.onSelection({
      blockOffset: offset,
      quote,
      context: e.currentTarget.textContent ?? "",
      x: rect.left + rect.width / 2,
      y: rect.top - 6,
      exchangeId: state.exchangeId,
    });
  };

  // Tags the block with its source offset and a selection handler.
  const anchorProps = (offset: number | undefined) => ({
    "data-block-offset": offset,
    onMouseUp: (e: React.MouseEvent<HTMLElement>) => handleSelect(e, offset),
  });

  return {
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
          <AnchoredThreads offset={offset} />
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
          <AnchoredThreads offset={offset} />
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
          <AnchoredThreads offset={offset} />
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
          <AnchoredThreads offset={offset} />
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
          <AnchoredThreads offset={offset} />
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
          <AnchoredThreads offset={offset} />
        </>
      );
    },
  };
}

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

  const stateRef = useRef<BlockState>(null!);
  stateRef.current = {
    exchangeId,
    streaming,
    onSelection,
  };
  const components = useMemo(() => buildComponents(stateRef), []);
  const btwRenderState = useMemo(
    () => ({ btws, placement, onReply: onBtwReply, onDismiss: onBtwDismiss }),
    [btws, placement, onBtwReply, onBtwDismiss],
  );
  const split = useMemo(() => (streaming ? splitStreamingMarkdown(text) : null), [text, streaming]);

  // Threads whose anchored block is gone — render below so they're never lost.
  const orphans = btws.filter((b) => (placement.get(b.id) ?? -1) < 0);

  return (
    <div ref={rootRef} className="select-text">
      <BtwRenderContext.Provider value={btwRenderState}>
        {streaming && split ? (
          <>
            {split.stable ? <MemoMarkdown text={split.stable} components={components} /> : null}
            <Markdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={components}
            >
              {split.tail}
            </Markdown>
          </>
        ) : (
          <MemoMarkdown text={text} components={components} />
        )}
      </BtwRenderContext.Provider>
      {streaming && (
        <span className="inline-block w-0.5 h-[13px] bg-gold animate-[blink_1s_step-end_infinite] align-middle ml-px" />
      )}
      {orphans.map((btw) => (
        <BtwThread key={btw.id} btw={btw} onReply={onBtwReply} onDismiss={onBtwDismiss} />
      ))}
    </div>
  );
});
