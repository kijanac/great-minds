<script lang="ts">
  import type { WikiArticleOverview } from "$lib/types";
  import { formatShortDate } from "$lib/utils";

  let {
    article,
    onOpen,
  }: {
    article: WikiArticleOverview;
    onOpen: (article: WikiArticleOverview) => void;
  } = $props();
</script>

<button
  type="button"
  onclick={() => onOpen(article)}
  class="group flex w-full items-start justify-between gap-4 rounded-sm px-3 py-3 text-left hover:bg-ink-raised focus-visible:bg-ink-raised focus-visible:outline-none"
>
  <span class="min-w-0 flex-1">
    <span
      class="block truncate font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
    >
      {article.title}
    </span>
    {#if article.precis}
      <span
        class="mt-1 line-clamp-2 block font-serif text-[length:var(--text-small)] text-warm-ghost"
      >
        {article.precis}
      </span>
    {/if}
  </span>
  <span
    class="mt-0.5 shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
  >
    {formatShortDate(article.updated_at)}
  </span>
</button>
