<script lang="ts">
  import type { Article, DocumentScope, LinkItem } from "$lib/api/doc";
  import AnswerBlock from "$lib/components/answer-block.svelte";
  import DocHeader from "$lib/components/doc-header.svelte";
  import { Button } from "$lib/components/ui/button";
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
    related = [],
    onRelatedClick,
    onLinkClick,
    panelDocked = false,
    threads = [],
    jumpableThreads = null,
    expandedThreads = null,
    onToggleThread,
    onOpenSession,
    onThreadJump,
    documentId,
    onSelection,
    onBtwReply,
    onBtwRetry,
    onBtwDismiss,
  }: {
    document: Article;
    scope: DocumentScope;
    promotionAction?: ReferencePromotionAction | null;
    body: string;
    archived?: boolean;
    supersededBy?: string | null;
    onSupersessorClick?: (slug: string) => void;
    related?: readonly LinkItem[];
    onRelatedClick?: (filePath: string) => void;
    onLinkClick?: (event: MouseEvent) => void;
    panelDocked?: boolean;
    threads?: ThreadLike[];
    jumpableThreads?: Set<string> | null;
    expandedThreads?: Set<string> | null;
    onToggleThread?: (threadId: string) => void;
    onOpenSession?: (threadId: string) => void;
    onThreadJump?: (threadId: string) => void;
    documentId: string;
    onSelection: (info: SelectionInfo) => void;
    onBtwReply: (btwId: string, text: string) => void;
    onBtwRetry?: (btwId: string, turnId: string) => void;
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
    {jumpableThreads}
    {onThreadJump}
    onThreadOpen={onOpenSession}
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
    {onBtwRetry}
    {onBtwDismiss}
    {expandedThreads}
    {onToggleThread}
    onBtwOpenSession={onOpenSession}
  />
  {#if !archived && related.length > 0}
    <footer class="mt-14 border-t border-ink-subtle pt-6">
      <div
        class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim uppercase"
      >
        related
      </div>
      <ul class="space-y-3">
        {#each related as item (item.file_path)}
          <li>
            <Button
              variant="ghost"
              onclick={() => onRelatedClick?.(item.file_path)}
              class="flex h-auto w-full flex-col items-start gap-0.5 px-0 py-0 text-left whitespace-normal hover:bg-transparent"
            >
              <span
                class="text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-gold hover:text-gold"
              >
                {item.title}
              </span>
              {#if item.precis}
                <span class="text-[length:var(--text-small)] text-warm-ghost">
                  {item.precis}
                </span>
              {/if}
            </Button>
          </li>
        {/each}
      </ul>
    </footer>
  {/if}
</article>
