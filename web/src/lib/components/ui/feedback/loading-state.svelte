<script lang="ts">
  import { Spinner } from "$lib/components/ui/spinner";

  let { label = "Loading…" }: { label?: string } = $props();
</script>

<div
  class="flex h-full w-full flex-col items-center justify-center gap-2 py-10"
>
  <Spinner />
  <p
    class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
  >
    {label}
  </p>
</div>
