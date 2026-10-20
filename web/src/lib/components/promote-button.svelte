<script lang="ts">
  import type { SessionId, Uuid } from "@great-minds/domain";

  import { Button } from "$lib/components/ui/button";
  import { useExchangePromotion } from "$lib/hooks/use-sessions.svelte";

  let {
    sessionId,
    exchangeId,
    role,
  }: {
    sessionId: SessionId;
    exchangeId: Uuid;
    role: "owner" | "editor";
  } = $props();

  const promotion = useExchangePromotion();
</script>

{#if promotion.result}
  <span
    role="status"
    class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
  >
    {promotion.result.mode === "ingested"
      ? promotion.result.title
        ? `added to vault as “${promotion.result.title}”`
        : "added to vault"
      : "submitted for review"}
  </span>
{:else if promotion.error}
  <span
    role="status"
    class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-destructive"
  >
    {promotion.error}
  </span>
{:else}
  <Button
    variant="ghost"
    size="sm"
    onclick={() => promotion.promote(sessionId, exchangeId)}
    disabled={promotion.pending}
    class="h-auto px-0 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
  >
    {role === "owner"
      ? promotion.pending
        ? "adding…"
        : "add to vault"
      : promotion.pending
        ? "submitting…"
        : "submit for review"}
  </Button>
{/if}
