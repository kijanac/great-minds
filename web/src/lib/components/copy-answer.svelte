<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";

  import { answerForClipboard } from "#lib/citations.ts";
  import { Button } from "#lib/components/ui/button/index.ts";

  let { answer }: { answer: string } = $props();

  let copied = $state(false);

  async function copy() {
    await navigator.clipboard.writeText(answerForClipboard(answer, location.origin));
    copied = true;
    window.setTimeout(() => (copied = false), 1500);
  }
</script>

<Button
  variant="ghost"
  size="icon-sm"
  onclick={() => void copy()}
  title={copied ? "Copied" : "Copy answer"}
  aria-label={copied ? "Copied" : "Copy answer"}
  class="shrink-0 text-warm-ghost hover:text-gold"
>
  {#if copied}
    <Check size={14} />
  {:else}
    <Copy size={14} />
  {/if}
</Button>
