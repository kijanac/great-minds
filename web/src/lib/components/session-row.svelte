<script lang="ts">
  import CornerUpRight from "@lucide/svelte/icons/corner-up-right";

  import { Button } from "$lib/components/ui/button";
  import type { SessionSummary } from "$lib/types";
  import { docDisplayName } from "$lib/utils";

  let {
    session,
    onOpen,
  }: {
    session: SessionSummary;
    onOpen: (id: string) => void;
  } = $props();

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
</script>

<Button
  variant="ghost"
  onclick={() => onOpen(session.id)}
  class="group h-auto w-full flex-col items-start justify-start gap-1.5 rounded-sm px-3 py-3 hover:bg-ink-raised"
>
  <span
    class="w-full truncate text-left font-serif text-[length:var(--text-body)] text-warm-dim italic transition-colors group-hover:text-warm"
  >
    {session.query}
  </span>
  <span
    class="flex items-center gap-3 font-mono text-[length:var(--text-chrome)] text-muted-foreground"
  >
    {#if session.origin?.doc_path}
      <span
        class="inline-flex items-center gap-1 text-warm-ghost transition-colors group-hover:text-warm-faint"
      >
        <CornerUpRight size={10} class="text-gold-muted" />
        from {session.origin_title ?? docDisplayName(session.origin.doc_path)}
      </span>
    {/if}
    {formatDate(session.updated_at)}
  </span>
</Button>
