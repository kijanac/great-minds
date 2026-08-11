<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { ReferencePromotionAction } from "$lib/types";

  let { action }: { action: ReferencePromotionAction } = $props();
</script>

<div class="flex shrink-0 flex-col items-end gap-1">
  <Button
    variant="outline"
    size="sm"
    onclick={() => void action.onPromote()}
    disabled={action.pending}
    class="h-8 rounded-sm border-gold-dim bg-transparent px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold-muted hover:bg-ink-raised hover:text-gold"
  >
    {action.pending ? "adding…" : `add to ${action.vaultName}`}
  </Button>
  {#if action.error}
    <p
      class="max-w-56 text-right font-mono text-[length:var(--text-chrome)] text-destructive"
    >
      {action.error}
    </p>
  {/if}
</div>
