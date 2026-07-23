<script lang="ts">
  import { goto } from "$app/navigation";
  import Home from "@lucide/svelte/icons/home";

  import ApiKeysSection from "$lib/components/api-keys-section.svelte";
  import PasskeysSection from "$lib/components/passkeys-section.svelte";
  import { Button } from "$lib/components/ui/button";
</script>

<svelte:head>
  <title>Account | Great Minds</title>
</svelte:head>

<div class="flex h-screen flex-col overflow-hidden">
  <div
    class="flex shrink-0 items-center gap-4 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"
  >
    <Button
      variant="ghost"
      size="icon-xs"
      onclick={() => void goto("/")}
      class="text-muted-foreground hover:bg-transparent hover:text-gold"
      aria-label="home"
    >
      <Home size={14} />
    </Button>
    <span
      class="hidden font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase md:inline"
    >
      account
    </span>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
      <PasskeysSection />
      <ApiKeysSection />
    </div>
  </div>
</div>
