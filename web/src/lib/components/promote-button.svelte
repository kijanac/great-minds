<script lang="ts">
  import type { SessionId, Uuid } from "@great-minds/domain";
  import BookmarkPlus from "@lucide/svelte/icons/bookmark-plus";

  import { Button } from "#lib/components/ui/button/index.ts";
  import { useExchangePromotion } from "#lib/hooks/use-sessions.svelte.ts";

  let {
    sessionId,
    exchangeId,
    role,
    locked = false,
  }: {
    sessionId: SessionId;
    exchangeId: Uuid;
    role: "owner" | "editor";
    locked?: boolean;
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
    disabled={promotion.pending || locked}
    class="h-auto gap-1.5 px-0 py-1 font-mono disabled:opacity-45 text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:bg-transparent hover:text-gold"
  >
    <BookmarkPlus size={13} />
    {role === "owner"
      ? promotion.pending
        ? "adding…"
        : "add to vault"
      : promotion.pending
        ? "submitting…"
        : "submit for review"}
  </Button>
{/if}
