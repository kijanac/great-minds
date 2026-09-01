<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { WikiArticleOverview } from "@great-minds/domain";
  import { formatShortDate } from "$lib/utils";

  let {
    article,
    onOpen,
  }: {
    article: WikiArticleOverview;
    onOpen: (article: WikiArticleOverview) => void;
  } = $props();
</script>

<Button
  variant="ghost"
  onclick={() => onOpen(article)}
  class="group h-auto w-full justify-between rounded-sm px-3 py-2.5 hover:bg-ink-raised"
>
  <span
    class="truncate text-left font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
  >
    {article.title}
  </span>
  <span
    class="ml-4 shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
  >
    {formatShortDate(article.updated_at)}
  </span>
</Button>
