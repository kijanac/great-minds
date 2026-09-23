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

  function formatDate(date: Date): string {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
</script>

<Button
  variant="ghost"
  onclick={() => onOpen(session.id)}
  class="group h-auto w-full min-w-0 flex-col items-start justify-start gap-1.5 rounded-sm px-3 py-3 text-left whitespace-normal hover:bg-ink-raised"
>
  <span
    class="w-full font-serif text-[length:var(--text-body)] leading-relaxed text-warm-dim transition-colors [overflow-wrap:anywhere] group-hover:text-warm"
  >
    {session.query}
  </span>
  <span
    class="flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[length:var(--text-chrome)] text-muted-foreground"
  >
    {#if session.origin}
      <span
        class="inline-flex min-w-0 items-baseline gap-1 text-warm-ghost transition-colors [overflow-wrap:anywhere] group-hover:text-warm-faint"
      >
        <CornerUpRight size={10} class="shrink-0 text-gold-muted" />
        from {session.origin_title ??
          (session.origin.kind === "document"
            ? docDisplayName(session.origin.doc_path)
            : "parent session")}
      </span>
    {/if}
    <span class="shrink-0">{formatDate(session.updated_at)}</span>
  </span>
</Button>
