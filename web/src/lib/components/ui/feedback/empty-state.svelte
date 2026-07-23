<script lang="ts">
  let { message }: { message: string } = $props();
</script>

<div class="flex h-full w-full items-center justify-center py-10 px-4">
  <p class="text-[length:var(--text-body)] text-warm-ghost text-center">
    {message}
  </p>
</div>
