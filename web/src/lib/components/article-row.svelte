<script lang="ts">
  import type { WikiArticleOverview } from "#lib/types.ts";

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
  class="group block w-full rounded-sm px-3 py-3 text-left hover:bg-ink-raised focus-visible:bg-ink-raised focus-visible:outline-none"
>
  <span class="block min-w-0">
    <span
      class="block font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm [overflow-wrap:anywhere]"
    >
      {article.title}
    </span>
    {#if article.precis}
      <span class="mt-1 line-clamp-2 font-serif text-[length:var(--text-small)] text-warm-ghost">
        {article.precis}
      </span>
    {/if}
  </span>
</button>
