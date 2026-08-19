<script lang="ts">
  import type { Article, DocumentScope } from "$lib/api/doc";
  import AnswerBlock from "$lib/components/answer-block.svelte";
  import DocHeader from "$lib/components/doc-header.svelte";
  import type {
    ReferencePromotionAction,
    SelectionInfo,
    ThreadLike,
  } from "$lib/types";

  let {
    document,
    scope,
    promotionAction = null,
    body,
    archived = false,
    supersededBy = null,
    onSupersessorClick,
    onLinkClick,
    panelDocked = false,
    threads = [],
    expandedThreads = null,
    onToggleThread,
    onOpenThread,
    onThreadJump,
    onThreadOpen,
    documentId,
    onSelection,
    onBtwReply,
    onBtwDismiss,
  }: {
    document: Article;
    scope: DocumentScope;
    promotionAction?: ReferencePromotionAction | null;
    body: string;
    archived?: boolean;
    supersededBy?: string | null;
    onSupersessorClick?: (slug: string) => void;
    onLinkClick?: (event: MouseEvent) => void;
    panelDocked?: boolean;
    threads?: ThreadLike[];
    expandedThreads?: Set<string> | null;
    onToggleThread?: (threadId: string) => void;
    onOpenThread?: (threadId: string) => void;
    onThreadJump?: (threadId: string) => void;
    onThreadOpen?: (threadId: string) => void;
    documentId: string;
    onSelection: (info: SelectionInfo) => void;
    onBtwReply: (btwId: string, text: string) => void;
    onBtwDismiss?: (btwId: string) => void;
  } = $props();
</script>

<article class="mx-auto max-w-[740px] px-4 pt-6 pb-20 select-text md:px-10">
  <DocHeader
    {document}
    {scope}
    {promotionAction}
    {archived}
    {supersededBy}
    {onSupersessorClick}
    {threads}
    {onThreadJump}
    {onThreadOpen}
  />
  <AnswerBlock
    text={body}
    exchangeId={documentId}
    btws={threads}
    streaming={false}
    variant="article"
    stripBlockRefs
    resolveBlockRefs
    marginFootnotes
    {panelDocked}
    {onLinkClick}
    {onSelection}
    {onBtwReply}
    {onBtwDismiss}
    {expandedThreads}
    {onToggleThread}
    onBtwOpenSession={onOpenThread}
  />
</article>
