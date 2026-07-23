<script lang="ts">
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";

  let {
    message = "Something went wrong.",
    onRetry,
  }: {
    message?: string;
    onRetry?: () => void;
  } = $props();
</script>

<div
  class="flex h-full w-full flex-col items-center justify-center gap-3 py-10 px-4"
>
  <Alert
    variant="destructive"
    class="max-w-sm rounded-sm border-red-400/25 bg-red-400/5"
  >
    <AlertDescription
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-red-400/90 text-center"
    >
      {message}
    </AlertDescription>
  </Alert>
  {#if onRetry}
    <Button
      variant="outline"
      size="sm"
      onclick={onRetry}
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]"
    >
      retry
    </Button>
  {/if}
</div>
