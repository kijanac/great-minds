<script lang="ts">
  import ListFilter from "@lucide/svelte/icons/list-filter";

  import { Badge } from "$lib/components/ui/badge";

  let {
    summary,
    pending = false,
  }: {
    summary: string;
    pending?: boolean;
  } = $props();
</script>

<Badge
  variant="outline"
  class={`h-auto cursor-default rounded-sm border-ink-border bg-ink-raised px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap text-warm-ghost italic ${
    pending ? "animate-[pulse-fade_1.6s_ease-in-out_infinite]" : ""
  }`}
>
  <ListFilter size={9} class="mr-1.5 opacity-60" />
  {summary}
</Badge>
