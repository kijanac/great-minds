<script lang="ts">
  import Maximize2 from "@lucide/svelte/icons/maximize-2";
  import X from "@lucide/svelte/icons/x";

  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import MarkdownView from "$lib/components/markdown-view.svelte";
  import type { PanelContent } from "$lib/panel-content";
  import type { SourceRef } from "$lib/types";
  import { displayTitle } from "$lib/utils";

  let {
    card,
    content,
    loading,
    context = "agent",
    onClose,
    onFullScreen,
    onOpenPath,
  }: {
    card: SourceRef;
    content: PanelContent | null;
    loading: boolean;
    // "agent" = opened from a session's source cards (the agent's context);
    // "citation" = opened from a citation in an article body.
    context?: "agent" | "citation";
    onClose: () => void;
    onFullScreen: () => void;
    onOpenPath: (path: string) => void;
  } = $props();

  // Citation-opened cards carry no wire title; the chunk heading is the
  // document's own heading and reads far better than a hashed path.
  const headingTitle = $derived(
    displayTitle(
      card.label,
      card.title ??
        (content?.mode === "chunks"
          ? (content.chunks[0]?.heading ?? null)
          : null),
    ),
  );
  const subtitle = $derived.by(() => {
    if (card.type === "links") return "connections the agent saw";
    if (content?.mode === "chunks") {
      const ranges = (card.ranges ?? [])
        .map((range) =>
          range.start === range.end
            ? `¶${range.start}`
            : `¶${range.start}–${range.end}`,
        )
        .join(", ");
      const label =
        context === "citation" ? "cited passage" : "what the agent read";
      return ranges ? `${ranges} · ${label}` : label;
    }
    const kind = card.label.startsWith("wiki/") ? "wiki article" : "raw source";
    return `${kind} · full document`;
  });
</script>

<div class="flex h-full flex-col">
  <div class="shrink-0 border-b border-ink-subtle px-5 pt-5 pb-3.5">
    <div class="mb-[9px] flex items-start justify-between gap-2">
      <span
        class="min-w-0 break-words text-[length:var(--text-body)] font-bold text-foreground"
      >
        {headingTitle}
      </span>
      <div class="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={onFullScreen}
          class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-gold"
          title="Open full screen"
          aria-label="open full screen"
        >
          <Maximize2 size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={onClose}
          class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-warm-faint"
          aria-label="close article panel"
        >
          <X size={14} />
        </Button>
      </div>
    </div>
    <span
      title={card.label}
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim uppercase"
    >
      {subtitle}
    </span>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="px-5 py-[18px]">
      {#if loading}
        <div class="space-y-3">
          <Skeleton class="h-4 w-full bg-ink-raised" />
          <Skeleton class="h-4 w-11/12 bg-ink-raised" />
          <Skeleton class="h-4 w-4/5 bg-ink-raised" />
          <Skeleton class="h-4 w-2/3 bg-ink-raised" />
        </div>
      {:else if content?.mode === "doc"}
        <MarkdownView source={content.body} variant="panel" stripBlockRefs />
      {:else if content?.mode === "chunks"}
        <div class="space-y-5">
          {#if content.chunks.length === 0}
            <p class="text-[length:var(--text-small)] text-warm-faint">
              No passages found.
            </p>
          {:else}
            {#each content.chunks as chunk (chunk.chunk_index)}
              <div>
                <div
                  class="mb-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted"
                >
                  ¶{chunk.chunk_index}{chunk.heading
                    ? ` · ${chunk.heading}`
                    : ""}
                </div>
                <MarkdownView
                  source={chunk.body}
                  variant="panel"
                  stripBlockRefs
                />
              </div>
            {/each}
          {/if}
        </div>
      {:else if content?.mode === "links"}
        <div class="space-y-5">
          {#each [{ label: "cites →", items: content.links.outgoing }, { label: "cited by ←", items: content.links.incoming }] as group (group.label)}
            <div>
              <div
                class="mb-2 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim uppercase"
              >
                {group.label}
              </div>
              {#if group.items.length === 0}
                <p
                  class="text-[length:var(--text-small)] text-warm-ghost italic"
                >
                  none
                </p>
              {:else}
                <ul class="space-y-1">
                  {#each group.items as item (item.file_path)}
                    <li>
                      <button
                        type="button"
                        onclick={() => onOpenPath(item.file_path)}
                        class="text-left text-[length:var(--text-small)] text-warm-dim transition-colors hover:text-gold"
                      >
                        {item.title}
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-[length:var(--text-small)] text-warm-faint">
          Not found.
        </p>
      {/if}
    </div>
  </div>
</div>
