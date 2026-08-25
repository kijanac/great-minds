<script lang="ts">
  import { Button } from "$lib/components/ui/button";

  let {
    status,
    count,
    onOpen,
  }: {
    status: "loading" | "ready" | "unavailable";
    count: number;
    onOpen: () => void;
  } = $props();

  const issueLabel = $derived(
    count === 1 ? "1 item needs attention" : `${count} items need attention`,
  );
</script>

{#if status === "unavailable"}
  <Button
    variant="ghost"
    size="xs"
    onclick={onOpen}
    title="Health unavailable"
    aria-label="Health unavailable; open health"
    class="h-[18px] min-w-[18px] rounded-full border border-red-400/30 bg-red-400/10 px-1 font-mono text-[10px] leading-none text-red-300 hover:bg-red-400/15 hover:text-red-200"
  >
    ?
  </Button>
{:else if count > 0}
  <Button
    variant="ghost"
    size="xs"
    onclick={onOpen}
    title={issueLabel}
    aria-label={`${issueLabel}; open health`}
    class="h-[18px] min-w-[18px] rounded-full bg-gold/20 px-1 font-mono text-[10px] leading-none text-gold hover:bg-gold/30 hover:text-gold"
  >
    {count}
  </Button>
{/if}
