<script lang="ts">
  import type { Article, DocumentScope } from "$lib/api/doc";
  import AnswerBlock from "$lib/components/answer-block.svelte";
  import DocHeader from "$lib/components/doc-header.svelte";
  import type {
    BtwThread,
    ReferencePromotionAction,
    SelectionInfo,
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
    btws = [],
    documentId,
    onSelection,
    onBtwReply,
    onBtwDismiss,
    onBtwSpinOff,
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
    btws?: BtwThread[];
    documentId: string;
    onSelection: (info: SelectionInfo) => void;
    onBtwReply: (btwId: string, text: string) => void;
    onBtwDismiss?: (btwId: string) => void;
    onBtwSpinOff?: (btwId: string) => void;
  } = $props();
</script>

<article
  class="mx-auto max-w-[740px] px-4 pt-6 pb-20 select-text md:px-10 md:pt-10"
>
  <DocHeader
    {document}
    {scope}
    {promotionAction}
    {archived}
    {supersededBy}
    {onSupersessorClick}
  />
  <AnswerBlock
    text={body}
    exchangeId={documentId}
    {btws}
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
    {onBtwSpinOff}
  />
</article>
